# mcp-text-tools

Lightweight text processing tools for AI agents, exposed as a remote MCP server.

| Tool | Description |
|---|---|
| `diff_text` | Compare two strings and return a unified diff patch |
| `chunk_text` | Split text into token-sized chunks with optional overlap |

Both tools are pay-per-call via Stripe. No subscription required.

## Quickstart

Add to your MCP client config (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "text-tools": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mcp-text-tools.YOUR-SUBDOMAIN.workers.dev/mcp"
      ]
    }
  }
}
```

On first use you'll be prompted to complete a quick Stripe checkout. No account creation required — just a payment method.

## Tool Reference

### `diff_text`

Compares two strings and returns a unified diff patch along with added and removed line counts. Useful for change detection, patch generation, or summarizing edits.

**Input**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `a` | string | ✓ | Original text |
| `b` | string | ✓ | New text |
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

**Input**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | ✓ | Text to split |
| `tokens_per_chunk` | number | | Max tokens per chunk (default: `500`) |
| `overlap` | number | | Token overlap between consecutive chunks (default: `0`) |

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

## Pricing

Both tools are billed per call via Stripe. No subscription, no minimum spend. You only pay for what you use.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get started.

## License

MIT
