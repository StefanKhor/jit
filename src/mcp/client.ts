import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  atomicWriteFile,
  MCP_CONFIG,
  readJsonFile,
  VERSION,
} from "../config.js";
import { logger } from "../logger.js";
import type {
  IndexItem,
  McpImportServer,
  McpServerConfig,
  McpServerState,
  McpClientLike,
  McpServerSummary,
  McpStatus,
  McpTool,
} from "../types.js";

const CONNECT_TIMEOUT = 45_000;
const CALL_TIMEOUT = 120_000;
const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function resultPayload(result: Record<string, unknown>): Record<string, unknown> {
  const isError = Boolean(result.isError);
  const blocks = Array.isArray(result.content) ? result.content : [];
  if (blocks.length === 0) {
    return { content: result.structuredContent ?? null, is_error: isError };
  }
  const texts = blocks
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(
          block &&
            typeof block === "object" &&
            (block as { type?: unknown }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string",
        ),
    )
    .map((block) => block.text);
  if (texts.length === blocks.length) {
    return { content: texts.join("\n"), is_error: isError };
  }
  return { content: blocks, is_error: isError };
}

export class MCPClientManager {
  private readonly servers = new Map<string, McpServerState>();
  private readonly connecting = new Map<string, Promise<boolean>>();

  static externalConfigPaths(): string[] {
    const home = homedir();
    const paths = [
      path.join(home, ".cursor", "mcp.json"),
      path.join(home, ".claude.json"),
      path.join(home, ".config", "opencode", "opencode.json"),
      path.join(process.cwd(), ".mcp.json"),
      path.join(process.cwd(), "mcp.json"),
    ];
    if (platform() === "darwin") {
      paths.push(
        path.join(
          home,
          "Library",
          "Application Support",
          "Claude",
          "claude_desktop_config.json",
        ),
      );
    } else if (platform() === "win32") {
      paths.push(
        path.join(
          home,
          "AppData",
          "Roaming",
          "Claude",
          "claude_desktop_config.json",
        ),
      );
    }
    return paths;
  }

