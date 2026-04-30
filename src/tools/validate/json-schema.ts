import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Validator } from "@cfworker/json-schema";
import { successResponse, errorResponse } from "../../lib/responses.js";
import { registerToolWithLimits } from "../../lib/register.js";
import type { Bindings } from "../../types.js";

// ─────────────────────────────────────────────
// validate_json_schema — validate JSON values against JSON Schema.
//
// Pairs naturally with text_extract_json: extract → validate → branch.
// This is the loop that makes structured-output agent pipelines reliable
// — extract a JSON value from LLM output, validate it against the
// expected schema, and re-prompt with the specific errors if invalid.
//
// Dependency: @cfworker/json-schema. Chosen over ajv because:
//   • Built specifically for Workers (no codegen, small bundle)
//   • Supports JSON Schema drafts 4, 7, 2019-09, and 2020-12
//   • No 'unsafe-eval' CSP requirements (ajv generates code at runtime)
//   • ~30KB minified vs ajv's ~120KB
//
// Both `value` and `schema` are accepted as JSON strings rather than
// raw objects. This is intentional: MCP tool args are typed by zod,
// and accepting `z.any()` for arbitrary JSON would lose validation on
// the wire. Strings are unambiguous and let the caller pre-stringify
// as they see fit.
// ─────────────────────────────────────────────

const DRAFTS = ["4", "7", "2019-09", "2020-12"] as const;

const schema = {
  value:  z.string().max(1_000_000).describe("The JSON value to validate, as a JSON-encoded string. Example: '{\"name\":\"alice\",\"age\":30}'"),
  schema: z.string().max(500_000).describe("The JSON Schema to validate against, as a JSON-encoded string. Example: '{\"type\":\"object\",\"required\":[\"name\"],\"properties\":{\"name\":{\"type\":\"string\"}}}'"),
  draft:  z.enum(DRAFTS).optional().describe("JSON Schema draft to use. Default: '2020-12' (the current standard). Use '7' for the most common older draft, '4' for legacy."),
};

type Args = {
  value: string;
  schema: string;
  draft?: typeof DRAFTS[number];
};

export function register(server: McpServer, env: Bindings) {
  registerToolWithLimits<Args>(
    server,
    env,
    "validate_json_schema",
    "Validate a JSON value against a JSON Schema. Returns whether it's valid and, if not, a list of structured errors with the path and reason for each violation. Pairs with text_extract_json for the standard 'extract → validate → branch' agent pipeline pattern. Supports JSON Schema drafts 4, 7, 2019-09, and 2020-12. Pure compute, no API key.",
    schema,
    async ({ value, schema: schemaStr, draft = "2020-12" }) => {
      try {
        // Parse both inputs as JSON. Either can fail — surface which one
        // so callers can fix the right thing.
        let parsedValue: unknown;
        let parsedSchema: object;

        try {
          parsedValue = JSON.parse(value);
        } catch (err: any) {
          return errorResponse(`'value' is not valid JSON: ${err.message}`);
        }

        try {
          const s = JSON.parse(schemaStr);
          if (typeof s !== "object" || s === null || Array.isArray(s)) {
            return errorResponse("'schema' must be a JSON object.");
          }
          parsedSchema = s;
        } catch (err: any) {
          return errorResponse(`'schema' is not valid JSON: ${err.message}`);
        }

        // The validator throws on schemas that are themselves malformed (e.g.,
        // unknown keywords with strict mode, invalid $ref). Catch and report.
        let validator: Validator;
        try {
          validator = new Validator(parsedSchema as any, draft);
        } catch (err: any) {
          return errorResponse(`Invalid JSON Schema: ${err.message}`);
        }

        const result = validator.validate(parsedValue);

        if (result.valid) {
          return successResponse({
            valid: true,
            draft,
          });
        }

        // Normalize errors into a consistent structured shape. The validator
        // returns OutputUnit objects with instanceLocation (path in the value)
        // and keywordLocation (path in the schema), among others.
        const errors = result.errors.map((e: any) => ({
          path:           e.instanceLocation ?? "",
          schema_path:    e.keywordLocation ?? "",
          message:        e.error ?? "validation error",
        }));

        return successResponse({
          valid: false,
          draft,
          error_count: errors.length,
          errors,
        });
      } catch (err: any) {
        return errorResponse(err.message);
      }
    }
  );
}
