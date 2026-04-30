import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../../lib/responses.js";
import { registerToolWithLimits } from "../../lib/register.js";
import type { Bindings } from "../../types.js";

// ─────────────────────────────────────────────
// parse_json_logs — analyze JSON log payloads.
//
// Pure compute, no external calls. Accepts either a JSON array or
// newline-delimited JSON (NDJSON). Returns level breakdown, top error
// messages, timeline span, and structured anomaly flags.
//
// Single-pass aggregation over entries; min/max via running comparison
// (NOT Math.min/max with spread, which crashes on ~100k+ element inputs
// in V8).
// ─────────────────────────────────────────────

type Anomaly =
  | { type: "high_error_rate"; error_rate: number; threshold: number }
  | { type: "missing_level_field" }
  | { type: "missing_message_field" }
  | { type: "missing_time_field" }
  | { type: "parse_errors"; bad_line_count: number; first_bad_line: number };

function normalizeLevel(raw: string): string {
  const lower = raw.toLowerCase();
  if (["err", "error", "fatal", "critical", "crit"].includes(lower)) return "error";
  if (["warn", "warning"].includes(lower)) return "warn";
  if (["info", "information"].includes(lower)) return "info";
  if (["debug", "trace", "verbose"].includes(lower)) return "debug";
  return lower;
}

/**
 * Parse a numeric or string timestamp into ms-since-epoch. Returns null
 * if unparseable.
 *
 * Distinguishes seconds from milliseconds by digit count, not magnitude.
 * 10 digits ≈ seconds (good through year 2286). 13 digits ≈ ms.
 * The previous magnitude-based heuristic incorrectly multiplied
 * pre-2001 millisecond timestamps by 1000.
 */
function parseTimestamp(raw: unknown): number | null {
  if (typeof raw === "number") {
    const digits = Math.abs(raw).toString().length;
    if (digits <= 10) return raw * 1000;
    return raw;
  }
  if (typeof raw === "string") {
    const ms = new Date(raw).getTime();
    return isNaN(ms) ? null : ms;
  }
  return null;
}

const schema = {
  logs:           z.string().max(2_000_000).describe("Log data as a JSON array string (e.g. '[{...},{...}]') or newline-delimited JSON (one JSON object per line)"),
  level_field:    z.string().max(50).optional().describe("Name of the field that contains the log level (default: auto-detects 'level', 'severity', 'lvl', 'log_level')"),
  message_field:  z.string().max(50).optional().describe("Name of the field that contains the log message (default: auto-detects 'message', 'msg', 'text', 'error', 'err')"),
  time_field:     z.string().max(50).optional().describe("Name of the timestamp field (default: auto-detects 'timestamp', 'time', 'ts', '@timestamp', 'datetime', 'eventTime', 'created_at', 'occurred_at')"),
  top_errors:     z.number().int().min(1).max(50).optional().describe("Number of most-frequent error messages to surface (default: 5)"),
  message_max_chars: z.number().int().min(50).max(5000).optional().describe("Truncation length for error messages (default: 1000). Stack traces benefit from larger values."),
};

type Args = {
  logs: string;
  level_field?: string;
  message_field?: string;
  time_field?: string;
  top_errors?: number;
  message_max_chars?: number;
};

