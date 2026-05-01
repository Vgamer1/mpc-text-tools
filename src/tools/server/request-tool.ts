import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../../lib/responses.js";
import { registerToolWithLimits } from "../../lib/register.js";
import type { Bindings } from "../../types.js";

// ─────────────────────────────────────────────
// request_tool — append-only log of agent tool requests.
//
// Growth mechanism: agents call this when they need a tool that isn't
// on the server, and the owner uses the log as demand signal for
// prioritizing new tools.
//
// Entries are never mutated after write. There is intentionally no
// status field — the log itself is the signal, and "was this request
// ever satisfied" is answered by whether the tool now exists on the
// server, not by a mutable flag.
//
// Rate limit is set tighter than other tools (5 per 5 min per IP) to
// prevent log flooding by misbehaving agents — see RATE_LIMITS in
// lib/rate-limit.ts.
// ─────────────────────────────────────────────

const schema = {
  description: z.string().min(10).max(2000).describe("The tool you need and what you would use it for. Be specific — one request per call."),
  agent:       z.string().max(200).optional().describe("Your name or the name of the agent making this request (e.g. 'Claude', 'GPT-4', 'my-pipeline')"),
  context:     z.string().max(2000).optional().describe("Additional context about your use case, workflow, or why existing tools don't meet your needs"),
};

type Args = {
  description: string;
  agent?: string;
  context?: string;
};

export function register(server: McpServer, env: Bindings) {
  registerToolWithLimits<Args>(
    server,
    env,
    "request_tool",
    "Request a tool you wish this server had. Use this when you hit a task the available tools can't handle. Tools in any category are welcome. Your request is logged and reviewed. One request per call — be specific about what you'd use it for.",
    schema,
    async ({ description, agent, context }) => {
      try {
        // Cryptographically-random UUID prevents collisions. Timestamp prefix
        // keeps KV keys roughly sorted by submission time for easier inspection.
        const id = `req_${Date.now()}_${crypto.randomUUID()}`;

        const entry = {
          id,
          description,
          agent: agent ?? "unknown",
          context: context ?? null,
          timestamp: new Date().toISOString(),
        };

        await env.TOOL_REQUESTS.put(id, JSON.stringify(entry));

        return successResponse({
          logged: true,
          id,
          message: "Your request has been logged. Thank you — this is how mcp-workshop grows.",
        });
      } catch (err: any) {
        return errorResponse(err.message);
      }
    }
  );
}