  static normalizeConfig(input: unknown): McpServerConfig | null {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const source = input as Record<string, unknown>;
    const config: McpServerConfig = {};
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith("_") || UNSAFE_KEYS.has(key)) continue;
      (config as Record<string, unknown>)[key] = value;
    }

    const command: unknown = config.command;
    if (Array.isArray(command)) {
      if (command.length === 0) return null;
      config.command = String(command[0]);
      config.args = [
        ...command.slice(1).map(String),
        ...(Array.isArray(config.args) ? config.args.map(String) : []),
      ];
    } else if (command !== undefined && typeof command !== "string") {
      return null;
    }

    if (config.environment && !config.env) {
      config.env = config.environment as Record<string, string>;
      delete (config as Record<string, unknown>).environment;
    }
    if (config.enabled === false) return null;
    if (!config.command && !(config.url || config.serverUrl)) return null;

    if (config.args !== undefined && !Array.isArray(config.args)) return null;
    config.args = Array.isArray(config.args) ? config.args.map(String) : [];

    const env = config.env;
    if (env !== undefined && (typeof env !== "object" || Array.isArray(env))) {
      return null;
    }
    if (env && typeof env === "object") {
      config.env = Object.fromEntries(
        Object.entries(env as Record<string, unknown>).map(([key, value]) => [
          String(key),
          String(value),
        ]),
      );
    }

    const headers = config.headers || config.httpHeaders;
    if (headers !== undefined && (typeof headers !== "object" || Array.isArray(headers))) {
      return null;
    }
    if (headers && typeof headers === "object") {
      config.headers = Object.fromEntries(
        Object.entries(headers as Record<string, unknown>).map(([key, value]) => [
          String(key),
          String(value),
        ]),
      );
    }
    if (config.url) config.url = String(config.url);
    if (config.serverUrl) config.serverUrl = String(config.serverUrl);
    if (config.type) config.type = String(config.type);
    if (config.cwd) config.cwd = String(config.cwd);
    return config;
  }

  static readConfigPaths(paths: string[]): Map<string, McpServerConfig> {
    const discovered = new Map<string, McpServerConfig>();
    for (const rawPath of paths) {
      const file = rawPath.replace(/^~(?=$|\/)/, homedir());
      if (!existsSync(file)) continue;
      let data: Record<string, unknown>;
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          continue;
        }
        data = parsed as Record<string, unknown>;
      } catch (error) {
        logger.debug("skipping unreadable MCP config %s: %s", file, errorMessage(error));
        continue;
      }

      let servers: unknown = data.mcpServers;
      if (servers === undefined) {
        const section = data.mcp;
        if (section && typeof section === "object" && !Array.isArray(section)) {
          const mcp = section as Record<string, unknown>;
          servers =
            mcp.servers && typeof mcp.servers === "object"
              ? mcp.servers
              : mcp;
        }
      }
      if (Array.isArray(servers)) {
        servers = Object.fromEntries(
          servers
            .filter(
              (entry): entry is Record<string, unknown> =>
                Boolean(entry && typeof entry === "object"),
            )
            .map((entry) => [String(entry.name || ""), entry]),
        );
      }
      if (!servers || typeof servers !== "object") continue;

      for (const [name, rawConfig] of Object.entries(
        servers as Record<string, unknown>,
      )) {
        if (!name || discovered.has(name)) continue;
        const config = MCPClientManager.normalizeConfig(rawConfig);
        if (!config) continue;
        discovered.set(name, { ...config, _source: file });
      }
    }
    return discovered;
  }

  async loadConfigs(configPaths?: string[]): Promise<string[]> {
    const paths = configPaths ?? [MCP_CONFIG];
    const discovered = MCPClientManager.readConfigPaths(paths);

    for (const [name, config] of discovered) {
      const state = this.servers.get(name);
      if (!state) {
        this.servers.set(name, {
          name,
          config,
          client: null,
          transport: null,
          tools: [],
          status: "disconnected",
          error: null,
        });
      } else if (state.status === "disconnected" || state.status === "error") {
        state.config = config;
      }
    }

    for (const [name, state] of [...this.servers]) {
      if (
        configPaths === undefined &&
        state.config._source === MCP_CONFIG &&
        !discovered.has(name)
      ) {
        await this.disconnect(name);
        this.servers.delete(name);
      }
    }
    return [...discovered.keys()].sort();
  }

  externalServers(): McpImportServer[] {
    const discovered = MCPClientManager.readConfigPaths(
      MCPClientManager.externalConfigPaths(),
    );
    const managed = new Set(this.servers.keys());
    for (const name of Object.keys(this.managedServers())) managed.add(name);
    return [...discovered.entries()]
      .map(([name, config]) => ({
        name,
        source: config._source || "",
        command: config.command || "",
        url: config.url || config.serverUrl || "",
        managed: managed.has(name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async importServers(
    entries: Array<{ name?: string; source?: string }>,
  ): Promise<{ imported: string[]; skipped: string[]; errors: string[] }> {
    const external = MCPClientManager.readConfigPaths(
      MCPClientManager.externalConfigPaths(),
    );
    const imported: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push("invalid server entry");
        continue;
      }
      const name = String(entry.name || "").trim();
      const source = String(entry.source || "").trim();
      const config = external.get(name);
      if (!config || (source && config._source !== source)) {
        errors.push(`${name || "unknown"}: not found in client configs`);
        continue;
      }
      if (this.servers.has(name) || name in this.managedServers()) {
        skipped.push(name);
        continue;
      }
      if (this.addServer(name, config)) imported.push(name);
      else errors.push(`${name}: invalid server config`);
    }
    return { imported, skipped, errors };
  }

  managedServers(): Record<string, McpServerConfig> {
    const data = readJsonFile<Record<string, unknown>>(MCP_CONFIG, {});
    const servers = data.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(servers as Record<string, unknown>)
        .filter(([, config]) => Boolean(config && typeof config === "object"))
        .map(([name, config]) => [name, config as McpServerConfig]),
    );
  }

  private writeManagedServers(servers: Record<string, McpServerConfig>): void {
    const parsed = readJsonFile<unknown>(MCP_CONFIG, {});
    const existing =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    existing.mcpServers = servers;
    atomicWriteFile(
      MCP_CONFIG,
      JSON.stringify(existing, null, 2) + "\n",
      0o600,
    );
  }

  addServer(name: string, config: unknown): boolean {
    const safeName = String(name || "").trim();
    if (!SERVER_NAME_RE.test(safeName) || safeName.includes("__")) return false;
    const normalized = MCPClientManager.normalizeConfig(config);
    if (!normalized) return false;

    this.disconnect(safeName);
    const managed = this.managedServers();
    managed[safeName] = normalized;
    this.writeManagedServers(managed);
    this.servers.set(safeName, {
      name: safeName,
      config: { ...normalized, _source: MCP_CONFIG },
      client: null,
      transport: null,
      tools: [],
      status: "disconnected",
      error: null,
    });
    return true;
  }

  removeServer(name: string): boolean {
    const safeName = String(name || "").trim();
    this.disconnect(safeName);
    const managed = this.managedServers();
    const existed = safeName in managed || this.servers.has(safeName);
    if (safeName in managed) {
      delete managed[safeName];
      this.writeManagedServers(managed);
    }
    this.servers.delete(safeName);
    return existed;
  }

  async connect(name: string, timeout = CONNECT_TIMEOUT): Promise<boolean> {
    const state = this.servers.get(name);
    if (!state) return false;
    if (state.status === "connected") return true;

    const inFlight = this.connecting.get(name);
    if (inFlight) return inFlight;

    const promise = this.openConnection(state, timeout).finally(() => {
      this.connecting.delete(name);
    });
    this.connecting.set(name, promise);
    return promise;
  }

  private async openConnection(
    state: McpServerState,
    timeout: number,
  ): Promise<boolean> {
    state.status = "connecting";
    state.error = null;
    let client: Client | null = null;
    let transport: Transport | null = null;

    try {
      const config = state.config;
      if (config.command) {
        const env = {
          ...stringEnv(process.env),
          ...(config.env || {}),
        };
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env,
          cwd: config.cwd,
          stderr: "inherit",
        });
      } else {
        const url = config.url || config.serverUrl;
        if (!url) throw new Error("MCP server config needs 'command' or 'url'");
        const headers = config.headers || {};
        const options =
          Object.keys(headers).length > 0
            ? { requestInit: { headers } }
            : undefined;
        if (
          String(config.type || "").toLowerCase() === "sse" ||
          url.replace(/\/$/, "").endsWith("/sse")
        ) {
          transport = new SSEClientTransport(new URL(url), options);
        } else {
          transport = new StreamableHTTPClientTransport(new URL(url), options);
        }
      }

      client = new Client(
        { name: "jit", version: VERSION },
        { capabilities: {} },
      );
      await withTimeout(
        client.connect(transport),
        timeout,
        `connection timed out after ${Math.round(timeout / 1000)}s`,
      );
      const listing = await withTimeout(
        client.listTools(),
        timeout,
        `tool discovery timed out after ${Math.round(timeout / 1000)}s`,
      );
      state.client = client as unknown as McpClientLike;
      state.transport = transport;
      state.tools = (listing.tools || []) as McpTool[];
      state.status = "connected";
      state.error = null;
      return true;
    } catch (error) {
      state.status = "error";
      state.error = errorMessage(error);
      state.tools = [];
      state.client = null;
      state.transport = null;
      if (client) {
        try {
          await withTimeout(
            client.close(),
            5_000,
            "MCP client close timed out",
          );
        } catch {
          // Best effort.
        }
      }
      logger.warn("MCP server %s failed: %s", state.name, state.error);
      return false;
    }
  }

  async disconnect(name: string): Promise<void> {
    const state = this.servers.get(name);
    if (!state) return;
    const client = state.client;
    state.client = null;
    state.transport = null;
    state.tools = [];
    state.status = "disconnected";
    state.error = null;
    if (client) {
      try {
        await withTimeout(
          client.close(),
          5_000,
          "MCP client close timed out",
        );
      } catch (error) {
        logger.debug("error closing MCP server %s: %s", name, errorMessage(error));
      }
    }
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((name) => this.disconnect(name)));
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (!(await this.connect(serverName))) {
      const state = this.servers.get(serverName);
      return {
        error: state?.error || "connection failed",
        is_error: true,
      };
    }
    const state = this.servers.get(serverName);
    if (!state?.client) {
      return { error: `server '${serverName}' is not connected`, is_error: true };
    }
    try {
      const result = (await state.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: CALL_TIMEOUT },
      )) as unknown as Record<string, unknown>;
      return resultPayload(result);
    } catch (error) {
      return { error: errorMessage(error), is_error: true };
    }
  }

  getTools(serverName?: string): Array<McpTool & { server: string }> {
    if (serverName !== undefined) {
      const state = this.servers.get(serverName);
      if (!state) return [];
      return state.tools.map((tool) => ({ ...tool, server: serverName }));
    }
    return [...this.servers.values()].flatMap((state) =>
      state.tools.map((tool) => ({ ...tool, server: state.name })),
    );
  }

  getStatus(): Record<
    string,
    { status: McpStatus; tool_count: number; error: string | null; source?: string }
  > {
    return Object.fromEntries(
      [...this.servers.entries()].map(([name, state]) => [
        name,
        {
          status: state.status,
          tool_count: state.tools.length,
          error: state.error,
          source: state.config._source,
        },
      ]),
    );
  }

  async statusSummary(): Promise<McpServerSummary[]> {
    await this.loadConfigs();
    const db = await import("../storage/db.js");
    const indexed = db.indexedToolCounts(db.initDb());
    return Object.entries(this.getStatus())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, status]) => ({
        name,
        status: status.status,
        tool_count: status.tool_count,
        indexed_tool_count: indexed.get(name) || 0,
        error: status.error,
        source: status.source,
      }));
  }

  indexTools(serverName?: string): IndexItem[] {
    return this.getTools(serverName).map((tool) =>
      MCPClientManager.parseToolManifest(tool.server, tool),
    );
  }

  static parseToolManifest(
    serverName: string,
    tool: McpTool & { server?: string },
  ): IndexItem {
    const schema = tool.inputSchema || {};
    const properties = schema.properties || {};
    const name = String(tool.name || "unknown");
    return {
      id: `${serverName}__${name}`,
      name,
      server: serverName,
      kind: "tool",
      description: String(tool.description || ""),
      params: Object.keys(properties),
      required: Array.isArray(schema.required) ? schema.required.map(String) : [],
      schema,
      categories: [serverName],
      aliases: [],
      when_to_use: String(tool.description || ""),
      body: JSON.stringify(schema, null, 2),
      path: "",
      // Tools always come from an external MCP server, so they are never
      // first-party. Used to label provenance in JIT_FIND results.
      source: `mcp:${serverName}`,
    };
  }
}

let defaultInstance: MCPClientManager | null = null;

export function defaultManager(): MCPClientManager {
  if (!defaultInstance) defaultInstance = new MCPClientManager();
  return defaultInstance;
}

export async function shutdown(): Promise<void> {
  if (defaultInstance) await defaultInstance.disconnectAll();
}
