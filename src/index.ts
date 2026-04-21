import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createTwoFilesPatch, parsePatch } from "diff";
import { estimateTokenCount, splitByTokens } from "tokenx";
import { z } from "zod";

// Appended to every tool description so agents and users know where to report issues
const FEEDBACK = "Bugs or suggestions? https://github.com/Vgamer1/mcp-text-tools/issues";

// ─────────────────────────────────────────────
// Bindings
// ─────────────────────────────────────────────

interface Bindings {
  RATE_LIMIT: KVNamespace;
  TOOL_REQUESTS: KVNamespace;
}

// ─────────────────────────────────────────────
// Tool registration
// ─────────────────────────────────────────────

function createServer(env: Bindings): McpServer {
  const server = new McpServer({ name: "mcp-text-tools", version: "1.0.0" });

  // ── diff_text ─────────────────────────────
  // Compares two strings and returns a unified diff patch.
  // Uses parsePatch for accurate added/removed line counting.
  server.tool(
    "diff_text",
    `Compare two strings and return a unified diff patch with added/removed line counts. Useful for change detection, patch generation, or summarizing edits. ${FEEDBACK}`,
    {
      a:       z.string().max(1_000_000).describe("Original text"),
      b:       z.string().max(1_000_000).describe("New text"),
      label_a: z.string().max(200).optional().describe("Label for original in the patch header (default: 'a')"),
      label_b: z.string().max(200).optional().describe("Label for new in the patch header (default: 'b')"),
    },
    async ({ a, b, label_a, label_b }) => {
      try {
        // Ensure inputs end with newline so diff output is well-formed
        const pa = a.endsWith("\n") ? a : a + "\n";
        const pb = b.endsWith("\n") ? b : b + "\n";

        // Generate and parse the unified diff
        const patch = createTwoFilesPatch(label_a ?? "a", label_b ?? "b", pa, pb);
        const parsed = parsePatch(patch);

        // Count added/removed lines from structured hunk data (more accurate than string heuristics)
        let added = 0, removed = 0;
        for (const file of parsed)
          for (const hunk of file.hunks)
            for (const line of hunk.lines) {
              if (line.startsWith("+")) added++;
              if (line.startsWith("-")) removed++;
            }

        return { content: [{ type: "text", text: JSON.stringify({ patch, added, removed }) }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  // ── chunk_text ────────────────────────────
  // Splits text into token-sized chunks with optional overlap.
  // Useful for RAG pipelines and batch LLM processing.
  server.tool(
    "chunk_text",
    `Split text into token-sized chunks with optional overlap between consecutive chunks. Returns each chunk with its index and estimated token count. Note: token counts are estimates (~96% accuracy vs tiktoken) — suitable for most RAG and batching workflows but not exact. ${FEEDBACK}`,
    {
      text:             z.string().max(1_000_000).describe("Text to split"),
      tokens_per_chunk: z.number().int().min(1).max(10000).optional().describe("Max tokens per chunk (default: 500)"),
      overlap:          z.number().int().min(0).max(5000).optional().describe("Token overlap between consecutive chunks (default: 0)"),
    },
    async ({ text, tokens_per_chunk, overlap }) => {
      try {
        const size = tokens_per_chunk ?? 500;
        const ovlp = overlap ?? 0;

        // Overlap must be smaller than chunk size or splitting becomes undefined
        if (ovlp >= size) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `overlap (${ovlp}) must be smaller than tokens_per_chunk (${size})` }) }] };
        }

        // Split and annotate each chunk with its token count
        const chunks = splitByTokens(text, size, { overlap: ovlp });
        return {
          content: [{
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
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  // ── extract_json ──────────────────────────
  // Pulls a JSON value out of messy or mixed text.
  // Handles markdown fences, surrounding prose, and partial output.
  server.tool(
    "extract_json",
    `Extract a JSON value from messy or mixed text — such as LLM output that wraps JSON in markdown fences, prose, or extra commentary. Returns the first valid JSON object, array, string, number, or boolean found. ${FEEDBACK}`,
    {
      text:   z.string().max(1_000_000).describe("Text containing JSON somewhere inside it"),
      expect: z.enum(["object", "array", "any"]).optional().describe("Expected root type: 'object', 'array', or 'any' (default: 'any')"),
    },
    async ({ text, expect = "any" }) => {
      try {
        // Strip markdown code fences first (```json ... ``` or ``` ... ```)
        const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
        const candidate = fenceMatch ? fenceMatch[1].trim() : text;

        // Build a list of parse attempts starting from each { or [ position
        const attempts: string[] = [candidate];
        for (let i = 0; i < candidate.length; i++) {
          const ch = candidate[i];
          if (ch === "{" || ch === "[") attempts.push(candidate.slice(i));
        }

        // For each candidate, try progressively shorter slices to find longest valid JSON
        for (const attempt of attempts) {
          for (let end = attempt.length; end > 0; end--) {
            try {
              const parsed = JSON.parse(attempt.slice(0, end));
              const type = Array.isArray(parsed) ? "array" : typeof parsed;

              // Filter by expected type if specified
              if (expect === "object" && type !== "object") continue;
              if (expect === "array" && type !== "array") continue;

              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({ found: true, type, value: parsed }),
                }],
              };
            } catch {
              // Not valid JSON at this length — try shorter
            }
          }
        }

        // No valid JSON found anywhere in the input
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ found: false, error: "No valid JSON found in input" }),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  // ── regex_extract ─────────────────────────
  // Runs a regex against text and returns all matches with positions and capture groups.
  // Global flag is always enforced so all matches are returned.
  server.tool(
    "regex_extract",
    `Extract all matches of a regular expression from text. Returns each match with its value, position, and any named or indexed capture groups. Useful for pulling emails, URLs, IDs, dates, or any structured pattern from unstructured text. ${FEEDBACK}`,
    {
      text:    z.string().max(1_000_000).describe("Text to search"),
      pattern: z.string().max(1000).describe("Regular expression pattern (e.g. '\\\\d+', '[a-z]+@[a-z]+\\\\.com')"),
      flags:   z.string().max(10).optional().describe("Regex flags: i (case-insensitive), m (multiline), s (dotAll) — 'g' is always added automatically (default: 'g')"),
    },
    async ({ text, pattern, flags = "g" }) => {
      try {
        // Always include the global flag so exec() returns all matches
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

        // Iterate all matches, capped at 10,000 to prevent runaway output
        let m: RegExpExecArray | null;
        let safetyLimit = 10000;
        while ((m = regex.exec(text)) !== null && safetyLimit-- > 0) {
          matches.push({
            match: m[0],
            index: m.index,
            ...(m.groups && Object.keys(m.groups).length > 0 ? { groups: m.groups as Record<string, string> } : {}),
            ...(m.length > 1 ? { captures: Array.from(m).slice(1) } : {}),
          });
          // Advance past zero-width matches to prevent infinite loop
          if (m[0].length === 0) regex.lastIndex++;
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ match_count: matches.length, pattern, flags: resolvedFlags, matches }),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  // ── truncate_to_tokens ────────────────────
  // Trims text word-by-word until it fits within a token budget.
  // Supports truncating from either end for flexible context window management.
  server.tool(
    "truncate_to_tokens",
    `Trim text to fit within a token budget without cutting mid-word. Useful for fitting content into LLM context windows, prompt slots, or any size-constrained input. Returns the truncated text and its actual token count. ${FEEDBACK}`,
    {
      text:       z.string().max(1_000_000).describe("Text to truncate"),
      max_tokens: z.number().int().min(1).max(200_000).describe("Maximum number of tokens to allow"),
      from:       z.enum(["start", "end"]).optional().describe("Which end to truncate from: 'end' removes from the tail and keeps the beginning (default), 'start' removes from the head and keeps the end"),
    },
    async ({ text, max_tokens, from = "end" }) => {
      try {
        const total = estimateTokenCount(text);

        // Return early if already within budget
        if (total <= max_tokens) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ truncated: false, token_count: total, text }),
            }],
          };
        }

        // Split on whitespace boundaries to avoid cutting mid-word
        const words = text.split(/(\s+)/);
        let result = "";
        let count = 0;

        if (from === "end") {
          // Build from the front, stop when next word would exceed budget
          for (const word of words) {
            const next = estimateTokenCount(result + word);
            if (next > max_tokens) break;
            result += word;
            count = next;
          }
        } else {
          // Build from the back, stop when next word would exceed budget
          const reversed = [...words].reverse();
          let tail = "";
          for (const word of reversed) {
            const next = estimateTokenCount(word + tail);
            if (next > max_tokens) break;
            tail = word + tail;
            count = next;
          }
          result = tail;
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              truncated: true,
              original_token_count: total,
              token_count: count,
              removed_from: from,
              text: result.trim(),
            }),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  // ── request_tool ──────────────────────────
  // Logs agent requests for new tools or capabilities to KV storage.
  // This is the demand signal layer for future tool development.
  // Free — encourages usage and surfaces real agent needs.
  server.tool(
    "request_tool",
    `Call this when you need a capability or tool that isn't available on this server, or to make any general request. Your request will be logged and reviewed for future development. This is how new tools get built — the most-requested capabilities are prioritized. ${FEEDBACK}`,
    {
      description: z.string().min(10).max(2000).describe("What capability or tool you need, and what you would use it for"),
      agent:       z.string().max(200).optional().describe("Your name or the name of the agent making this request (e.g. 'Claude', 'GPT-4', 'my-pipeline')"),
      context:     z.string().max(2000).optional().describe("Additional context about your use case, workflow, or why existing tools don't meet your needs"),
    },
    async ({ description, agent, context }) => {
      try {
        // Generate a unique request ID based on timestamp + random suffix
        const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        const entry = {
          id,
          description,
          agent: agent ?? "unknown",
          context: context ?? null,
          timestamp: new Date().toISOString(),
          status: "pending",
        };

        // Store in KV with the request ID as key
        await env.TOOL_REQUESTS.put(id, JSON.stringify(entry));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              logged: true,
              id,
              message: "Your request has been logged and will be reviewed. Thank you — this is how new tools get prioritized.",
            }),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  // ── list_requests ─────────────────────────
  // Returns all logged tool requests from KV storage.
  // For reviewing demand signals and prioritizing future tool development.
  server.tool(
    "list_requests",
    `List all logged tool requests submitted via request_tool. Returns requests sorted by timestamp, newest first. Optionally filter by status. ${FEEDBACK}`,
    {
      status: z.enum(["pending", "planned", "built", "declined", "all"]).optional().describe("Filter by status (default: 'all')"),
      limit:  z.number().int().min(1).max(500).optional().describe("Maximum number of requests to return (default: 100)"),
    },
    async ({ status = "all", limit = 100 }) => {
      try {
        // List all keys in the TOOL_REQUESTS namespace
        const listed = await env.TOOL_REQUESTS.list();

        // Fetch all request entries in parallel
        const entries = await Promise.all(
          listed.keys.map(async (key) => {
            const val = await env.TOOL_REQUESTS.get(key.name);
            return val ? JSON.parse(val) : null;
          })
        );

        // Filter nulls, apply status filter, sort newest first, apply limit
        const filtered = entries
          .filter(Boolean)
          .filter(e => status === "all" || e.status === status)
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, limit);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              total: filtered.length,
              status_filter: status,
              requests: filtered,
            }),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  return server;
}

// ─────────────────────────────────────────────
// Cloudflare Worker fetch handler
// ─────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", version: "1.0.0" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // OAuth discovery — required by Claude.ai even for authless servers
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return new Response(JSON.stringify({
        resource: url.origin,
        authorization_servers: [],
      }), { headers: { "Content-Type": "application/json" } });
    }

    // No auth server — return 404 to signal authless
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return new Response(null, { status: 404 });
    }

    // No dynamic client registration
    if (url.pathname === "/register" && request.method === "POST") {
      return new Response(null, { status: 404 });
    }

    // MCP endpoint — Claude hits both / and /mcp depending on version
    if (url.pathname === "/mcp" || url.pathname === "/") {
      // Handle CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
          },
        });
      }

      // Create a fresh server and transport per request (required for stateless mode)
      const server = createServer(env);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless — no session tracking
      });

      await server.connect(transport);
      return transport.handleRequest(request);
    }

    return new Response("Not found", { status: 404 });
  },
};