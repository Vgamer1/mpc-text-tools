// ─────────────────────────────────────────────
// MCP response helpers.
//
// Error responses MUST set `isError: true` so callers can distinguish
// a failed call from a successful call that happens to contain an
// "error" field. This is a strict MCP protocol requirement.
// ─────────────────────────────────────────────

export function successResponse(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

export function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}