export function register(server: McpServer, env: Bindings) {
  registerToolWithLimits<Args>(
    server,
    env,
    "parse_json_logs",
    "Analyze JSON log data and return a structured summary: counts by level, top error messages, timeline span, and flagged anomalies. Accepts a JSON array or newline-delimited JSON (NDJSON). Pure compute — no API key required.",
    schema,
    async ({ logs, level_field, message_field, time_field, top_errors = 5, message_max_chars = 1000 }) => {
      try {
        // ── Parse input: JSON array or NDJSON ──
        let entries: Record<string, any>[];
        let parseErrorCount = 0;
        let firstBadLine = 0;
        const trimmed = logs.trim();

        if (trimmed.startsWith("[")) {
          let parsed: unknown;
          try { parsed = JSON.parse(trimmed); } catch {
            return errorResponse("Input looks like a JSON array but failed to parse. Check for syntax errors.");
          }
          if (!Array.isArray(parsed)) {
            return errorResponse("Parsed value is not an array. Wrap log objects in [].");
          }
          entries = parsed as Record<string, any>[];
        } else {
          const lines = trimmed.split("\n").filter(l => l.trim().length > 0);
          const parsed: Record<string, any>[] = [];
          for (let i = 0; i < lines.length; i++) {
            try { parsed.push(JSON.parse(lines[i])); }
            catch {
              parseErrorCount++;
              if (firstBadLine === 0) firstBadLine = i + 1;
            }
          }
          if (parsed.length === 0 && parseErrorCount > 0) {
            return errorResponse(`Failed to parse any lines as JSON. First bad line: ${firstBadLine}`);
          }
          entries = parsed;
        }

        // Filter to actual objects. Stray scalars or arrays in NDJSON parse fine
        // but break field lookups silently (Object.keys returns []), so drop them.
        entries = entries.filter(
          e => e !== null && typeof e === "object" && !Array.isArray(e)
        );

        if (entries.length === 0) {
          return errorResponse("No valid log objects found in input.");
        }

        // ── Auto-detect field names from first entry ──
        const first = entries[0];
        const keys = Object.keys(first);
        const lowerKeys = keys.map(k => ({ orig: k, lower: k.toLowerCase() }));

        const findKey = (override: string | undefined, candidates: string[]) => {
          if (override) return override;
          const found = lowerKeys.find(k => candidates.includes(k.lower));
          return found?.orig ?? null;
        };

        const resolvedLevelField = findKey(level_field,
          ["level", "severity", "lvl", "log_level"]);
        const resolvedMessageField = findKey(message_field,
          ["message", "msg", "text", "error", "err"]);
        const resolvedTimeField = findKey(time_field,
          ["timestamp", "time", "ts", "@timestamp", "datetime",
           "eventtime", "created_at", "occurred_at"]);

        // ── Single pass: level counts, error message frequency, timestamp range ──
        const levelCounts: Record<string, number> = {};
        const errorMessageFreq: Record<string, number> = {};
        let minTime = Infinity;
        let maxTime = -Infinity;
        let timeCount = 0;
        let errorCount = 0;

        for (const entry of entries) {
          const levelRaw = resolvedLevelField
            ? String(entry[resolvedLevelField] ?? "unknown")
            : "unknown";
          const level = normalizeLevel(levelRaw);
          levelCounts[level] = (levelCounts[level] ?? 0) + 1;

          if (level === "error") {
            errorCount++;
            if (resolvedMessageField) {
              const msg = String(entry[resolvedMessageField] ?? "").slice(0, message_max_chars);
              if (msg) errorMessageFreq[msg] = (errorMessageFreq[msg] ?? 0) + 1;
            }
          }

          // Running min/max — never spread into Math.min/max (crashes on ~100k+).
          if (resolvedTimeField) {
            const ms = parseTimestamp(entry[resolvedTimeField]);
            if (ms !== null) {
              if (ms < minTime) minTime = ms;
              if (ms > maxTime) maxTime = ms;
              timeCount++;
            }
          }
        }

        const topErrorMessages = Object.entries(errorMessageFreq)
          .sort((a, b) => b[1] - a[1])
          .slice(0, top_errors)
          .map(([message, count]) => ({ message, count }));

        const timeline = timeCount > 0
          ? {
              first: new Date(minTime).toISOString(),
              last:  new Date(maxTime).toISOString(),
              span_seconds: Math.round((maxTime - minTime) / 1000),
            }
          : { first: null, last: null, span_seconds: null };

        // Structured anomalies (not strings) so agents can react programmatically.
        const anomalies: Anomaly[] = [];
        const errorRate = errorCount / entries.length;
        const HIGH_ERROR_RATE_THRESHOLD = 0.10;

        if (errorRate > HIGH_ERROR_RATE_THRESHOLD) {
          anomalies.push({
            type: "high_error_rate",
            error_rate: Math.round(errorRate * 1000) / 1000,
            threshold: HIGH_ERROR_RATE_THRESHOLD,
          });
        }
        if (!resolvedLevelField)   anomalies.push({ type: "missing_level_field" });
        if (!resolvedMessageField) anomalies.push({ type: "missing_message_field" });
        if (!resolvedTimeField)    anomalies.push({ type: "missing_time_field" });
        if (parseErrorCount > 0) {
          anomalies.push({
            type: "parse_errors",
            bad_line_count: parseErrorCount,
            first_bad_line: firstBadLine,
          });
        }

        const anomalySummary = anomalies.map(a => {
          switch (a.type) {
            case "high_error_rate":
              return `High error rate: ${Math.round(a.error_rate * 100)}% of entries are errors (threshold ${Math.round(a.threshold * 100)}%)`;
            case "missing_level_field":   return "No level field detected — level breakdown unavailable";
            case "missing_message_field": return "No message field detected — error message analysis unavailable";
            case "missing_time_field":    return "No timestamp field detected — timeline analysis unavailable";
            case "parse_errors":          return `${a.bad_line_count} line(s) failed to parse as JSON; first bad line: ${a.first_bad_line}`;
          }
        });

        return successResponse({
          total_entries: entries.length,
          fields_detected: {
            level:   resolvedLevelField,
            message: resolvedMessageField,
            time:    resolvedTimeField,
          },
          by_level: levelCounts,
          timeline,
          top_error_messages: topErrorMessages,
          anomalies,
          anomaly_summary: anomalySummary,
        });
      } catch (err: any) {
        return errorResponse(err.message);
      }
    }
  );
}
