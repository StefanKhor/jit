"""MCP server for JIT — exposes JIT_FIND, JIT_ADD, JIT_CALL, and JIT_STATUS tools."""

import json
import logging
import sys
from pathlib import Path

from mcp.server.mcpserver import MCPServer

from .config import DEFAULT_SKILL_PATHS, CONFIDENCE_THRESHOLD
from .indexer import (
    discover_skills,
    parse_skill,
    index_items,
    index_skills,
    clear_index,
    load_index,
    get_all_skills,
    get_skill_by_id,
)
from .logging import get_logger
from .retriever import retrieve, search_debug
from .mcp_client import MCPClientManager

logger = get_logger("server")
mcp = MCPServer("JIT")

# Global MCP client manager
_mcp_manager = MCPClientManager()


@mcp.tool()
def JIT_FIND(intent: str) -> dict | None:
    """Find the best-matching skill or tool for an intent.

    JIT is search-only. Returns the skill body (markdown instructions) or
    tool info (name, server, schema, description) if a match is found.
    The agent handles execution itself — JIT just helps find what's needed.
    Returns null if no match. The agent continues with core tools.
    """
    result = retrieve(intent)
    if result is None:
        return None
    return result


@mcp.tool()
def JIT_ADD(source: str, format: str = "auto", kind: str = "skill") -> dict:
    """Add skills or MCP tools to the JIT index.

    Args:
        source: A directory path, URL, MCP server name, or inline markdown.
        format: "dir", "url", "inline", "mcp", or "auto" (detect from source).
        kind: "skill" or "tool".

    Returns counts of added, skipped, and any errors.
    """
    added = 0
    skipped = 0
    errors = []

    # Detect format
    if format == "auto":
        if source.startswith("http://") or source.startswith("https://"):
            format = "url"
        elif "\n---\n" in source or source.strip().startswith("---"):
            format = "inline"
        elif kind == "tool":
            format = "mcp"
        else:
            format = "dir"

    if format == "inline":
        import tempfile
        tmp = Path(tempfile.mkdtemp()) / "SKILL.md"
        tmp.write_text(source)
        skills = [parse_skill(tmp)]
        a, s, e = index_items(skills, "skill")
        added += a
        skipped += s
        errors.extend(e)

    elif format == "dir":
        path = Path(source).expanduser()
        if not path.exists():
            return {"added": 0, "skipped": 0, "errors": [f"Path not found: {source}"], "total_indexed": _total_indexed()}
        files = list(path.rglob("SKILL.md")) + list(path.glob("*.md"))
        skills = []
        for f in files:
            try:
                skills.append(parse_skill(f))
            except Exception as e:
                errors.append(f"{f}: {e}")
        a, s, e = index_items(skills, "skill")
        added += a
        skipped += s
        errors.extend(e)

    elif format == "url":
        try:
            import httpx
            resp = httpx.get(source, timeout=30, follow_redirects=True)
            resp.raise_for_status()
            if "---" in resp.text[:200]:
                import tempfile
                tmp = Path(tempfile.mkdtemp()) / "SKILL.md"
                tmp.write_text(resp.text)
                skills = [parse_skill(tmp)]
                a, s, e = index_items(skills, "skill")
                added += a
                skipped += s
                errors.extend(e)
            else:
                errors.append("URL did not return a valid skill file")
        except Exception as e:
            errors.append(f"Failed to fetch URL: {e}")

    elif format == "mcp":
        # Connect to MCP server and index its tools
        _mcp_manager.load_configs()
        connected = _mcp_manager.connect(source)
        if not connected:
            status = _mcp_manager.get_status().get(source, {})
            return {
                "added": 0, "skipped": 0,
                "errors": [f"Failed to connect to {source}: {status.get('error', 'unknown')}"],
                "total_indexed": _total_indexed(),
            }
        manifests = _mcp_manager.index_tools(source)
        a, s, e = index_items(manifests, "tool")
        added += a
        skipped += s
        errors.extend(e)

    return {
        "added": added,
        "skipped": skipped,
        "errors": errors,
        "total_indexed": _total_indexed(),
    }


@mcp.tool()
def JIT_CALL(tool_id: str, arguments: dict) -> dict:
    """Execute an MCP tool that was discovered via JIT_FIND.

    Args:
        tool_id: The tool ID (format: "server__tool_name").
        arguments: The arguments to pass to the tool.

    Returns the tool result or an error.
    """
    if "__" not in tool_id:
        return {"error": f"Invalid tool_id format: {tool_id}. Expected 'server__tool_name'."}

    server_name, tool_name = tool_id.split("__", 1)

    status = _mcp_manager.get_status().get(server_name, {})
    if status.get("status") != "connected":
        _mcp_manager.load_configs()
        _mcp_manager.connect(server_name)

    result = _mcp_manager.call_tool(server_name, tool_name, arguments)
    return result


@mcp.tool()
def JIT_STATUS() -> dict:
    """Get the status of JIT: indexed items, connected MCP servers, config."""
    from .indexer import load_index, get_all_skills
    index, conn = load_index()
    if conn is None:
        return {"indexed": 0, "servers": {}, "error": "No index found. Run 'jit init'."}

    skills = get_all_skills(conn)
    conn.close()

    skill_count = sum(1 for s in skills if s.get("kind") == "skill")
    tool_count = sum(1 for s in skills if s.get("kind") == "tool")

    return {
        "indexed": {"skills": skill_count, "tools": tool_count, "total": len(skills)},
        "servers": _mcp_manager.get_status(),
        "config": {
            "threshold": __import__("jit.config", fromlist=["CONFIDENCE_THRESHOLD"]).CONFIDENCE_THRESHOLD,
        },
    }


def _total_indexed():
    try:
        _, conn = load_index()
        if conn is None:
            return 0
        count = conn.execute("SELECT COUNT(*) FROM skills").fetchone()[0]
        conn.close()
        return count
    except Exception:
        return 0


def main():
    _mcp_manager.load_configs()
    mcp.run()


if __name__ == "__main__":
    main()