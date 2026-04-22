import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createTwoFilesPatch, parsePatch } from "diff";
import { estimateTokenCount, splitByTokens } from "tokenx";
import { z } from "zod";

// Appended to every tool description so agents and users know where to report issues
const FEEDBACK = "Bugs or suggestions? https://github.com/Vgamer1/mcp-workshop/issues";

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
  const server = new McpServer({ name: "mcp-workshop", version: "1.0.0" });

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
  // ─────────────────────────────────────────────
// NEW TOOLS — paste these inside createServer(), before `return server;`
// Also update: McpServer name → "mcp-workshop" (see bottom of this file)
// ─────────────────────────────────────────────

// ── github_list_prs ───────────────────────────
// Lists open pull requests for a repo with review status.
// Requires a GitHub personal access token (classic or fine-grained, repo:read scope).
server.tool(
  "github_list_prs",
  `List open pull requests for a GitHub repository, including review status, author, labels, and CI check state. Pass your GitHub personal access token (repo:read scope) as github_token. ${FEEDBACK}`,
  {
    owner:        z.string().max(100).describe("Repository owner (user or org name)"),
    repo:         z.string().max(100).describe("Repository name"),
    github_token: z.string().min(1).describe("GitHub personal access token with repo:read scope"),
    state:        z.enum(["open", "closed", "all"]).optional().describe("Filter by PR state (default: 'open')"),
    limit:        z.number().int().min(1).max(100).optional().describe("Max PRs to return (default: 30)"),
  },
  async ({ owner, repo, github_token, state = "open", limit = 30 }) => {
    try {
      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${state}&per_page=${limit}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${github_token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "mcp-workshop",
        },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as any;
        return { content: [{ type: "text", text: JSON.stringify({ error: `GitHub API error ${res.status}`, message: err?.message ?? res.statusText }) }] };
      }

      const prs = await res.json() as any[];

      const result = prs.map((pr: any) => ({
        number:       pr.number,
        title:        pr.title,
        state:        pr.state,
        author:       pr.user?.login ?? null,
        draft:        pr.draft ?? false,
        labels:       (pr.labels ?? []).map((l: any) => l.name),
        created_at:   pr.created_at,
        updated_at:   pr.updated_at,
        url:          pr.html_url,
        head_branch:  pr.head?.ref ?? null,
        base_branch:  pr.base?.ref ?? null,
        mergeable:    pr.mergeable ?? null,
        comments:     pr.comments ?? 0,
        review_comments: pr.review_comments ?? 0,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ total: result.length, state_filter: state, pull_requests: result }),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
    }
  }
);

// ── github_get_actions_runs ───────────────────
// Returns recent GitHub Actions workflow run statuses for a repo.
// Useful for checking CI health, spotting failures, or summarizing build history.
server.tool(
  "github_get_actions_runs",
  `Get recent GitHub Actions workflow run statuses for a repository. Returns run outcome, triggering branch, commit, and duration. Pass your GitHub personal access token (repo:read scope) as github_token. ${FEEDBACK}`,
  {
    owner:        z.string().max(100).describe("Repository owner (user or org name)"),
    repo:         z.string().max(100).describe("Repository name"),
    github_token: z.string().min(1).describe("GitHub personal access token with repo:read scope"),
    branch:       z.string().max(255).optional().describe("Filter runs to a specific branch (default: all branches)"),
    status:       z.enum(["completed", "in_progress", "queued", "all"]).optional().describe("Filter by run status (default: 'all')"),
    limit:        z.number().int().min(1).max(100).optional().describe("Max runs to return (default: 20)"),
  },
  async ({ owner, repo, github_token, branch, status = "all", limit = 20 }) => {
    try {
      const params = new URLSearchParams({ per_page: String(limit) });
      if (branch) params.set("branch", branch);
      if (status !== "all") params.set("status", status);

      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?${params}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${github_token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "mcp-workshop",
        },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as any;
        return { content: [{ type: "text", text: JSON.stringify({ error: `GitHub API error ${res.status}`, message: err?.message ?? res.statusText }) }] };
      }

      const data = await res.json() as any;
      const runs = (data.workflow_runs ?? []) as any[];

      const result = runs.map((run: any) => {
        const started  = run.run_started_at ? new Date(run.run_started_at).getTime() : null;
        const updated  = run.updated_at     ? new Date(run.updated_at).getTime()     : null;
        const duration_seconds = (started && updated) ? Math.round((updated - started) / 1000) : null;

        return {
          id:               run.id,
          name:             run.name,
          status:           run.status,
          conclusion:       run.conclusion ?? null,
          branch:           run.head_branch ?? null,
          commit_sha:       run.head_sha?.slice(0, 7) ?? null,
          commit_message:   run.head_commit?.message?.split("\n")[0] ?? null,
          triggered_by:     run.event ?? null,
          duration_seconds,
          started_at:       run.run_started_at ?? null,
          url:              run.html_url,
        };
      });

      // Build a quick summary of pass/fail/in-progress counts
      const summary = result.reduce((acc: Record<string, number>, r: any) => {
        const key = r.conclusion ?? r.status ?? "unknown";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ total: result.length, summary, runs: result }),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
    }
  }
);

