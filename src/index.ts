// MCP server SDK — provides McpServer class for registering tools and handling protocol
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// HTTP transport for stateless Cloudflare Worker deployment (one request = one connection)
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
// createTwoFilesPatch generates unified diffs; parsePatch parses them into structured hunks
import { createTwoFilesPatch, parsePatch } from "diff";
// tokenx provides fast (~96% accurate) token estimation without a full tokenizer
import { estimateTokenCount, splitByTokens } from "tokenx";
// Zod for runtime input validation — the MCP SDK uses it for tool parameter schemas
import { z } from "zod";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

// Cloudflare Worker environment bindings — RATE_LIMIT is a KV namespace
// created via `wrangler kv namespace create RATE_LIMIT` and bound in wrangler.toml
interface Env {
  RATE_LIMIT: KVNamespace;
}

// ─────────────────────────────────────────────
// Constraints — upper bounds on all inputs to
// prevent memory abuse and undefined behavior
// ─────────────────────────────────────────────

const MAX_TEXT_LENGTH = 1_000_000; // Cap text inputs at ~1 MB
const MAX_LABEL_LENGTH = 200;      // Diff header labels don't need to be long
const MIN_TOKENS_PER_CHUNK = 1;    // At least 1 token per chunk
const MAX_TOKENS_PER_CHUNK = 10_000; // Upper bound to prevent excessive memory use
const MAX_OVERLAP = 5_000;         // Overlap must also stay bounded

// ─────────────────────────────────────────────
// Rate limiting — per tool, per IP, fixed window
//
// Uses Cloudflare KV to track request counts.
// Each tool gets its own requests-per-minute cap.
// Keys follow the pattern rl:{tool}:{ip}:{minute}
// and self-expire via TTL so no cleanup is needed.
// ─────────────────────────────────────────────

// How wide each rate limit window is, in seconds
const RATE_WINDOW_SECONDS = 60;

// Max requests per window, per tool. Add new tools here as they're created.
// When Stripe is added later, paid users can get higher limits per tool.
const RATE_LIMITS: Record<string, number> = {
  diff_text: 60,
  chunk_text: 60,
};

// Return type for the rate limit check
interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

/**
 * Check and increment the rate limit counter for a given IP + tool.
 * Returns whether the request is allowed and how many calls remain.
 *
 * KV is eventually consistent, so under extreme concurrency a few
 * extra requests may slip through before the count propagates.
 * This is an acceptable tradeoff for the simplicity and low cost.
 */
async function checkRateLimit(
  kv: KVNamespace,
  ip: string,
  tool: string,
): Promise<RateLimitResult> {
  // Look up the per-tool limit (defaults to 60 if tool not in map)
  const limit = RATE_LIMITS[tool] ?? 60;

  // Compute which minute bucket we're in (integer that changes every 60s)
  const bucket = Math.floor(Date.now() / (RATE_WINDOW_SECONDS * 1000));

  // Build the KV key: tool + IP + time bucket = unique counter per window
  const key = `rl:${tool}:${ip}:${bucket}`;

  // Read current count from KV (null if first request in this window)
  const raw = await kv.get(key);
  const current = raw ? parseInt(raw, 10) : 0;

  // If at or over the limit, deny the request
  if (current >= limit) {
    return { allowed: false, remaining: 0, limit };
  }

  // Increment the counter and write back with a TTL of 2x the window
  // so the key expires even if no more requests come in
  await kv.put(key, String(current + 1), {
    expirationTtl: RATE_WINDOW_SECONDS * 2,
  });

  return { allowed: true, remaining: limit - current - 1, limit };
}

// ─────────────────────────────────────────────
// Tool definitions — separated from server
// instantiation so tool logic is in one place
// and createServer() stays a thin wrapper.
// ─────────────────────────────────────────────

