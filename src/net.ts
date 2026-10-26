/**
 * True when a URL points at the loopback interface. Local endpoints are
 * trusted: they may omit an API key. Used by the embeddings, rerank, and
 * dashboard config paths so the definition of "local" cannot drift.
 */
export function isLocalEndpoint(value: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      new URL(value).hostname.toLowerCase(),
    );
  } catch {
    return false;
  }
}
