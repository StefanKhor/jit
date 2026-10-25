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
  embedding_provider: "local" | "openai-compatible";
  embedding_local_model: string;
  embedding_local_dim: number;
  embedding_api_key: string;
  embedding_api_base: string;
  embedding_api_model: string;
  embedding_api_dim: number;
  embedding_model: string;
  embedding_dim: number;
  embedding_provider_env: boolean;
  embedding_key_env: boolean;
  embedding_base_env: boolean;
  embedding_model_env: boolean;
  embedding_dim_env: boolean;
  rerank_api_key: string;
  rerank_api_base: string;
  rerank_model: string;
  api_key: string;
  rerank_enabled: boolean;
  confidence_threshold: number;
  first_run: boolean;
  marketplace_urls: string[];
  skillspector_llm_enabled: boolean;
  skillspector_llm_env: boolean;
  rerank_key_env: boolean;
  rerank_base_env: boolean;
  rerank_model_env: boolean;
  auth_env: boolean;
  auth_enabled: boolean;
  index_dir: string;
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
  embedding_coverage: {
    skills_total: number;
    skills_embedded: number;
    tools_total: number;
    tools_embedded: number;
  };
  tokens: {
    jit: number;
    catalog: number;
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
  /** Full body tokens, fetched on demand. */
  tokens: number;
  /** What this entry's name and description cost in a plain catalog. */
  catalog_tokens: number;
  has_embedding: boolean;
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
  weekly_installs?: number[];
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
  page_size: number;
  has_more: boolean;
  total: number;
}

export interface ScanFinding {
  level: "critical" | "high" | "medium" | "low";
  rule: string;
  detail: string;
  category?: string;
  pattern?: string;
  confidence?: number;
  explanation?: string;
  remediation?: string;
  snippet?: string;
  code_snippet?: string;
  intent?: string;
  tags?: string[];
  location?: {
    file: string;
    start_line?: number;
    end_line?: number;
  };
  evidence?: Record<string, unknown>;
  /** Which scanner produced the finding. */
  scanner?: "builtin" | "skillspector";
}

export interface ScanReport {
  ok: boolean;
  requires_ack: boolean;
  findings: ScanFinding[];
  /** The phase the install gate acts on. */
  gate?: "allow" | "ack" | "block";
  risk_score?: number;
  severity?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  recommendation?: "SAFE" | "CAUTION" | "DO_NOT_INSTALL";
  safe_to_install?: boolean;
  llm_used?: boolean;
  scanner_available?: boolean;
  scanner_source?: "env" | "path" | "uvx" | "off" | "none";
  scanner_version?: string;
  scanners?: string[];
  /** How to install the scanner, or why a full scan was not possible. */
  note?: string;
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
  warning?: string;
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
  scan_report?: ScanReport;
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