function registerTools(server: McpServer): void {

  // ── diff_text tool ─────────────────────────
  // Compares two strings and returns a unified diff patch
  // plus accurate added/removed line counts.
  server.tool(
    "diff_text",
    "Compare two strings and return a unified diff patch with added/removed line counts. "
    + "Useful for change detection, patch generation, or summarizing edits.",
    {
      // Input schema — all strings bounded to prevent oversized payloads
      a: z.string().max(MAX_TEXT_LENGTH).describe("Original text"),
      b: z.string().max(MAX_TEXT_LENGTH).describe("New text"),
      label_a: z
        .string()
        .max(MAX_LABEL_LENGTH)
        .optional()
        .describe("Label for original in the patch header (default: 'a')"),
      label_b: z
        .string()
        .max(MAX_LABEL_LENGTH)
        .optional()
        .describe("Label for new in the patch header (default: 'b')"),
    },
    async ({ a, b, label_a, label_b }) => {
      try {
        // Generate the unified diff patch between the two inputs.
        // Inputs are passed through unmodified — no forced trailing newlines —
        // so the diff accurately reflects the original content.
        const patch = createTwoFilesPatch(
          label_a ?? "a",
          label_b ?? "b",
          a,
          b,
        );

        // Count added/removed lines using the structured parser rather than
        // string heuristics (startsWith("+")). The parser correctly handles
        // hunk headers, binary patches, and other edge cases in unified diffs.
        const parsed = parsePatch(patch);
        let added = 0;
        let removed = 0;
        for (const file of parsed) {
          for (const hunk of file.hunks) {
            for (const line of hunk.lines) {
              if (line.startsWith("+")) added++;
              if (line.startsWith("-")) removed++;
            }
          }
        }

        // Return the patch string and counts as JSON inside MCP text content.
        // MCP spec only supports "text", "image", and "resource" content types,
        // so structured data is returned as a JSON string — this is standard.
        return {
          content: [
            { type: "text", text: JSON.stringify({ patch, added, removed }) },
          ],
        };
      } catch (err: unknown) {
        // Return a clean MCP error instead of letting exceptions bubble
        // up as raw 500s. isError: true tells the agent the tool failed.
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  // ── chunk_text tool ────────────────────────
  // Splits text into token-sized chunks for RAG pipelines,
  // batch processing, or context window management.
  server.tool(
    "chunk_text",
    "Split text into token-sized chunks with optional overlap between consecutive chunks. "
    + "Returns each chunk with its index and estimated token count. "
    + "Note: token counts are estimates (~96% accuracy vs tiktoken) — "
    + "suitable for most RAG and batching workflows but not exact.",
    {
      // Input schema — numbers are integers with min/max bounds to prevent
      // negative values, zero-size chunks, or unreasonably large allocations
      text: z.string().max(MAX_TEXT_LENGTH).describe("Text to split"),
      tokens_per_chunk: z
        .number()
        .int()
        .min(MIN_TOKENS_PER_CHUNK)
        .max(MAX_TOKENS_PER_CHUNK)
        .optional()
        .describe("Max tokens per chunk (default: 500)"),
      overlap: z
        .number()
        .int()
        .min(0)
        .max(MAX_OVERLAP)
        .optional()
        .describe("Token overlap between consecutive chunks (default: 0)"),
    },
    async ({ text, tokens_per_chunk, overlap }) => {
      try {
        // Apply defaults for optional parameters
        const size = tokens_per_chunk ?? 500;
        const ovlp = overlap ?? 0;

        // Guard: overlap must be strictly less than chunk size, otherwise
        // the chunker could loop infinitely or produce duplicate content
        if (ovlp >= size) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `overlap (${ovlp}) must be smaller than tokens_per_chunk (${size})`,
                }),
              },
            ],
          };
        }

        // Split the text into chunks using tokenx's estimated token boundaries
        const chunks = splitByTokens(text, size, { overlap: ovlp });

        // Build the response with per-chunk metadata.
        // estimateTokenCount uses the same algorithm as splitByTokens
        // so the counts are internally consistent.
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                chunk_count: chunks.length,
                tokens_per_chunk: size,
                overlap: ovlp,
                chunks: chunks.map((t, i) => ({
                  index: i,
                  token_count: estimateTokenCount(t),
                  text: t,
                })),
              }),
            },
          ],
        };
      } catch (err: unknown) {
        // Catch any unexpected errors from tokenx and return cleanly
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );
}

// ─────────────────────────────────────────────
// Server factory
//
// Creates a fresh McpServer and registers all tools.
// A new instance is needed per request because .connect()
// binds a server to a specific transport — once bound,
// it can't be reused for a different request. This is
// the correct pattern for stateless Cloudflare Workers.
// The overhead is sub-millisecond (just two tool registrations).
// ─────────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({ name: "mcp-text-tools", version: "1.0.0" });
  registerTools(server);
  return server;
}

