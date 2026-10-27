export interface IndexItem {
  id: string;
  name: string;
  description: string;
  body: string;
  path: string;
  enabled?: boolean;
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
  path: string;
  enabled: boolean;
  /// Full body tokens, fetched on demand.
  tokens: number;
  /// What this entry's name and description cost in a plain catalog.
  catalog_tokens: number;
  has_embedding: boolean;
  managed?: boolean;
}

export interface HeaviestItem {
  name: string;
  tokens: number;
}

export interface Stats {
  total: number;
  enabled: number;
  disabled: number;
  body_tokens: number;
  catalog_tokens: number;
  average_body: number;
  largest: number;
  heaviest: HeaviestItem[];
  embedding_coverage: {
    total: number;
    embedded: number;
  };
  tokens?: {
    // What sits in context before any task runs, under each approach: JIT's
    // fixed tool schema against a plain catalog of every name and description.
    jit: number;
    catalog: number;
    // Informational: one body, fetched on demand by both approaches.
    average_item: number;
    largest_item: number;
    saved: number;
    // Entries required before JIT's tool schema beats a catalog of every entry
    // (schema / average catalog entry). Below this the index is a net cost.
    break_even: number;
  };
}

export interface Config {
  embedding_provider: "local" | "openai-compatible";
  embedding_local_model: string;
  embedding_local_dim: number;
  embedding_api_key: string;
  embedding_api_base: string;
  embedding_api_model: string;
  embedding_api_dim: number;
  rerank_api_key: string;
  rerank_api_base: string;
  rerank_model: string;
  api_key: string;
  confidence_threshold: number;
  first_run: boolean;
}

export interface PublicConfig extends Config {
  auth_env: boolean;
  auth_enabled: boolean;
  index_dir: string;
  embedding_model: string;
  embedding_dim: number;
  embedding_provider_env: boolean;
  embedding_key_env: boolean;
  embedding_base_env: boolean;
  embedding_model_env: boolean;
  embedding_dim_env: boolean;
  rerank_key_env: boolean;
  rerank_base_env: boolean;
  rerank_model_env: boolean;
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
  /** Set by the manager to detect a transport dying on its own. */
  onclose?: (() => void) | undefined;
  /** Set by the manager to record transport-level errors. */
  onerror?: ((error: unknown) => void) | undefined;
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
  /**
   * Bumped by disconnect() so an in-flight openConnection() can tell that its
   * target went away mid-connect and tear the client down instead of
   * overwriting the disconnect.
   */
  connectGen?: number;
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

export interface SearchCandidate {
  id: string;
  name: string;
  description: string;
  cosine: number;
  // Whether the reranker chose this candidate for the agent. Always false when
  // no reranker ran.
  picked: boolean;
  // The score the decision used: the cosine confidence when not reranked; 1 or
  // 0 when a reranker decided, because that choice is categorical.
  score: number;
  passes_threshold: boolean;
}

export interface NearMiss {
  id: string;
  name: string;
  description: string;
  score: number;
}

export interface SearchResult {
  id: string;
  name: string;
  description: string;
  content: string;
  // Where the skill lives. A skill is a directory, not just this body: half the
  // catalog references sibling files (scripts/, references/, assets/) by a path
  // relative to this one, so a body handed over without it cannot be followed.
  path: string;
  // Absent when a reranker decided: it made a categorical choice, so there is
  // no confidence number to report.
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

export interface ImportResult {
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
}
