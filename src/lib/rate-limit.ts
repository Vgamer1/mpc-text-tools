// ─────────────────────────────────────────────
// KV-backed rate limiter.
//
// Approach: fixed-window counter keyed by `${tool}:${client_id}`. Each
// window is `windowSeconds` long; KV TTL handles expiration so counters
// disappear automatically.
//
// Why fixed-window and not sliding-window: sliding-window needs a sorted
// log of timestamps per key, which is multiple KV ops per call. Fixed-
// window is one read + one write. Imperfect at window boundaries (a
// caller could hit the limit at the end of one window and the start of
// the next) but cheap and good enough for our use case.
//
// Why not Cloudflare's built-in Rate Limiting binding: that binding is
// global per-key and doesn't let us set different limits per tool from
// inside the worker. We need per-tool limits because text_diff and
// parse_json_logs have very different cost profiles. Worth revisiting
// if KV read costs become an issue.
//
// IMPORTANT: KV is eventually consistent globally (~60s for list ops,
// faster for get/put on the same key). At very high call volume, the
// limit can be exceeded by a small factor. Acceptable for what we need.
// ─────────────────────────────────────────────

import type { Bindings } from "../types.js";

export interface RateLimitConfig {
  /** Max calls per window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  reset_seconds: number;
}

/**
 * Extract a rate-limit identity for the caller.
 *
 * Cloudflare puts the client IP in `cf-connecting-ip`. We don't have
 * authenticated user IDs yet — when we add auth, key on user ID instead
 * (or fall back to IP for unauth'd traffic).
 *
 * If neither is available (rare — local dev), use "anonymous" so the
 * limiter still protects the server, just collectively.
 */
export function clientIdFromRequest(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    "anonymous"
  );
}

/**
 * Check whether `clientId` is allowed to invoke `tool` under `config`.
 *
 * Increments the counter if allowed. Returns `{ ok: false }` if the
 * caller is over the limit; the tool should refuse to run in that case.
 */
export async function checkRateLimit(
  env: Bindings,
  tool: string,
  clientId: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  // Bucket the current time into windows so all calls within the same
  // window share a key. This makes counters reset cleanly at window
  // boundaries without needing scheduled cleanup.
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / config.windowSeconds) * config.windowSeconds;
  const key = `rl:${tool}:${clientId}:${windowStart}`;

  // Read current count. Missing key = first call in this window.
  const raw = await env.RATE_LIMIT.get(key);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= config.max) {
    // Over limit — calculate seconds until next window opens.
    const resetSeconds = (windowStart + config.windowSeconds) - now;
    return { ok: false, remaining: 0, reset_seconds: resetSeconds };
  }

  // Under limit — increment. KV TTL of `windowSeconds` ensures the
  // counter expires when the window closes; no manual cleanup needed.
  // (Min TTL is 60 seconds in KV, so windows shorter than that get
  // bumped to 60. We use 60s+ windows everywhere, so this is fine.)
  await env.RATE_LIMIT.put(key, String(count + 1), {
    expirationTtl: Math.max(60, config.windowSeconds),
  });

  return {
    ok: true,
    remaining: config.max - count - 1,
    reset_seconds: (windowStart + config.windowSeconds) - now,
  };
}

/**
 * Per-tool rate limit defaults.
 *
 * Tunable from one place. Generous enough that real workflows won't hit
 * them; restrictive enough to stop scripted abuse. `request_tool` is
 * lowest because (a) it writes to KV and (b) flooding the request log
 * is the most disruptive abuse vector.
 */
export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  // Text — pure compute, cheap. Generous.
  text_diff:           { max: 120, windowSeconds: 60 },
  text_chunk:          { max: 120, windowSeconds: 60 },
  text_extract_json:   { max: 120, windowSeconds: 60 },
  text_regex_extract:  { max: 60,  windowSeconds: 60 },  // ReDoS risk → tighter
  text_truncate:       { max: 120, windowSeconds: 60 },

  // Data — heavier compute (up to 2MB input, lots of parsing).
  parse_json_logs:     { max: 30,  windowSeconds: 60 },

  // Time/hash/validate — cheap, no I/O.
  time_convert:        { max: 120, windowSeconds: 60 },
  hash_compute:        { max: 120, windowSeconds: 60 },
  validate_json_schema:{ max: 60,  windowSeconds: 60 },

  // Server-level — request_tool writes to KV and shapes our backlog,
  // so abuse here is the most damaging.
  request_tool:        { max: 5,   windowSeconds: 300 },
  list_requests:       { max: 30,  windowSeconds: 60 },
};
