export type View =
  | "overview"
  | "skills"
  | "marketplace"
  | "mcp"
  | "search"
  | "settings";

export type ItemKind = "skill" | "tool";

export interface Health {
  status: string;
  version: string;
  uptime_seconds: number;
  auth_required: boolean;
}

export interface PublicConfig {
  nebius_api_key: string;
  nebius_api_base: string;
  nemotron_nano_model: string;
  api_key: string;
  rerank_enabled: boolean;
  confidence_threshold: number;
  first_run: boolean;
  marketplace_urls: string[];
  nebius_key_env: boolean;
  auth_env: boolean;
  auth_enabled: boolean;
  index_dir: string;
  embedding_model: string;
}

export interface Stats {
  total: number;
  skills: number;
  tools: number;
  enabled: number;
  disabled: number;
  body_tokens: number;
  catalog_tokens: number;
  average_body: number;
  largest: number;
  heaviest: Array<{ name: string; kind: ItemKind; tokens: number }>;
  categories: Array<{ name: string; count: number }>;
  tokens: {
    jit: number;
    baseline: number;
    catalog: number;
    startup: number;
    average_item: number;
    largest_item: number;
    saved: number;
    reduction_pct: number;
    break_even: number;
  };
  retrieval?: {
    total: number;
    misses: number;
    miss_rate: number;
  };
}

export interface SkillListItem {
  id: string;
  name: string;
  description: string;
  categories: string[];
  path: string;
  aliases: string[];
  kind: ItemKind;
  enabled: boolean;
  tokens: number;
  managed: boolean;
}

export interface SkillDetail {
  id: string;
  name: string;
  description: string;
  when_to_use: string;
  categories: string[];
  aliases: string[];
  body: string;
  path: string;
  kind: ItemKind;
  enabled: boolean;
  server?: string;
  params?: string[];
  required?: string[];
  schema?: Record<string, unknown>;
  tokens: number;
}

export type McpStatus = "disconnected" | "connecting" | "connected" | "error";

export interface McpServerSummary {
  name: string;
  status: McpStatus;
  tool_count: number;
  indexed_tool_count: number;
  error: string | null;
  source?: string;
}

export interface McpImportServer {
  name: string;
  source: string;
  command: string;
  url: string;
  managed: boolean;
}

export interface ConfigPath {
  path: string;
  exists: boolean;
}

export interface MarketplaceInput {
  key: string;
  label?: string;
  type?: string;
  default?: string;
  required?: boolean;
  secret?: boolean;
  help?: string;
}

export interface MarketplaceItem {
  id: string;
  kind: "skill" | "mcp";
  name: string;
  description: string;
  category: string;
  author?: string;
  license?: string;
  source?: string;
  requires?: string;
  inputs: MarketplaceInput[];
  install: Record<string, unknown>;
  origin?: string;
  checksum_present?: boolean;
  installed?: boolean;
  installs?: number;
}

export interface MarketplaceResponse {
  items: MarketplaceItem[];
  source: string;
  warning: string;
}

/** Results from the skills.sh directory: search hits or the ranked leaderboard. */
export interface MarketplaceDiscovery {
  items: MarketplaceItem[];
  warning: string;
}

export interface MarketplaceTopResponse extends MarketplaceDiscovery {
  view: string;
  page: number;
  has_more: boolean;
  total: number;
}

export interface ScanFinding {
  level: "high" | "medium" | "low";
  rule: string;
  detail: string;
}

export interface ScanReport {
  ok: boolean;
  requires_ack: boolean;
  findings: ScanFinding[];
}

export interface InspectResult {
  id: string;
  kind: "skill" | "mcp";
  checksum_required: boolean;
  checksum_present: boolean;
  report: ScanReport;
}

export interface NearMiss {
  id: string;
  name: string;
  description: string;
  kind: ItemKind;
  score: number;
}

export interface SearchCandidate {
  id: string;
  name: string;
  description: string;
  kind: ItemKind;
  cosine: number;
  rrf: number;
  rerank: number | null;
  lexical: number;
  score: number;
  passes_threshold: boolean;
}

export interface SearchResult {
  id: string;
  name: string;
  kind: ItemKind;
  description: string;
  content: string;
  confidence: number;
  reranked: boolean;
  keyword_only?: boolean;
  source?: string;
  trust?: "first-party" | "third-party";
  server?: string;
  tool_id?: string;
}

export interface SearchResponse {
  result: SearchResult | null;
  candidates: SearchCandidate[];
  near_misses: NearMiss[];
  reranked: boolean;
  keyword_only: boolean;
  threshold: number;
  elapsed_ms: number;
}

export interface RetrievalLogEntry {
  id: number;
  ts: string;
  source: string;
  intent: string;
  best_id: string;
  best_name: string;
  score: number;
  cosine: number;
  rerank: number | null;
  lexical: number;
  candidates: number;
  decision: "hit" | "miss";
  keyword_only: boolean;
  elapsed_ms: number;
}

export interface RetrievalStats {
  total: number;
  hits: number;
  misses: number;
  miss_rate: number;
  keyword_only: number;
  threshold: number;
  recent: RetrievalLogEntry[];
  misses_recent: RetrievalLogEntry[];
  top_misses: Array<{ intent: string; count: number; best_name: string }>;
}

export interface TransferResult {
  mode?: "copy" | "link";
  found?: number;
  copied?: string[];
  added?: number;
  updated?: number;
  skipped?: number;
  errors?: string[];
}

export interface ExportSkillsResult {
  exported: Array<{ id: string; path: string }>;
  skipped: string[];
  errors: string[];
  destination: string;
}

export interface ExportMcpResult {
  exported: string[];
  skipped: string[];
  errors: string[];
  path: string;
  format: string;
}

export interface InstallResult {
  ok?: boolean;
  id?: string;
  kind?: "skill" | "mcp";
  installed?: boolean;
  connected?: boolean;
  added?: number;
  updated?: number;
  skipped?: number;
  errors?: string[];
  error?: string;
  warnings?: ScanFinding[];
  tools_removed?: number;
  removed?: boolean;
}

/** The per-item account a batch endpoint returns: what changed and what did not. */
export interface BulkResult {
  action: string;
  ok: string[];
  failed: Array<{ id?: string; server?: string; error: string }>;
  files_removed?: number;
  tools?: Record<string, number>;
}

export interface IndexExport {
  version: number;
  exported_at: number;
  items: Array<Record<string, unknown>>;
}

export type ToastKind = "ok" | "error";

export interface ToastMessage {
  id: number;
  message: string;
  kind: ToastKind;
}

export interface ConfirmRequest {
  title: string;
  text: string;
  label: string;
  resolve: (value: boolean) => void;
}
