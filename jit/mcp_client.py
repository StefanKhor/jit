"""MCP client manager — connects to MCP servers, lists tools, executes calls."""

import json
import os
import subprocess
import threading
from pathlib import Path

from .config import INDEX_DIR


class MCPClientManager:
    """Manages connections to MCP servers for tool discovery and execution."""

    def __init__(self):
        self._servers = {}  # name -> {config, process, tools, status}
        self._lock = threading.Lock()

    def load_configs(self, config_paths=None):
        """Load MCP server configs from client config files."""
        if config_paths is None:
            config_paths = self._default_config_paths()

        configs = {}
        for path in config_paths:
            path = Path(path).expanduser()
            if not path.exists():
                continue
            try:
                data = json.loads(path.read_text())
                servers = data.get("mcpServers", data.get("mcp", {}).get("servers", {}))
                for name, cfg in servers.items():
                    if name not in configs:
                        configs[name] = cfg
                        configs[name]["_source"] = str(path)
            except Exception:
                continue

        with self._lock:
            for name, cfg in configs.items():
                if name not in self._servers:
                    self._servers[name] = {
                        "config": cfg,
                        "process": None,
                        "tools": [],
                        "status": "disconnected",
                        "error": None,
                    }
        return list(configs.keys())

    def _default_config_paths(self):
        """Default MCP config file locations."""
        paths = []
        home = Path.home()
        candidates = [
            home / ".cursor" / "mcp.json",
            home / ".claude.json",
            home / ".config" / "opencode" / "opencode.json",
            Path.cwd() / ".mcp.json",
            Path.cwd() / "mcp.json",
        ]
        # Claude Desktop
        import platform
        if platform.system() == "Darwin":
            paths.append(home / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json")
        elif platform.system() == "Windows":
            paths.append(home / "AppData" / "Roaming" / "Claude" / "claude_desktop_config.json")
        paths.extend(candidates)
        return paths

    def connect(self, server_name):
        """Connect to an MCP server and list its tools."""
        with self._lock:
            if server_name not in self._servers:
                return False
            srv = self._servers[server_name]

        cfg = srv["config"]
        command = cfg.get("command")
        args = cfg.get("args", [])
        env = {**os.environ, **cfg.get("env", {})}

        if not command:
            with self._lock:
                srv["status"] = "error"
                srv["error"] = "No command specified"
            return False

        try:
            proc = subprocess.Popen(
                [command] + args,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                text=True,
            )
            # Send initialize + tools/list via JSON-RPC
            init_msg = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "jit-mcp", "version": "0.1.0"},
                },
            }
            proc.stdin.write(json.dumps(init_msg) + "\n")
            proc.stdin.flush()

            # Read response
            response = self._read_response(proc, 1)
            if not response or "error" in response:
                raise Exception(response.get("error", "Initialize failed"))

            # Send initialized notification
            proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
            proc.stdin.flush()

            # List tools
            list_msg = {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
            proc.stdin.write(json.dumps(list_msg) + "\n")
            proc.stdin.flush()

            tools_response = self._read_response(proc, 2)
            tools = []
            if tools_response and "result" in tools_response:
                tools = tools_response["result"].get("tools", [])

            with self._lock:
                srv["process"] = proc
                srv["tools"] = tools
                srv["status"] = "connected"
                srv["error"] = None
            return True

        except Exception as e:
            with self._lock:
                srv["status"] = "error"
                srv["error"] = str(e)
            return False

    def _read_response(self, proc, expected_id, timeout=10):
        """Read a JSON-RPC response with matching ID."""
        import select
        import time
        deadline = time.time() + timeout
        while time.time() < deadline:
            # Check if data available
            ready, _, _ = select.select([proc.stdout], [], [], 0.1)
            if ready:
                line = proc.stdout.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line.strip())
                    if msg.get("id") == expected_id:
                        return msg
                except json.JSONDecodeError:
                    continue
        return None

    def disconnect(self, server_name):
        """Disconnect from an MCP server."""
        with self._lock:
            if server_name in self._servers:
                srv = self._servers[server_name]
                if srv["process"]:
                    try:
                        srv["process"].terminate()
                        srv["process"].wait(timeout=5)
                    except Exception:
                        try:
                            srv["process"].kill()
                        except Exception:
                            pass
                srv["process"] = None
                srv["tools"] = []
                srv["status"] = "disconnected"

    def disconnect_all(self):
        """Disconnect from all servers."""
        for name in list(self._servers.keys()):
            self.disconnect(name)

    def get_tools(self, server_name=None):
        """Get tools from one or all servers."""
        with self._lock:
            if server_name:
                srv = self._servers.get(server_name)
                if srv:
                    return [{"server": server_name, **t} for t in srv["tools"]]
                return []
            all_tools = []
            for name, srv in self._servers.items():
                for t in srv["tools"]:
                    all_tools.append({"server": name, **t})
            return all_tools

    def get_status(self):
        """Get status of all servers."""
        with self._lock:
            return {
                name: {
                    "status": srv["status"],
                    "tool_count": len(srv["tools"]),
                    "error": srv["error"],
                }
                for name, srv in self._servers.items()
            }

    def call_tool(self, server_name, tool_name, arguments):
        """Execute a tool on an MCP server."""
        with self._lock:
            srv = self._servers.get(server_name)
            if not srv or srv["status"] != "connected":
                return {"error": f"Server {server_name} not connected"}
            proc = srv["process"]

        msg = {
            "jsonrpc": "2.0",
            "id": 99,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        }
        try:
            proc.stdin.write(json.dumps(msg) + "\n")
            proc.stdin.flush()
            response = self._read_response(proc, 99, timeout=30)
            if response and "result" in response:
                return response["result"]
            if response and "error" in response:
                return {"error": response["error"]}
            return {"error": "No response from server"}
        except Exception as e:
            return {"error": str(e)}

    def parse_tool_manifest(self, server_name, tool):
        """Convert an MCP tool definition to a JIT index entry."""
        name = tool.get("name", "unknown")
        description = tool.get("description", "")
        schema = tool.get("inputSchema", {})
        params = list(schema.get("properties", {}).keys())
        required = schema.get("required", [])

        # Build embedding text
        text_parts = [f"{server_name} {name}", description]
        if params:
            text_parts.append("Params: " + ", ".join(params))
        if required:
            text_parts.append("Required: " + ", ".join(required))

        return {
            "id": f"{server_name}__{name}",
            "name": name,
            "server": server_name,
            "kind": "tool",
            "description": description,
            "params": params,
            "required": required,
            "schema": schema,
            "categories": [server_name],
            "aliases": [],
            "body": json.dumps(schema, indent=2),  # Store schema as "body"
        }

    def index_tools(self, server_name=None):
        """Index tools from connected servers into JIT."""
        tools = self.get_tools(server_name)
        manifests = [self.parse_tool_manifest(t["server"], t) for t in tools]
        return manifests