// ── github_list_issues ────────────────────────
// Lists issues for a repo with filtering by state, label, and assignee.
// Note: GitHub's API returns PRs as issues too — this tool filters them out.
server.tool(
  "github_list_issues",
  `List issues for a GitHub repository with optional filtering by state, label, or assignee. Pull requests are excluded. Pass your GitHub personal access token (repo:read scope) as github_token. ${FEEDBACK}`,
  {
    owner:        z.string().max(100).describe("Repository owner (user or org name)"),
    repo:         z.string().max(100).describe("Repository name"),
    github_token: z.string().min(1).describe("GitHub personal access token with repo:read scope"),
    state:        z.enum(["open", "closed", "all"]).optional().describe("Filter by issue state (default: 'open')"),
    label:        z.string().max(200).optional().describe("Filter by label name (single label)"),
    assignee:     z.string().max(100).optional().describe("Filter by assignee username"),
    limit:        z.number().int().min(1).max(100).optional().describe("Max issues to return (default: 30)"),
  },
  async ({ owner, repo, github_token, state = "open", label, assignee, limit = 30 }) => {
    try {
      const params = new URLSearchParams({ state, per_page: String(limit) });
      if (label)    params.set("labels", label);
      if (assignee) params.set("assignee", assignee);

      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${github_token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "mcp-workshop",
        },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as any;
        return { content: [{ type: "text", text: JSON.stringify({ error: `GitHub API error ${res.status}`, message: err?.message ?? res.statusText }) }] };
      }

      const issues = await res.json() as any[];

      // GitHub returns PRs mixed in with issues — exclude them
      const filtered = issues.filter((i: any) => !i.pull_request);

      const result = filtered.map((issue: any) => ({
        number:     issue.number,
        title:      issue.title,
        state:      issue.state,
        author:     issue.user?.login ?? null,
        assignees:  (issue.assignees ?? []).map((a: any) => a.login),
        labels:     (issue.labels ?? []).map((l: any) => l.name),
        comments:   issue.comments ?? 0,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        closed_at:  issue.closed_at ?? null,
        url:        issue.html_url,
        body_preview: issue.body ? issue.body.slice(0, 200).replace(/\n/g, " ") : null,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ total: result.length, state_filter: state, issues: result }),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
    }
  }
);

