// A GitHub repository can act as a marketplace source. JIT does not read the
// repository itself: it validates the reference and hands it to the `skills`
// CLI (see skillsCli.ts), which resolves the source and downloads the skills.

const SEGMENT = /^[A-Za-z0-9._-]+$/;

export interface GithubRef {
  owner: string;
  repo: string;
  /** Branch, tag, or commit; empty means the repository default branch. */
  ref: string;
  /** Directory inside the repository to treat as the marketplace root. */
  subpath: string;
}

/** `owner/repo`, `owner/repo@ref#subdir`, or a github.com URL. */
export function parseGithubRef(input: string): GithubRef | null {
  const value = String(input || "").trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0] || "";
    const repo = (parts[1] || "").replace(/\.git$/i, "");
    if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return null;
    if (parts[2] === "tree" && parts.length >= 4) {
      return {
        owner,
        repo,
        ref: decodeURIComponent(parts[3] || ""),
        subpath: parts
          .slice(4)
          .map((part) => decodeURIComponent(part))
          .join("/"),
      };
    }
    return { owner, repo, ref: "", subpath: "" };
  }

  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:@([^\s#]+))?(?:#(\S*))?$/.exec(
    value,
  );
  if (!match) return null;
  return {
    owner: match[1] || "",
    repo: match[2] || "",
    ref: match[3] || "",
    subpath: (match[4] || "").replace(/^\/+|\/+$/g, ""),
  };
}

export function isGithubRef(input: string): boolean {
  return parseGithubRef(input) !== null;
}
