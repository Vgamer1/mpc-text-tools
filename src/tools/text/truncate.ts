import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { estimateTokenCount } from "tokenx";
import { successResponse, errorResponse } from "../../lib/responses.js";
import { registerToolWithLimits } from "../../lib/register.js";
import type { Bindings } from "../../types.js";

// ─────────────────────────────────────────────
// text_truncate — trim to a token budget on word boundaries.
//
// Uses binary search on the word array for O(n log n) total work.
// ─────────────────────────────────────────────

const schema = {
  text:       z.string().max(1_000_000).describe("Text to truncate"),
  max_tokens: z.number().int().min(1).max(200_000).describe("Maximum number of tokens to allow"),
  from:       z.enum(["start", "end"]).optional().describe("Which end to truncate from: 'end' removes from the tail and keeps the beginning (default), 'start' removes from the head and keeps the end"),
};

type Args = {
  text: string;
  max_tokens: number;
  from?: "start" | "end";
};

export function register(server: McpServer, env: Bindings) {
  registerToolWithLimits<Args>(
    server,
    env,
    "text_truncate",
    "Trim text to fit within a token budget without cutting mid-word. Useful for fitting content into LLM context windows, prompt slots, or any size-constrained input. Returns the truncated text and its actual token count.",
    schema,
    async ({ text, max_tokens, from = "end" }) => {
      try {
        const total = estimateTokenCount(text);

        // Already within budget — no work needed
        if (total <= max_tokens) {
          return successResponse({ truncated: false, token_count: total, text });
        }

        // Split on whitespace runs, keeping them as separate elements. This lets
        // us reassemble the exact original string for any prefix/suffix length.
        const words = text.split(/(\s+)/);

        // Binary search for the largest k such that the chosen k-element slice
        // (prefix for "from=end", suffix for "from=start") fits in max_tokens.
        let lo = 0;
        let hi = words.length;
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          const slice = from === "end"
            ? words.slice(0, mid)
            : words.slice(words.length - mid);
          if (estimateTokenCount(slice.join("")) <= max_tokens) {
            lo = mid;
          } else {
            hi = mid - 1;
          }
        }

        // Assemble, trim, and re-count AFTER trimming so the reported token
        // count matches the returned string exactly.
        const finalSlice = from === "end"
          ? words.slice(0, lo)
          : words.slice(words.length - lo);
        const resultText = finalSlice.join("").trim();
        const resultTokens = estimateTokenCount(resultText);

        return successResponse({
          truncated: true,
          original_token_count: total,
          token_count: resultTokens,
          removed_from: from,
          text: resultText,
        });
      } catch (err: any) {
        return errorResponse(err.message);
      }
    }
  );
}