// ── parse_json_logs ───────────────────────────
// Analyzes a JSON log payload and returns a structured summary.
// Accepts either a JSON array string or newline-delimited JSON (NDJSON).
// Pure compute — no external calls, 100% margin.
server.tool(
  "parse_json_logs",
  `Analyze JSON log data and return a structured summary: counts by level, top error messages, timeline span, and flagged anomalies. Accepts a JSON array or newline-delimited JSON (NDJSON). No API key required. ${FEEDBACK}`,
  {
    logs:        z.string().max(2_000_000).describe("Log data as a JSON array string (e.g. '[{...},{...}]') or newline-delimited JSON (one JSON object per line)"),
    level_field: z.string().max(50).optional().describe("Name of the field that contains the log level (default: auto-detects 'level', 'severity', 'lvl')"),
    message_field: z.string().max(50).optional().describe("Name of the field that contains the log message (default: auto-detects 'message', 'msg', 'text', 'error')"),
    time_field:  z.string().max(50).optional().describe("Name of the timestamp field (default: auto-detects 'timestamp', 'time', 'ts', '@timestamp')"),
    top_errors:  z.number().int().min(1).max(50).optional().describe("Number of most-frequent error messages to surface (default: 5)"),
  },
  async ({ logs, level_field, message_field, time_field, top_errors = 5 }) => {
    try {
      // ── Parse input: try JSON array first, fall back to NDJSON ──
      let entries: Record<string, any>[];
      const trimmed = logs.trim();

      if (trimmed.startsWith("[")) {
        // JSON array
        let parsed: any;
        try { parsed = JSON.parse(trimmed); } catch {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Input looks like a JSON array but failed to parse. Check for syntax errors." }) }] };
        }
        if (!Array.isArray(parsed)) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Parsed value is not an array. Wrap log objects in []." }) }] };
        }
        entries = parsed;
      } else {
        // NDJSON — one JSON object per line
        const lines = trimmed.split("\n").filter(l => l.trim().length > 0);
        const parsed: Record<string, any>[] = [];
        const parseErrors: number[] = [];
        lines.forEach((line, i) => {
          try { parsed.push(JSON.parse(line.trim())); }
          catch { parseErrors.push(i + 1); }
        });
        if (parseErrors.length > 0 && parsed.length === 0) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to parse any lines as JSON. First bad line: ${parseErrors[0]}` }) }] };
        }
        entries = parsed;
      }

      if (entries.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "No log entries found in input." }) }] };
      }

      // ── Auto-detect field names from first entry ──
      const first = entries[0];
      const keys = Object.keys(first);

      const resolvedLevelField   = level_field   ?? keys.find(k => ["level", "severity", "lvl", "log_level"].includes(k.toLowerCase())) ?? null;
      const resolvedMessageField = message_field ?? keys.find(k => ["message", "msg", "text", "error", "err"].includes(k.toLowerCase())) ?? null;
      const resolvedTimeField    = time_field    ?? keys.find(k => ["timestamp", "time", "ts", "@timestamp", "datetime"].includes(k.toLowerCase())) ?? null;

      // ── Count by level ──
      const levelCounts: Record<string, number> = {};
      for (const entry of entries) {
        const raw = resolvedLevelField ? String(entry[resolvedLevelField] ?? "unknown").toLowerCase() : "unknown";
        // Normalize common level aliases
        const level =
          ["err", "error", "fatal", "critical", "crit"].includes(raw) ? "error" :
          ["warn", "warning"].includes(raw)                           ? "warn"  :
          ["info", "information"].includes(raw)                       ? "info"  :
          ["debug", "trace", "verbose"].includes(raw)                 ? "debug" :
          raw;
        levelCounts[level] = (levelCounts[level] ?? 0) + 1;
      }

      // ── Top error messages ──
      const errorEntries = entries.filter(e => {
        if (!resolvedLevelField) return false;
        const raw = String(e[resolvedLevelField] ?? "").toLowerCase();
        return ["error", "err", "fatal", "critical", "crit"].includes(raw);
      });

      const msgFreq: Record<string, number> = {};
      for (const entry of errorEntries) {
        if (!resolvedMessageField) break;
        const msg = String(entry[resolvedMessageField] ?? "").slice(0, 300);
        if (msg) msgFreq[msg] = (msgFreq[msg] ?? 0) + 1;
      }

      const topErrorMessages = Object.entries(msgFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, top_errors)
        .map(([message, count]) => ({ message, count }));

      // ── Timeline span ──
      let firstTimestamp: string | null = null;
      let lastTimestamp:  string | null = null;
      let spanSeconds:    number | null = null;

      if (resolvedTimeField) {
        const times: number[] = [];
        for (const entry of entries) {
          const raw = entry[resolvedTimeField];
          if (!raw) continue;
          const ms = typeof raw === "number"
            ? (raw > 1e12 ? raw : raw * 1000)  // handle both ms and Unix seconds
            : new Date(raw).getTime();
          if (!isNaN(ms)) times.push(ms);
        }
        if (times.length > 0) {
          const minT = Math.min(...times);
          const maxT = Math.max(...times);
          firstTimestamp = new Date(minT).toISOString();
          lastTimestamp  = new Date(maxT).toISOString();
          spanSeconds    = Math.round((maxT - minT) / 1000);
        }
      }

      // ── Anomaly flags ──
      const anomalies: string[] = [];
      const errorCount = (levelCounts["error"] ?? 0);
      const total = entries.length;

      if (errorCount / total > 0.1)  anomalies.push(`High error rate: ${Math.round(errorCount / total * 100)}% of entries are errors`);
      if (!resolvedLevelField)        anomalies.push("No level field detected — level breakdown unavailable");
      if (!resolvedMessageField)      anomalies.push("No message field detected — error message analysis unavailable");
      if (!resolvedTimeField)         anomalies.push("No timestamp field detected — timeline analysis unavailable");

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total_entries:   total,
            fields_detected: {
              level:   resolvedLevelField   ?? null,
              message: resolvedMessageField ?? null,
              time:    resolvedTimeField    ?? null,
            },
            by_level:           levelCounts,
            timeline: {
              first:         firstTimestamp,
              last:          lastTimestamp,
              span_seconds:  spanSeconds,
            },
            top_error_messages: topErrorMessages,
            anomalies,
          }),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
    }
  }
);

// ─────────────────────────────────────────────
// OTHER CHANGES NEEDED (not in this snippet):
// ─────────────────────────────────────────────
// 1. In createServer(), update McpServer init:
//      new McpServer({ name: "mcp-workshop", version: "1.0.0" })
//
// 2. Update FEEDBACK constant URL to new repo name once renamed:
//      const FEEDBACK = "Bugs or suggestions? https://github.com/Vgamer1/mcp-workshop/issues";
//
// 3. wrangler.toml → name = "mcp-workshop"
//
// 4. package.json → "name": "mcp-workshop", update description

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