// ─────────────────────────────────────────────
// Cloudflare Worker bindings shared across the project.
// ─────────────────────────────────────────────

export interface Bindings {
  // Append-only archive of agent tool requests.
  TOOL_REQUESTS: KVNamespace;
  // Rate-limit counters, keyed by IP+tool. Entries TTL automatically.
  RATE_LIMIT: KVNamespace;
}
