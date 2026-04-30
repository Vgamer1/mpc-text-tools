import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { estimateTokenCount, splitByTokens } from "tokenx";
import { successResponse, errorResponse } from "../../lib/responses.js";
import { registerToolWithLimits } from "../../lib/register.js";
import type { Bindings } from "../../types.js";

// ─────────────────────────────────────────────
// text_chunk — token-sized chunks with optional overlap.
// ─────────────────────────────────────────────

const schema = {
  text:             z.string().max(1_000_000).describe("Text to split"),
  tokens_per_chunk: z.number().int().min(1).max(10000).optional().describe("Max tokens per chunk (default: 500)"),
  overlap:          z.number().int().min(0).max(5000).optional().describe("Token overlap between consecutive chunks (default: 0)"),
};

type Args = {
  text: string;
  tokens_per_chunk?: number;
  overlap?: number;
};

export function register(server: McpServer, env: Bindings) {
  registerToolWithLimits<Args>(
    server,
    env,
    "text_chunk",
    "Split text into token-sized chunks with optional overlap between consecutive chunks. Returns each chunk with its index and estimated token count. Note: token counts are estimates (~96% accuracy vs tiktoken) — suitable for most RAG and batching workflows but not exact.",
    schema,
    async ({ text, tokens_per_chunk, overlap }) => {
      try {
        const size = tokens_per_chunk ?? 500;
        const ovlp = overlap ?? 0;

        // Overlap ≥ size produces undefined splitting behavior — reject explicitly
        // rather than pass through to the library and get a confusing error.
        if (ovlp >= size) {
          return errorResponse(
            `overlap (${ovlp}) must be smaller than tokens_per_chunk (${size})`
          );
        }

        // splitByTokens returns only the chunk text; we re-measure each chunk's
        // token count for reporting. If tokenx ever exposes chunk metadata,
        // this second pass can be removed.
        const chunks = splitByTokens(text, size, { overlap: ovlp });
        return successResponse({
          chunk_count: chunks.length,
          tokens_per_chunk: size,
          overlap: ovlp,
          chunks: chunks.map((t, i) => ({
            index: i,
            token_count: estimateTokenCount(t),
            text: t,
          })),
        });
      } catch (err: any) {
        return errorResponse(err.message);
      }
    }
  );
}