// ─────────────────────────────────────────────
// Cloudflare Worker fetch handler
//
// Routes incoming requests to the appropriate handler:
// health check, OAuth discovery stubs, or the MCP endpoint.
// Rate limiting is enforced at the HTTP layer before the
// request reaches the MCP transport.
// ─────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── Health check endpoint ──────────────────
    // Returns 200 with version info. Used by uptime monitors.
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", version: "1.0.0" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // ── OAuth discovery stubs ──────────────────
    // Claude.ai probes these endpoints during MCP handshake
    // even when no auth is configured. Returning the expected
    // shapes prevents handshake failures.
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      // Tell Claude this resource exists but has no auth servers
      return new Response(
        JSON.stringify({
          resource: url.origin,
          authorization_servers: [],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // No authorization server configured — return 404 as expected
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return new Response(null, { status: 404 });
    }

    // No dynamic client registration — return 404 as expected
    if (url.pathname === "/register" && request.method === "POST") {
      return new Response(null, { status: 404 });
    }

    // ── MCP endpoint ───────────────────────────
    // All MCP traffic (tool listing, tool calls, initialization)
    // comes through / or /mcp. Claude.ai may hit either path.
    if (url.pathname === "/mcp" || url.pathname === "/") {

      // Handle CORS preflight so browser-based agents can connect
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers":
              "Content-Type, Accept, Mcp-Session-Id",
          },
        });
      }

      // ── Rate limiting ────────────────────────
      // Read the request body to inspect the JSON-RPC method.
      // Only tool calls (method: "tools/call") are metered;
      // other MCP messages like "initialize" and "tools/list"
      // pass through freely.
      const bodyText = await request.text();
      let parsedBody: Record<string, unknown> | null = null;

      // Attempt to parse the body as JSON. If it fails,
      // skip rate limiting and let the MCP transport
      // return its own error for malformed input.
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        // Not valid JSON — fall through to MCP transport
      }

      // Check if this is a tool call and extract the tool name
      if (
        parsedBody &&
        parsedBody.method === "tools/call" &&
        typeof (parsedBody.params as Record<string, unknown>)?.name === "string"
      ) {
        const toolName = (parsedBody.params as Record<string, unknown>)
          .name as string;

        // Only enforce limits for tools that have an entry in RATE_LIMITS
        if (RATE_LIMITS[toolName]) {
          // Identify the caller by IP. cf-connecting-ip is set by Cloudflare;
          // x-forwarded-for is the fallback for local dev or proxied requests.
          const ip =
            request.headers.get("cf-connecting-ip") ??
            request.headers.get("x-forwarded-for") ??
            "unknown";

          const result = await checkRateLimit(env.RATE_LIMIT, ip, toolName);

          // If over the limit, return a JSON-RPC error with HTTP 429.
          // Includes Retry-After and X-RateLimit headers so the calling
          // agent knows when to try again and what the limits are.
          if (!result.allowed) {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32000,
                  message:
                    `Rate limit exceeded for ${toolName}. ` +
                    `Limit: ${result.limit} requests per minute. ` +
                    `Try again shortly.`,
                },
                id:
                  (parsedBody as Record<string, unknown>).id ?? null,
              }),
              {
                status: 429,
                headers: {
                  "Content-Type": "application/json",
                  "Retry-After": String(RATE_WINDOW_SECONDS),
                  "X-RateLimit-Limit": String(result.limit),
                  "X-RateLimit-Remaining": "0",
                  "Access-Control-Allow-Origin": "*",
                },
              },
            );
          }
        }
      }

      // Reconstruct the Request since we consumed the body stream above.
      // The MCP transport needs a fresh readable body to process.
      const mcpRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: bodyText,
      });

      // Create a fresh server + transport pair and hand off the request.
      // The transport handles JSON-RPC parsing, tool dispatch, and response streaming.
      const server = createServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode — no session tracking
      });

      await server.connect(transport);
      return transport.handleRequest(mcpRequest);
    }

    // ── Catch-all ──────────────────────────────
    // Any path not matched above gets a 404
    return new Response("Not found", { status: 404 });
  },
};