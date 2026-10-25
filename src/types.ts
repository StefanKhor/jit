export type ItemKind = "skill" | "tool";

export interface IndexItem {
  id: string;
  name: string;
  description: string;
  when_to_use: string;
  categories: string[];
  aliases: string[];
  body: string;
  path: string;
  kind: ItemKind;
  enabled?: boolean;
  server?: string;
  params?: string[];
  required?: string[];
  schema?: Record<string, unknown>;
  // Where the entry came from (a catalog URL, "mcp:<server>", or undefined for
  // first-party local files). Not part of the content hash.
  source?: string;
}

export interface StoredItem extends IndexItem {
  enabled: boolean;
  content_hash: string;
  updated_at: string;
  embedding: Float32Array | null;
}

export interface ListItem {
  id: string;
  name: string;
  description: string;
  categories: string[];
  path: string;
  aliases: string[];
  kind: ItemKind;
  enabled: boolean;
  tokens: number;
  managed?: boolean;
}

export interface HeaviestItem {
  name: string;
  kind: ItemKind;
  tokens: number;
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
  heaviest: HeaviestItem[];
  categories: Array<{ name: string; count: number }>;
  tokens?: {
    // What sits in context before any task runs, under each approach: JIT's
    // fixed tool schema against a plain catalog of every name and description.
    jit: number;
    catalog: number;
    // Informational: one body, fetched on demand by both approaches.
    average_item: number;
    largest_item: number;
    saved: number;
    reduction_pct: number;
    // Entries required before JIT's tool schema beats a catalog of every entry
    // (schema / average catalog entry). Below this the index is a net cost.
    break_even: number;
  };
}

export interface Counts {
  total: number;
  skills: number;
  tools: number;
}

export interface Config {
  nebius_api_key: string;
  nebius_api_base: string;
  nemotron_nano_model: string;
  api_key: string;
  rerank_enabled: boolean;
  confidence_threshold: number;
  first_run: boolean;
  marketplace_urls: string[];
}

export interface PublicConfig extends Config {
  nebius_key_env: boolean;
  auth_env: boolean;
  auth_enabled: boolean;
  index_dir: string;
  embedding_model: string;
}

export interface Health {
  status: string;
  version: string;
  uptime_seconds: number;
  auth_required: boolean;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  environment?: Record<string, string>;
  cwd?: string;
  url?: string;
  serverUrl?: string;
  headers?: Record<string, string>;
  httpHeaders?: Record<string, string>;
  type?: string;
  enabled?: boolean;
  _source?: string;
}

export interface McpClientLike {
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export type McpStatus = "disconnected" | "connecting" | "connected" | "error";

export interface McpServerState {
  name: string;
  config: McpServerConfig;
  client: McpClientLike | null;
  transport: unknown;
  tools: McpTool[];
  status: McpStatus;
  error: string | null;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

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
  /** Which source this entry came from: a catalog URL or a repository. */
  origin?: string;
  checksum_present?: boolean;
  installed?: boolean;
  /** Install count when the entry came from the skills.sh directory. */
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

export interface SearchCandidate {
  id: string;
  name: string;
  description: string;
  kind: ItemKind;
  cosine: number;
  rrf: number;
  rerank: number | null;
  lexical: number;
  // The score the decision actually used: rerank when reranked, else cosine,
  // else the lexical fallback.
  score: number;
  passes_threshold: boolean;
}

export interface NearMiss {
  id: string;
  name: string;
  description: string;
  kind: ItemKind;
  score: number;
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

export type RetrievalDecision = "hit" | "miss";

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
  decision: RetrievalDecision;
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

export interface ImportResult {
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
}
