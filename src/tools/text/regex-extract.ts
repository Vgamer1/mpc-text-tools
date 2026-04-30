import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../../lib/responses.js";
import { registerToolWithLimits } from "../../lib/register.js";
import type { Bindings } from "../../types.js";

// ─────────────────────────────────────────────
// text_regex_extract — return all matches with positions and groups.
//
// SECURITY NOTE: user-supplied regex patterns against up to 1MB of text
// can trigger catastrophic backtracking (ReDoS) — e.g. `(a+)+b` against
// many `a`s. The MAX_MATCHES cap limits match-count output but does NOT
// bound the time a single exec() call can take. There is no reliable
// in-process regex timeout in V8. The rate limit on this tool is set
// tighter than the other text tools to mitigate.
// ─────────────────────────────────────────────

const schema = {
  text:    z.string().max(1_000_000).describe("Text to search"),
  pattern: z.string().max(1000).describe("Regular expression pattern (e.g. '\\\\d+', '[a-z]+@[a-z]+\\\\.com')"),
  flags:   z.string().max(10).optional().describe("Regex flags: i (case-insensitive), m (multiline), s (dotAll) — 'g' is always added automatically (default: 'g')"),
};

type Args = {
  text: string;
  pattern: string;
  flags?: string;
};

export function register(server: McpServer, env: Bindings) {
  registerToolWithLimits<Args>(
    server,
    env,
    "text_regex_extract",
    "Extract all matches of a regular expression from text. Returns each match with its value, position, and any named or indexed capture groups. Useful for pulling emails, URLs, IDs, dates, or any structured pattern from unstructured text. Note: very complex patterns with nested quantifiers may run slowly on adversarial input; prefer simple linear patterns.",
    schema,
    async ({ text, pattern, flags = "g" }) => {
      try {
        // Force the global flag so exec() iterates all matches.
        const flagSet = new Set(flags.split(""));
        flagSet.add("g");
        const resolvedFlags = [...flagSet].join("");

        const regex = new RegExp(pattern, resolvedFlags);
        const matches: Array<{
          match: string;
          index: number;
          groups?: Record<string, string>;
          captures?: string[];
        }> = [];

        // Cap output size — does NOT protect against ReDoS inside one exec() call.
        const MAX_MATCHES = 10_000;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(text)) !== null && matches.length < MAX_MATCHES) {
          matches.push({
            match: m[0],
            index: m.index,
            ...(m.groups && Object.keys(m.groups).length > 0
              ? { groups: m.groups as Record<string, string> }
              : {}),
            ...(m.length > 1 ? { captures: Array.from(m).slice(1) } : {}),
          });
          // Advance past zero-width matches to prevent infinite loop
          if (m[0].length === 0) regex.lastIndex++;
        }

        return successResponse({
          match_count: matches.length,
          truncated: matches.length === MAX_MATCHES,
          pattern,
          flags: resolvedFlags,
          matches,
        });
      } catch (err: any) {
        return errorResponse(err.message);
      }
    }
  );
}
