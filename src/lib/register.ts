// ─────────────────────────────────────────────
// Tool registration helper.
//
// Wraps every tool with rate limiting so individual tool modules don't
// each have to repeat the rate-limit boilerplate. Each tool gets its
// limit from RATE_LIMITS by name, so adding a new tool means: write
// the handler + add an entry to RATE_LIMITS. Forgetting the entry
// throws at registration time — fail loud.
//
// The rate-limit identity (cf-connecting-ip) is captured at request
// time via the per-request store below, since MCP tool handlers don't
// receive the underlying HTTP Request directly.
// ─────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse } from "./responses.js";
import { checkRateLimit, RATE_LIMITS, type RateLimitConfig } from "./rate-limit.js";
import type { Bindings } from "../types.js";

/**
 * Per-request context. Set in the fetch handler before connecting the
 * MCP transport, read by tool handlers. Each request gets its own
 * createServer() call (stateless mode), so there's no cross-request
 * leakage despite the module-level state.
 */
let currentClientId: string = "anonymous";

export function setRequestContext(clientId: string) {
  currentClientId = clientId;
}

/**
 * Generic tool registration with rate limiting baked in.
 *
 * Usage in a tool module:
 *   registerToolWithLimits(server, env, "text_diff", description, schema, handler);
 *
 * The handler receives the parsed args; it does NOT need to do any
 * rate-limit work itself.
 */
export function registerToolWithLimits<TArgs>(
  server: McpServer,
  env: Bindings,
  name: string,
  description: string,
  schema: any, // Zod raw shape; SDK accepts a record of Zod types here
  handler: (args: TArgs) => Promise<any> | any
) {
  const limit: RateLimitConfig | undefined = RATE_LIMITS[name];
  if (!limit) {
    // Fail loud at registration so we never accidentally ship an
    // unlimited tool.
    throw new Error(`No rate limit defined for tool "${name}". Add an entry to RATE_LIMITS.`);
  }

  server.tool(name, description, schema, async (args: TArgs) => {
    const result = await checkRateLimit(env, name, currentClientId, limit);
    if (!result.ok) {
      return errorResponse(
        `Rate limit exceeded for ${name}. Try again in ${result.reset_seconds} seconds. ` +
        `Limit: ${limit.max} calls per ${limit.windowSeconds}s.`
      );
    }
    return handler(args);
  });
}
