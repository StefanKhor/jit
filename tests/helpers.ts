// Shared test utilities. Not a test file itself — the npm script lists the
// `*.test.ts` files explicitly, so this is only imported.

import path from "node:path";

/**
 * A command string for the fake SkillSpector CLI, shaped like the real one:
 * `JIT_SKILLSPECTOR` accepts a command line, so a quoted interpreter plus script
 * path works exactly as a real `skillspector` would.
 */
export const FAKE_SKILLSPECTOR = [
  `"${process.execPath}"`,
  `"${path.resolve(import.meta.dirname, "fixtures", "fake-skillspector.mjs")}"`,
].join(" ");

export function respond(url: string, body: string, status = 200): Response {
  const response = new Response(body, { status });
  // A real fetch sets `url` to the final address; a stub must too, because the
  // fetch helper re-checks the scheme after redirects.
  Object.defineProperty(response, "url", { value: url });
  return response;
}

export interface FetchStub {
  seen: string[];
  restore: () => void;
}

/** Route a stubbed `fetch` by URL pattern; anything unmatched is a 404. */
export function stubFetch(
  routes: Array<[RegExp, (url: string) => Response]>,
): FetchStub {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as Request).url);
    seen.push(url);
    for (const [pattern, handler] of routes) {
      if (pattern.test(url)) return handler(url);
    }
    return respond(url, "not found", 404);
  }) as typeof fetch;
  return {
    seen,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
