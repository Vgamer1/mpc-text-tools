import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../../lib/responses.js";
import { registerToolWithLimits } from "../../lib/register.js";
import type { Bindings } from "../../types.js";

// ─────────────────────────────────────────────
// hash_compute — cryptographic hashes and common encodings.
//
// Why this tool exists: LLMs are unreliable at character-level transforms
// (hex digits, base64 padding, escaping). Offloading these to deterministic
// code is a correctness win for any agent that needs cache keys, dedup,
// idempotency keys, or signature inputs.
//
// Uses Workers' built-in WebCrypto + atob/btoa. No external deps.
//
// MD5 is intentionally NOT included. WebCrypto doesn't expose it (it's
// not a recommended primitive), and including a userland MD5 is the
// kind of thing that becomes a security issue when someone uses it for
// auth. SHA-1 is included reluctantly — also not recommended for new
// applications, but still common in tooling.
// ─────────────────────────────────────────────

const HASH_ALGOS = ["sha256", "sha384", "sha512", "sha1"] as const;
const ENCODINGS = ["base64", "base64url", "hex", "url"] as const;
const OPERATIONS = ["encode", "decode"] as const;

/** Convert a Uint8Array to lowercase hex without intermediate string concat. */
function bufToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const hex = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    hex[i] = bytes[i].toString(16).padStart(2, "0");
  }
  return hex.join("");
}

/** Convert ArrayBuffer to base64 via btoa (Workers has it globally). */
function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  // Build the binary string in chunks to avoid RangeError on very large
  // arrays from String.fromCharCode(...giant_array).
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 → base64url (URL- and filename-safe variant). */
function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url → base64 (re-add padding, swap chars back). */
function fromBase64Url(b64url: string): string {
  const padded = b64url + "=".repeat((4 - (b64url.length % 4)) % 4);
  return padded.replace(/-/g, "+").replace(/_/g, "/");
}

const schema = {
  operation: z.enum(["hash", ...OPERATIONS]).describe("Operation to perform: 'hash' computes a digest, 'encode' / 'decode' transform between text and an encoding."),
  input:     z.string().max(1_000_000).describe("The input string to hash, encode, or decode."),
  algorithm: z.enum(HASH_ALGOS).optional().describe("Hash algorithm (only used when operation='hash'). Default: 'sha256'. Note: SHA-1 is included for legacy compatibility but is not recommended for new use."),
  encoding:  z.enum(ENCODINGS).optional().describe("Encoding scheme (only used when operation='encode' or 'decode'). 'base64', 'base64url' (URL-safe), 'hex', or 'url' (percent-encoding). Default: 'base64'."),
  output_encoding: z.enum(["hex", "base64", "base64url"]).optional().describe("Output encoding for hash digests (only used when operation='hash'). Default: 'hex'."),
};

type Args = {
  operation: "hash" | "encode" | "decode";
  input: string;
  algorithm?: typeof HASH_ALGOS[number];
  encoding?: typeof ENCODINGS[number];
  output_encoding?: "hex" | "base64" | "base64url";
};

export function register(server: McpServer, env: Bindings) {
  registerToolWithLimits<Args>(
    server,
    env,
    "hash_compute",
    "Compute cryptographic hashes (SHA-256, SHA-384, SHA-512, SHA-1) or encode/decode strings (base64, base64url, hex, URL percent-encoding). Useful for cache keys, dedup, idempotency keys, signing inputs, and any agent task that needs deterministic character-level transforms — operations LLMs themselves get wrong surprisingly often. Pure compute, no API key.",
    schema,
    async ({ operation, input, algorithm = "sha256", encoding = "base64", output_encoding = "hex" }) => {
      try {
        // ── Hashing ──
        if (operation === "hash") {
          // WebCrypto algorithm names are dashed and uppercase.
          const wcAlgo =
            algorithm === "sha256" ? "SHA-256" :
            algorithm === "sha384" ? "SHA-384" :
            algorithm === "sha512" ? "SHA-512" :
            "SHA-1";

          const data = new TextEncoder().encode(input);
          const digest = await crypto.subtle.digest(wcAlgo, data);

          let result: string;
          if (output_encoding === "hex") {
            result = bufToHex(digest);
          } else if (output_encoding === "base64") {
            result = bufToBase64(digest);
          } else {
            result = toBase64Url(bufToBase64(digest));
          }

          return successResponse({
            operation: "hash",
            algorithm,
            output_encoding,
            input_length: input.length,
            result,
          });
        }

        // ── Encoding ──
        if (operation === "encode") {
          let result: string;
          switch (encoding) {
            case "base64":
              result = bufToBase64(new TextEncoder().encode(input).buffer);
              break;
            case "base64url":
              result = toBase64Url(bufToBase64(new TextEncoder().encode(input).buffer));
              break;
            case "hex":
              result = bufToHex(new TextEncoder().encode(input).buffer);
              break;
            case "url":
              result = encodeURIComponent(input);
              break;
          }
          return successResponse({ operation: "encode", encoding, result });
        }

        // ── Decoding ──
        if (operation === "decode") {
          let bytes: Uint8Array;
          try {
            switch (encoding) {
              case "base64": {
                const binary = atob(input);
                bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                break;
              }
              case "base64url": {
                const binary = atob(fromBase64Url(input));
                bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                break;
              }
              case "hex": {
                if (input.length % 2 !== 0) {
                  return errorResponse("Hex input must have an even length.");
                }
                if (!/^[0-9a-fA-F]*$/.test(input)) {
                  return errorResponse("Hex input contains non-hexadecimal characters.");
                }
                bytes = new Uint8Array(input.length / 2);
                for (let i = 0; i < bytes.length; i++) {
                  bytes[i] = parseInt(input.substr(i * 2, 2), 16);
                }
                break;
              }
              case "url":
                return successResponse({
                  operation: "decode",
                  encoding,
                  result: decodeURIComponent(input),
                });
            }
          } catch (err: any) {
            return errorResponse(`Failed to decode as ${encoding}: ${err.message}`);
          }

          // For binary encodings, attempt UTF-8 decode but warn if input isn't text.
          // The fatal:false flag means invalid UTF-8 produces replacement chars
          // instead of throwing; we report whether the result is "clean" UTF-8.
          const cleanDecoder = new TextDecoder("utf-8", { fatal: true });
          let resultText: string;
          let isText: boolean;
          try {
            resultText = cleanDecoder.decode(bytes!);
            isText = true;
          } catch {
            resultText = new TextDecoder("utf-8").decode(bytes!);
            isText = false;
          }

          return successResponse({
            operation: "decode",
            encoding,
            result: resultText,
            is_valid_utf8: isText,
            byte_length: bytes!.length,
          });
        }

        return errorResponse(`Unknown operation: ${operation}`);
      } catch (err: any) {
        return errorResponse(err.message);
      }
    }
  );
}
