import { assertRemoteUrl, fetchText } from "./remote.js";

// skills.sh is Vercel's public directory of agent skills. It exposes a small,
// read-only JSON API that JIT reads directly: full-text search and the ranked
// leaderboard. JIT does not crawl the site or re-derive its ranking; it asks the
// same endpoints the website asks. Installing still goes through the `skills`
// CLI (see skillsCli.ts), which owns source resolution and downloads.
const BASE_URL = (process.env.JIT_SKILLS_SH_URL || "https://www.skills.sh").trim();
const RESULT_LIMIT = 20;
const SEARCH_TTL_MS = 60_000;
const TOP_TTL_MS = 600_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 64;
const TIMEOUT_MS = 12_000;

const SEGMENT = /^[A-Za-z0-9._-]+$/;

export type TopView = "all-time" | "trending";

/** A listing on skills.sh, already reduced to what the CLI needs to install it. */
export interface SkillsShHit {
  /** `owner/repo` — the source the `skills` CLI resolves. */
  source: string;
  /** Skill directory inside the repository — the CLI's `--skill` name. */
  skill: string;
  name: string;
  installs: number;
  /** Weekly install counts, oldest first; empty when the listing has none. */
  weekly: number[];
  official: boolean;
}

export interface SkillsShRef {
  /** `owner/repo`. */
  source: string;
  /** Skill inside the repository, or an empty string for the whole repository. */
  skill: string;
}

export interface TopResult {
  hits: SkillsShHit[];
  total: number;
  hasMore: boolean;
  page: number;
  view: TopView;
}

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/**
 * `https://skills.sh/<owner>/<repo>[/<skill>]` — the address of a repository or
 * of a single skill on the directory. JIT turns it back into the `owner/repo`
 * source plus an optional skill name for the CLI.
 */
export function parseSkillsShRef(input: string): SkillsShRef | null {
  const url = skillsShUrl(input);
  if (!url) return null;

  const parts: string[] = [];
  for (const raw of url.pathname.split("/").filter(Boolean)) {
    const part = decode(raw);
    if (part === null) return null;
    parts.push(part);
  }
  const owner = parts[0] || "";
  const repo = (parts[1] || "").replace(/\.git$/i, "");
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return null;
  // A skill is addressed by name; the CLI cannot resolve a nested path.
  const skill = parts.slice(2).join("/");
  if (skill && !SEGMENT.test(skill)) return null;
  return { source: `${owner}/${repo}`, skill };
}

/** Whether a value is any URL on the directory, well-formed for us or not. */
export function isSkillsShUrl(input: string): boolean {
  return skillsShUrl(input) !== null;
}

export function isSkillsShRef(input: string): boolean {
  return parseSkillsShRef(input) !== null;
}

function skillsShUrl(value: string): URL | null {
  const text = String(value || "").trim();
  if (!/^https?:\/\//i.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  return host === "skills.sh" || host === "www.skills.sh" ? url : null;
}

function normalizeHit(raw: unknown): SkillsShHit | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const source = String(entry.source || "").trim();
  const skill = String(entry.skillId || entry.name || "").trim();
  const [owner, repo] = source.split("/");
  if (!owner || !repo || !SEGMENT.test(owner) || !SEGMENT.test(repo)) return null;
  if (!skill || !SEGMENT.test(skill)) return null;
  const installs = Number(entry.installs);
  const weekly = Array.isArray(entry.weeklyInstalls)
    ? entry.weeklyInstalls
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
    : [];
  return {
    source,
    skill,
    name: String(entry.name || skill).trim() || skill,
    installs: Number.isFinite(installs) ? installs : 0,
    weekly,
    official: Boolean(entry.isOfficial),
  };
}

function keep(hits: Array<SkillsShHit | null>): SkillsShHit[] {
  return hits.filter((hit): hit is SkillsShHit => hit !== null);
}

async function getJson(path: string, label: string): Promise<Record<string, unknown>> {
  const url = assertRemoteUrl(`${BASE_URL}${path}`, label);
  const body = await fetchText(url.toString(), {
    label,
    timeoutMs: TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
    headers: { accept: "application/json" },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${label} returned a response that is not JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} returned an unexpected response`);
  }
  return parsed as Record<string, unknown>;
}

function bound<T>(cache: Map<string, T>): void {
  // The key space is user-driven (search queries), so keep it bounded rather
  // than letting a long session grow the map without limit.
  if (cache.size < MAX_CACHE_ENTRIES) return;
  const oldest = cache.keys().next();
  if (!oldest.done) cache.delete(oldest.value);
}

const searchCache = new Map<string, { at: number; hits: SkillsShHit[] }>();
const topCache = new Map<
  string,
  { at: number; hits: SkillsShHit[]; total: number; hasMore: boolean; page: number }
>();

/** Full-text search over the directory, best-installed first. */
export async function searchSkillsSh(query: string): Promise<SkillsShHit[]> {
  const needle = String(query || "").trim();
  if (needle.length < 2) throw new Error("a search needs at least two characters");

  const cached = searchCache.get(needle);
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.hits;

  const data = await getJson(
    `/api/search?q=${encodeURIComponent(needle)}&limit=${RESULT_LIMIT}`,
    "skills.sh search",
  );
  const hits = keep((Array.isArray(data.skills) ? data.skills : []).map(normalizeHit));
  hits.sort((a, b) => b.installs - a.installs);
  bound(searchCache);
  searchCache.set(needle, { at: Date.now(), hits });
  return hits;
}

/**
 * The directory's own ranking. `all-time` is the lifetime install leaderboard;
 * `trending` is the recent-installs view. Pages hold up to 200 entries.
 */
export async function topSkills(view: TopView, page = 1): Promise<TopResult> {
  const current: TopView = view === "trending" ? "trending" : "all-time";
  const number = Number.isFinite(page)
    ? Math.min(50, Math.max(1, Math.floor(page)))
    : 1;
  const key = `${current}:${number}`;

  const cached = topCache.get(key);
  if (cached && Date.now() - cached.at < TOP_TTL_MS) {
    return {
      hits: cached.hits,
      total: cached.total,
      hasMore: cached.hasMore,
      page: cached.page,
      view: current,
    };
  }

  const data = await getJson(
    `/api/skills/${current}/${number}`,
    "skills.sh leaderboard",
  );
  const hits = keep((Array.isArray(data.skills) ? data.skills : []).map(normalizeHit));
  const total = Number(data.total);
  const result = {
    hits,
    total: Number.isFinite(total) ? total : hits.length,
    hasMore: Boolean(data.hasMore),
    page: number,
  };
  bound(topCache);
  topCache.set(key, { at: Date.now(), ...result });
  return { ...result, view: current };
}
