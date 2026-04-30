import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createTwoFilesPatch, parsePatch } from "diff";
import { successResponse, errorResponse } from "../../lib/responses.js";
import { registerToolWithLimits } from "../../lib/register.js";
import type { Bindings } from "../../types.js";

// ─────────────────────────────────────────────
// text_diff — unified diff with added/removed line counts.
// ─────────────────────────────────────────────

const schema = {
  a:       z.string().max(1_000_000).describe("Original text"),
  b:       z.string().max(1_000_000).describe("New text"),
  label_a: z.string().max(200).optional().describe("Label for original in the patch header (default: 'a')"),
  label_b: z.string().max(200).optional().describe("Label for new in the patch header (default: 'b')"),
};

type Args = {
  a: string;
  b: string;
  label_a?: string;
  label_b?: string;
};

export function register(server: McpServer, env: Bindings) {
  registerToolWithLimits<Args>(
    server,
    env,
    "text_diff",
    "Compare two strings and return a unified diff patch with added/removed line counts. Useful for change detection, patch generation, or summarizing edits. If either input lacks a trailing newline, one is added for well-formed diff output; the response flags this via `trailing_newline_added`.",
    schema,
    async ({ a, b, label_a, label_b }) => {
      try {
        // The `diff` library requires trailing newlines to produce clean output.
        // Track whether we normalized so callers can distinguish "foo" vs "foo\n"
        // if that matters to them.
        const a_added = !a.endsWith("\n");
        const b_added = !b.endsWith("\n");
        const pa = a_added ? a + "\n" : a;
        const pb = b_added ? b + "\n" : b;

        const patch = createTwoFilesPatch(label_a ?? "a", label_b ?? "b", pa, pb);
        const parsed = parsePatch(patch);

        // Count added/removed lines from structured hunk data, not string heuristics,
        // so header lines ("+++", "---") don't get miscounted.
        let added = 0, removed = 0;
        for (const file of parsed) {
          for (const hunk of file.hunks) {
            for (const line of hunk.lines) {
              if (line.startsWith("+")) added++;
              if (line.startsWith("-")) removed++;
            }
          }
        }

        return successResponse({
          patch,
          added,
          removed,
          trailing_newline_added: a_added || b_added,
        });
      } catch (err: any) {
        return errorResponse(err.message);
      }
    }
  );
}
