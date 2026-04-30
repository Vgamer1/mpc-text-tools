import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../../lib/responses.js";
import { registerToolWithLimits } from "../../lib/register.js";
import type { Bindings } from "../../types.js";

// ─────────────────────────────────────────────
// list_requests — read the append-only request log, newest first.
//
// TODO: migrate to D1 (SQLite on Workers) when the log grows past a
// few hundred entries. Current approach fetches every record on every
// call; fine at low volume, wasteful at scale.
// ─────────────────────────────────────────────

const schema = {
  limit: z.number().int().min(1).max(500).optional().describe("Maximum number of requests to return (default: 100)"),
};

type Args = {
  limit?: number;
};

export function register(server: McpServer, env: Bindings) {
  registerToolWithLimits<Args>(
    server,
    env,
    "list_requests",
    "List tool requests submitted via request_tool, newest first.",
    schema,
    async ({ limit = 100 }) => {
      try {
        // KV.list defaults to 1000 keys per call — no pagination handling here.
        // Acceptable until the log exceeds that; migrate to D1 before then.
        const listed = await env.TOOL_REQUESTS.list({ prefix: "req_" });

        // Parallel fetch of all entries. Each .get() is a billed KV read, so
        // this cost scales linearly with log size — another reason to migrate.
        const entries = await Promise.all(
          listed.keys.map(async (key) => {
            const val = await env.TOOL_REQUESTS.get(key.name);
            return val ? JSON.parse(val) : null;
          })
        );

        // Sort by timestamp field (not by key) so entries from pre-UUID IDs
        // still order correctly after the ID format change.
        const results = entries
          .filter(Boolean)
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, limit);

        return successResponse({
          total: results.length,
          requests: results,
        });
      } catch (err: any) {
        return errorResponse(err.message);
      }
    }
  );
}
