# mcp-text-tools

Lightweight text processing tools for AI agents, exposed as a remote MCP server. No AI dependencies — pure deterministic primitives you can call from any MCP-compatible client.

## Tools

| Tool | Description |
|---|---|
| `diff_text` | Compare two strings and return a unified diff patch |
| `chunk_text` | Split text into token-sized chunks with optional overlap |
| `extract_json` | Extract a JSON value from messy or mixed text |
| `regex_extract` | Extract all regex matches from text with positions and capture groups |
| `truncate_to_tokens` | Trim text to fit within a token budget without cutting mid-word |

All tools are pay-per-call via Stripe. No subscription required.

## Quickstart

Add to your MCP client config (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "text-tools": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mcp-text-tools.dan-8fc.workers.dev/mcp"
      ]
    }
  }
}
```

Or connect directly via Claude.ai → Settings → Connectors → Add custom connector:
```
https://mcp-text-tools.dan-8fc.workers.dev/mcp
```

On first use of a paid tool, you'll be prompted to complete a quick Stripe checkout. No account creation required — just a payment method.

---

## Tool Reference

### `diff_text`

Compares two strings and returns a unified diff patch along with added and removed line counts. Useful for change detection, patch generation, or summarizing edits.

**Input**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `a` | string | ✓ | Original text (max 1,000,000 chars) |
| `b` | string | ✓ | New text (max 1,000,000 chars) |
| `label_a` | string | | Label for original in the patch header (default: `a`) |
| `label_b` | string | | Label for new in the patch header (default: `b`) |

**Output**
```json
{
  "patch": "--- a\n+++ b\n@@ -1 +1 @@\n-hello world\n+hello dan\n",
  "added": 1,
  "removed": 1
}
```

---

### `chunk_text`

Splits text into token-sized chunks. Supports overlap between chunks for sliding-window RAG pipelines. Returns each chunk with its index and token count.

Token counts are estimates (~96% accuracy vs tiktoken) — suitable for most RAG and batching workflows but not exact.

**Input**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | ✓ | Text to split (max 1,000,000 chars) |
| `tokens_per_chunk` | integer | | Max tokens per chunk, 1–10000 (default: `500`) |
| `overlap` | integer | | Token overlap between consecutive chunks, 0–5000 (default: `0`) |

**Output**
```json
{
  "chunk_count": 3,
  "tokens_per_chunk": 500,
  "overlap": 50,
  "chunks": [
    { "index": 0, "token_count": 500, "text": "..." },
    { "index": 1, "token_count": 500, "text": "..." },
    { "index": 2, "token_count": 312, "text": "..." }
  ]
}
```

---

### `extract_json`

Pulls a JSON value out of messy or mixed text — LLM output wrapped in markdown fences, surrounded by prose, or containing extra commentary. Returns the first valid JSON object, array, string, number, or boolean found.

**Input**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | ✓ | Text containing JSON somewhere inside it (max 1,000,000 chars) |
| `expect` | string | | Expected root type: `object`, `array`, or `any` (default: `any`) |

**Output**
```json
{
  "found": true,
  "type": "object",
  "value": { "name": "dan", "score": 42 }
}
```

If no valid JSON is found:
```json
{
  "found": false,
  "error": "No valid JSON found in input"
}
```

---

### `regex_extract`

Runs a regular expression against text and returns every match with its position and capture groups. Useful for pulling emails, URLs, IDs, dates, or any structured pattern from unstructured text.

The global flag (`g`) is always applied automatically. Capped at 10,000 matches.

**Input**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | ✓ | Text to search (max 1,000,000 chars) |
| `pattern` | string | ✓ | Regular expression pattern (e.g. `\d+`, `[a-z]+@[a-z]+\.com`) |
| `flags` | string | | Regex flags: `i` (case-insensitive), `m` (multiline), `s` (dotAll) — `g` is always added automatically |

**Output**
```json
{
  "match_count": 2,
  "pattern": "\\d+",
  "flags": "g",
  "matches": [
    { "match": "42", "index": 7 },
    { "match": "100", "index": 14 }
  ]
}
```

With named capture groups:
```json
{
  "match_count": 1,
  "matches": [
    {
      "match": "dan@example.com",
      "index": 0,
      "groups": { "user": "dan", "domain": "example.com" }
    }
  ]
}
```

---

### `truncate_to_tokens`

Trims text to fit within a token budget without cutting mid-word. Useful for fitting content into LLM context windows, prompt slots, or any size-constrained input. Supports truncating from either end.

**Input**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | ✓ | Text to truncate (max 1,000,000 chars) |
| `max_tokens` | integer | ✓ | Maximum number of tokens to allow (1–200,000) |
| `from` | string | | Which end to truncate: `end` keeps the beginning (default), `start` keeps the end |

**Output** — when truncation was needed:
```json
{
  "truncated": true,
  "original_token_count": 1200,
  "token_count": 500,
  "removed_from": "end",
  "text": "..."
}
```

**Output** — when already within budget:
```json
{
  "truncated": false,
  "token_count": 312,
  "text": "..."
}
```

---

## Pricing

Currently free. Will implement pay per call system at a later date.

## Feedback & Issues

Found a bug or have a suggestion? [Open an issue on GitHub](https://github.com/Vgamer1/mcp-text-tools/issues).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get started.

## License

MIT