export type View =
  | "overview"
  | "skills"
  | "mcp"
  | "search"
  | "settings";

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
  confidence_threshold: number;
  first_run: boolean;
  rerank_key_env: boolean;
  rerank_base_env: boolean;
  rerank_model_env: boolean;
  auth_env: boolean;
  auth_enabled: boolean;
  index_dir: string;
}

export interface Stats {
  total: number;
  enabled: number;
  disabled: number;
  body_tokens: number;
  catalog_tokens: number;
  average_body: number;
  largest: number;
  heaviest: Array<{ name: string; tokens: number }>;
  embedding_coverage: {
    total: number;
    embedded: number;
  };
  tokens?: {
    jit: number;
    catalog: number;
    average_item: number;
    largest_item: number;
    saved: number;
    break_even: number;
  };
}

export interface SkillListItem {
  id: string;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  /** Full body tokens, fetched on demand. */
  tokens: number;
  /** What this entry's name and description cost in a plain catalog. */
  catalog_tokens: number;
  has_embedding: boolean;
  managed?: boolean;
}

/**
 * Where skills live on disk. Counted independently, so a skill that sits in a
 * local folder and in JIT's store appears in both numbers.
 */
export interface SkillSources {
  local: number;
  jit: number;
}

export interface SkillDetail {
  id: string;
  name: string;
  description: string;
  body: string;
  path: string;
  enabled: boolean;
  tokens: number;
}

export type McpStatus = "disconnected" | "connecting" | "connected" | "error";

export interface McpServerSummary {
  name: string;
  status: McpStatus;
  tool_count: number;
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

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  } | null;
}

/** A tool's raw result, as the MCP SDK returns it. */
export interface McpToolCallResult {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface ConfigPath {
  path: string;
  exists: boolean;
}

export interface NearMiss {
  id: string;
  name: string;
  description: string;
  score: number;
}

export interface SearchCandidate {
  id: string;
  name: string;
  description: string;
  cosine: number;
  picked: boolean;
  score: number;
  passes_threshold: boolean;
}

export interface SearchResult {
  id: string;
  name: string;
  description: string;
  content: string;
  /** Where the skill lives; sibling files are referenced relative to it. */
  path: string;
  confidence?: number;
  reranked: boolean;
  related?: string[];
}

export interface SearchResponse {
  results: SearchResult[];
  candidates: SearchCandidate[];
  near_misses: NearMiss[];
  reranked: boolean;
  warning?: string;
  ranking_warning?: string;
  threshold: number;
  elapsed_ms: number;
}

export interface DiscoveredSkill {
  id: string;
  name: string;
  path: string;
  description: string;
  /** Already indexed; importing again needs overwrite to replace a JIT copy. */
  in_jit: boolean;
  /** Set when the file could not be parsed as a skill. */
  error?: string;
}

export interface DiscoverSkillsResult {
  found: number;
  truncated: boolean;
  skills: DiscoveredSkill[];
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

export interface InstallResult {
  installed?: boolean;
  connected?: boolean;
  tools?: number;
  errors?: string[];
  error?: string;
  removed?: boolean;
}

/** The per-item account a batch endpoint returns: what changed and what did not. */
export interface BulkResult {
  action: string;
  ok: string[];
  failed: Array<{ id?: string; server?: string; error: string }>;
  files_removed?: number;
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
