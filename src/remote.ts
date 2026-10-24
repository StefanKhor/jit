import { createHash } from "node:crypto";

import { MAX_SKILL_BYTES } from "./config.js";

// URLs JIT will fetch on a user's behalf: catalog files and skill bodies. The
// policy is the same everywhere — HTTPS, or plain HTTP only for loopback during
// development — so it lives in one place instead of being re-implemented per
// call site.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname);
}

export function assertRemoteUrl(value: string, label = "URL"): URL {
  const parsed = new URL(value);
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:" && isLoopback(parsed.hostname)) return parsed;
  throw new Error(
    `${label} must use https:// (http:// is allowed only for localhost)`,
  );
}

export interface FetchTextOptions {
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  expectedSha256?: string;
  label?: string;
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// Fetch a text resource with a size ceiling and an optional checksum. Returns
// the body; throws a message that names the resource so callers can surface it.
export async function fetchText(
  url: string,
  options: FetchTextOptions = {},
): Promise<string> {
  const {
    maxBytes = MAX_SKILL_BYTES,
    timeoutMs = 20_000,
    headers,
    expectedSha256 = "",
    label = "URL",
  } = options;

  assertRemoteUrl(url, label);
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    ...(headers ? { headers } : {}),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  assertRemoteUrl(response.url, `${label} redirect`);

  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    throw new Error(`${label} is larger than the size limit`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`${label} is larger than the size limit`);
      }
      chunks.push(value);
    }
  }
  const data = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (expectedSha256) {
    const digest = sha256(data);
    if (digest.toLowerCase() !== expectedSha256.trim().toLowerCase()) {
      throw new Error(`${label} checksum does not match the catalog`);
    }
  }
  return data.toString("utf8");
}
