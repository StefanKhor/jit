import type { TransferResult, View } from "./types";

export const viewLabels: Record<View, string> = {
  overview: "Overview",
  skills: "Skills",
  mcp: "MCP",
  search: "Search",
  settings: "Settings",
};

/**
 * The sections the console shows today. Every view still exists and is wired
 * up — MCP included — but the product is skill-first for now, so mcp is kept
 * out of the navigation. Move a name back in here to surface it again.
 */
export const NAV_VIEWS: View[] = [
  "overview",
  "skills",
  "search",
  "settings",
];

export function fmt(value: unknown): string {
  return new Intl.NumberFormat("en-US").format(Math.round(Number(value) || 0));
}

export function pct(part: number, total: number): number {
  return total ? Math.min(100, (part / total) * 100) : 0;
}

export function summary(result: TransferResult): string {
  const parts: string[] = [];
  if (result.found != null) parts.push(`${fmt(result.found)} files found`);
  if (Array.isArray(result.copied) && result.copied.length) {
    parts.push(`${fmt(result.copied.length)} copied`);
  }
  if (result.added) parts.push(`${fmt(result.added)} added`);
  if (result.updated) parts.push(`${fmt(result.updated)} updated`);
  if (result.skipped) parts.push(`${fmt(result.skipped)} unchanged`);
  const errors = result.errors || [];
  if (errors.length) {
    parts.push(`${errors.length} error${errors.length === 1 ? "" : "s"}`);
  }
  return (
    (parts.join(" · ") || "Nothing changed.") +
    (errors.length ? ` — ${errors[0]}` : "")
  );
}
