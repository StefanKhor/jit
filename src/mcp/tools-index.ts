import { indexItems, type IndexResult } from "../indexer.js";
import { deleteItemsByPrefix } from "../storage/store.js";
import type { McpTool } from "../types.js";

/**
 * MCP tools live in the same index as skills, under an id namespace that can
 * never collide with a skill id: mcp/<server>/<tool>. Their body (description
 * plus an argument sketch) is stored in the index because a tool has no file
 * to read from — the same exception a path-less /api/import row uses. What
 * the index enables is routing: JIT_FIND can point an agent at the right
 * tool. Executing it stays the agent's job, on the server that owns it.
 */

export const MCP_TOOL_PREFIX = "mcp/";

export function toolItemId(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${server}/${tool}`;
}

/** Parameter names and types, so an agent knows what a call needs without
 *  fetching the schema again. `name*` marks a required argument. */
function schemaSketch(tool: McpTool): string {
  const props = tool.inputSchema?.properties || {};
  const required = new Set(tool.inputSchema?.required || []);
  const parts = Object.entries(props).map(([name, raw]) => {
    const type = (raw as { type?: string } | null)?.type || "any";
    return `${name}${required.has(name) ? "*" : ""} (${type})`;
  });
  if (parts.length === 0) return "takes no arguments";
  return `Arguments: ${parts.join(", ")}`;
}

export function toolBody(tool: McpTool, server: string): string {
  const description = (tool.description || "").trim();
  // The body is all an agent sees when JIT_FIND serves this entry like any
  // skill, so it must say where the tool lives and what a call needs.
  return [
    `MCP tool on server "${server}".`,
    description,
    schemaSketch(tool),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Replace the indexed tool entries for one server with its current listing:
 *  stale rows are swept first, so a tool the server dropped stops matching. */
export async function syncServerTools(
  server: string,
  tools: McpTool[],
): Promise<IndexResult | null> {
  deleteItemsByPrefix(`${MCP_TOOL_PREFIX}${server}/`);
  if (tools.length === 0) return null;
  const items = tools.map((tool) => ({
    id: toolItemId(server, tool.name),
    name: tool.name,
    description: tool.description || `MCP tool ${tool.name} on ${server}`,
    body: toolBody(tool, server),
    path: "",
  }));
  return indexItems(items);
}

export function removeServerTools(server: string): number {
  return deleteItemsByPrefix(`${MCP_TOOL_PREFIX}${server}/`);
}
