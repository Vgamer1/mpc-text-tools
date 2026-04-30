import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../../lib/responses.js";
import { registerToolWithLimits } from "../../lib/register.js";
import type { Bindings } from "../../types.js";

// ─────────────────────────────────────────────
// text_extract_json — extract JSON from messy/mixed text.
//
// Algorithm is bounded O(n) in total work:
//   1. Scan for up to 10 markdown code fences
//   2. Try the whole trimmed text (catches scalars and clean JSON)
//   3. Single-pass scan for top-level {…} and […] regions, respecting
//      string escapes and nesting
// Each candidate gets one JSON.parse attempt. The earlier O(n³) "try
// every slice from every open-bracket" approach is gone.
// ─────────────────────────────────────────────

/**
 * Single-pass scan returning all top-level bracket-balanced regions in `text`.
 * Respects JSON string syntax (ignores brackets inside "…" with \-escapes).
 * Unclosed regions are dropped. Mismatched openers (e.g. `{`…`]`) produce a
 * region whose parse will fail — acceptable, we just move on.
 */
function findTopLevelBracketRegions(
  text: string,
  filter: "object" | "array" | "both"
): string[] {
  const regions: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let regionStart = -1;
  let regionType: "{" | "[" | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }

    if (ch === "{" || ch === "[") {
      if (depth === 0) {
        regionStart = i;
        regionType = ch as "{" | "[";
      }
      depth++;
    } else if (ch === "}" || ch === "]") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && regionStart >= 0 && regionType) {
          const include =
            filter === "both" ||
            (filter === "object" && regionType === "{") ||
            (filter === "array" && regionType === "[");
          if (include) regions.push(text.slice(regionStart, i + 1));
          regionStart = -1;
          regionType = null;
        }
      }
    }
  }

  return regions;
}

const schema = {
  text:   z.string().max(1_000_000).describe("Text containing JSON somewhere inside it"),
  expect: z.enum(["object", "array", "any"]).optional().describe("Expected root type: 'object', 'array', or 'any' (default: 'any')"),
};

type Args = {
  text: string;
  expect?: "object" | "array" | "any";
};

export function register(server: McpServer, env: Bindings) {
  registerToolWithLimits<Args>(
    server,
    env,
    "text_extract_json",
    "Extract a JSON object or array from messy or mixed text — such as LLM output that wraps JSON in markdown fences, prose, or extra commentary. Returns the first valid JSON value found. Scalars (strings, numbers, booleans, null) are only returned when the entire input parses as a single scalar.",
    schema,
    async ({ text, expect = "any" }) => {
      try {
        const candidates: string[] = [];

        // 1. Every markdown code fence, up to a safety cap
        const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)```/g;
        let fenceMatch: RegExpExecArray | null;
        let fenceCount = 0;
        while ((fenceMatch = fenceRegex.exec(text)) !== null && fenceCount < 10) {
          candidates.push(fenceMatch[1].trim());
          fenceCount++;
        }

        // 2. The whole trimmed text — catches scalars and clean un-fenced JSON
        candidates.push(text.trim());

        // 3. All top-level bracket-balanced regions, filtered by expected type
        const filter =
          expect === "object" ? "object" :
          expect === "array"  ? "array"  : "both";
        const regions = findTopLevelBracketRegions(text, filter);
        candidates.push(...regions);

        // Try each candidate in order; return on first valid parse matching `expect`.
        for (const candidate of candidates) {
          if (!candidate) continue;
          try {
            const parsed = JSON.parse(candidate);
            const type = Array.isArray(parsed)
              ? "array"
              : parsed === null
                ? "null"
                : typeof parsed;

            if (expect === "object" && type !== "object") continue;
            if (expect === "array"  && type !== "array")  continue;

            return successResponse({ found: true, type, value: parsed });
          } catch {
            // Not valid JSON; try next candidate
          }
        }

        return successResponse({ found: false, error: "No valid JSON found in input" });
      } catch (err: any) {
        return errorResponse(err.message);
      }
    }
  );
}
