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
  nemotron_ultra_model: string;
  api_key: string;
  rerank_enabled: boolean;
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
    static: number;
    jit: number;
    startup: number;
    average_item: number;
    largest_item: number;
    saved: number;
    reduction_pct: number;
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
  installed?: boolean;
}

export interface MarketplaceResponse {
  items: MarketplaceItem[];
  source: string;
  warning: string;
}

export interface SearchCandidate {
  id: string;
  name: string;
  description: string;
  kind: ItemKind;
  cosine: number;
  rrf: number;
  rerank: number | null;
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
  server?: string;
  tool_id?: string;
}

export interface SearchResponse {
  result: SearchResult | null;
  candidates: SearchCandidate[];
  reranked: boolean;
  threshold: number;
  elapsed_ms: number;
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
  tools_removed?: number;
  removed?: boolean;
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
