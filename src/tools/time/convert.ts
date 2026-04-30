import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../../lib/responses.js";
import { registerToolWithLimits } from "../../lib/register.js";
import type { Bindings } from "../../types.js";

// ─────────────────────────────────────────────
// time_convert — timezone, format, and relative-time conversion.
//
// Pure compute. Uses the runtime's Intl + Date facilities, which are
// fully supported on Cloudflare Workers (V8 with full ICU). No deps.
//
// Three modes, picked by which of {to_timezone, to_format} is given,
// or both:
//   • to_timezone only  → keep the instant, render in target zone
//   • to_format only    → reformat in source zone (or UTC if input was UTC)
//   • both              → render in target zone using target format
//
// Always returns the canonical UTC ISO string and a Unix epoch (ms) so
// downstream tools can do arithmetic on a stable representation.
// ─────────────────────────────────────────────

/**
 * Parse a wide variety of input timestamps:
 *   • ISO 8601 strings (with or without timezone)
 *   • RFC 2822
 *   • Unix epoch in seconds or milliseconds (numeric string or number-as-string)
 *   • Relative phrases: "now", "+5m", "-1h", "+2d", "+1w"
 *
 * Returns ms-since-epoch, or null if unparseable.
 */
function parseFlexibleTime(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.toLowerCase() === "now") return Date.now();

  // Relative offsets like "+5m", "-1h"
  const relMatch = trimmed.match(/^([+-])(\d+)([smhdw])$/i);
  if (relMatch) {
    const [, sign, numStr, unit] = relMatch;
    const num = parseInt(numStr, 10);
    const multipliers: Record<string, number> = {
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
    };
    const ms = num * multipliers[unit.toLowerCase()];
    return Date.now() + (sign === "+" ? ms : -ms);
  }

  // Pure-numeric string → epoch. Same digit-count heuristic as parse_json_logs:
  // ≤10 digits ≈ seconds, otherwise milliseconds. Handles the edge case where
  // a magnitude-based check would mis-multiply pre-2001 ms timestamps.
  if (/^-?\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    const digits = Math.abs(n).toString().length;
    return digits <= 10 ? n * 1000 : n;
  }

  // Fall back to Date parser (handles ISO 8601 and RFC 2822)
  const ms = new Date(trimmed).getTime();
  return isNaN(ms) ? null : ms;
}

/**
 * Validate a timezone identifier by attempting to format with it. The Intl
 * API throws RangeError for invalid zones, which we convert to a clear
 * tool error message.
 */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Format a Date instance in the requested zone using a small set of named
 * format presets. We don't expose strftime-style format strings because
 * the JS standard library doesn't natively support them and rolling our
 * own is a bug factory for marginal benefit.
 */
function formatInZone(ms: number, format: string, timezone: string): string {
  const date = new Date(ms);

  const presets: Record<string, Intl.DateTimeFormatOptions> = {
    iso:        { /* handled separately via toISOString */ },
    rfc2822:    { /* handled separately via toUTCString */ },
    date:       { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" },
    time:       { timeZone: timezone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
    datetime:   { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
    long:       { timeZone: timezone, dateStyle: "full", timeStyle: "long" },
    short:      { timeZone: timezone, dateStyle: "short", timeStyle: "short" },
    relative:   { /* handled separately */ },
  };

  if (format === "iso") {
    // ISO is always UTC by the standard. Honoring `timezone` here would
    // produce a non-ISO output and confuse callers.
    return date.toISOString();
  }
  if (format === "rfc2822") {
    return date.toUTCString();
  }
  if (format === "relative") {
    return relativeFromNow(ms);
  }
  if (format === "unix") {
    return String(Math.floor(ms / 1000));
  }
  if (format === "unix_ms") {
    return String(ms);
  }

  const opts = presets[format];
  if (!opts) {
    // Caller should never hit this if the zod enum is in sync, but defensive.
    throw new Error(`Unknown format: ${format}`);
  }
  return new Intl.DateTimeFormat("en-US", opts).format(date);
}

/**
 * Render a timestamp as a relative phrase from now ("3 hours ago",
 * "in 2 days"). Uses Intl.RelativeTimeFormat for proper localization.
 */
function relativeFromNow(ms: number): string {
  const diffMs = ms - Date.now();
  const absMs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year",   31_536_000_000],
    ["month",  2_592_000_000],
    ["week",   604_800_000],
    ["day",    86_400_000],
    ["hour",   3_600_000],
    ["minute", 60_000],
    ["second", 1_000],
  ];

  for (const [unit, divisor] of units) {
    if (absMs >= divisor || unit === "second") {
      const value = Math.round(diffMs / divisor);
      return rtf.format(value, unit);
    }
  }
  return "just now";
}

const FORMAT_VALUES = ["iso", "rfc2822", "date", "time", "datetime", "long", "short", "relative", "unix", "unix_ms"] as const;

const schema = {
  time:        z.string().min(1).max(200).describe("The time to convert. Accepts ISO 8601 ('2026-04-27T15:30:00Z'), Unix epoch ('1745764200' or '1745764200000'), RFC 2822, relative offsets ('+5m', '-1h', '+2d'), or 'now'."),
  to_timezone: z.string().max(100).optional().describe("Target IANA timezone (e.g. 'America/Los_Angeles', 'Asia/Tokyo', 'UTC'). Default: UTC."),
  to_format:   z.enum(FORMAT_VALUES).optional().describe("Output format: 'iso' (always UTC), 'rfc2822', 'date', 'time', 'datetime', 'long', 'short', 'relative' ('3 hours ago'), 'unix' (seconds), 'unix_ms' (milliseconds). Default: 'iso'."),
};

type Args = {
  time: string;
  to_timezone?: string;
  to_format?: typeof FORMAT_VALUES[number];
};

export function register(server: McpServer, env: Bindings) {
  registerToolWithLimits<Args>(
    server,
    env,
    "time_convert",
    "Convert a timestamp between timezones and formats. Accepts ISO 8601, Unix epoch (seconds or ms), RFC 2822, relative offsets ('+5m', '-1h', '+2d'), or 'now'. Renders to any IANA timezone in any of several preset formats including a 'relative' format ('3 hours ago'). Useful for log analysis, scheduling, and any agent task that touches timestamps. Pure compute, no API key.",
    schema,
    async ({ time, to_timezone = "UTC", to_format = "iso" }) => {
      try {
        if (!isValidTimezone(to_timezone)) {
          return errorResponse(`Invalid IANA timezone: '${to_timezone}'. Examples: 'UTC', 'America/Los_Angeles', 'Asia/Tokyo'.`);
        }

        const ms = parseFlexibleTime(time);
        if (ms === null) {
          return errorResponse(`Could not parse time: '${time}'. See tool description for accepted formats.`);
        }

        const formatted = formatInZone(ms, to_format, to_timezone);

        return successResponse({
          input: time,
          parsed_utc_iso: new Date(ms).toISOString(),
          unix_ms: ms,
          timezone: to_timezone,
          format: to_format,
          result: formatted,
        });
      } catch (err: any) {
        return errorResponse(err.message);
      }
    }
  );
}
