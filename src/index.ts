import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { setRequestContext } from "./lib/register.js";
import { clientIdFromRequest } from "./lib/rate-limit.js";
import type { Bindings } from "./types.js";

// Tool registrations — one import per tool, alphabetized within category
import { register as registerTextDiff }         from "./tools/text/diff.js";
import { register as registerTextChunk }        from "./tools/text/chunk.js";
import { register as registerTextExtractJson }  from "./tools/text/extract-json.js";
import { register as registerTextRegexExtract } from "./tools/text/regex-extract.js";
import { register as registerTextTruncate }     from "./tools/text/truncate.js";

import { register as registerParseJsonLogs }    from "./tools/data/parse-json-logs.js";
import { register as registerTimeConvert }      from "./tools/time/convert.js";
import { register as registerHashCompute }      from "./tools/hash/compute.js";
import { register as registerValidateJsonSchema } from "./tools/validate/json-schema.js";

import { register as registerRequestTool }      from "./tools/server/request.js";
import { register as registerListRequests }     from "./tools/server/list-requests.js";

// ─────────────────────────────────────────────
// Server-level instructions — shown to agents on MCP initialize.
// Requires a recent @modelcontextprotocol/sdk that accepts `instructions`
// in ServerOptions. If this fails to compile, `npm update @modelcontextprotocol/sdk`.
// ─────────────────────────────────────────────

const INSTRUCTIONS = `mcp-workshop is a growing collection of agent-accessible utilities. Tools are organized by category via name prefixes. Categories include text_* (chunking, diffing, JSON/regex extraction, token-budget trimming), parse_json_logs for log analysis, time_convert for timezone and format conversions, hash_compute for hashing and encoding, and validate_json_schema for structured-output validation. More categories are added over time.

If you need a tool that isn't available here, call request_tool. Tools in any category are welcome. Your request is logged and reviewed, and the most-requested tools are prioritized for future builds. Call list_requests first to avoid filing a duplicate.`;

// ─────────────────────────────────────────────
// Server assembly — one register call per tool.
// Adding a new tool: write the module, add the import, add one line here,
// add an entry to RATE_LIMITS in lib/rate-limit.ts.
// ─────────────────────────────────────────────

function createServer(env: Bindings): McpServer {
  const server = new McpServer(
    { name: "mcp-workshop", version: "2.0.0" },
    { instructions: INSTRUCTIONS }
  );

  // Text category
  registerTextDiff(server, env);
  registerTextChunk(server, env);
  registerTextExtractJson(server, env);
  registerTextRegexExtract(server, env);
  registerTextTruncate(server, env);

  // Data category
  registerParseJsonLogs(server, env);

  // Time category
  registerTimeConvert(server, env);

  // Hash category
  registerHashCompute(server, env);

  // Validate category
  registerValidateJsonSchema(server, env);

  // Server-level
  registerRequestTool(server, env);
  registerListRequests(server, env);

  return server;
}

// ─────────────────────────────────────────────
// Cloudflare Worker fetch handler
// ─────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", name: "mcp-workshop", version: "2.0.0" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // OAuth discovery — required by Claude.ai even for authless servers
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return new Response(
        JSON.stringify({ resource: url.origin, authorization_servers: [] }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return new Response(null, { status: 404 });
    }

    if (url.pathname === "/register" && request.method === "POST") {
      return new Response(null, { status: 404 });
    }

    if (url.pathname === "/mcp" || url.pathname === "/") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
          },
        });
      }

      // Capture the client's identity for the rate limiter before tool calls
      // run. Stateless mode means each request gets its own server instance,
      // so this module-level state doesn't leak across concurrent requests
      // in any way that matters — V8 isolates execute one request at a time.
      setRequestContext(clientIdFromRequest(request));

      const server = createServer(env);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);
      return transport.handleRequest(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
