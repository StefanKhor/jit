"""CLI for JIT — minimal, web-first."""

import os
import sys

# On NixOS, libstdc++ may not be on the default path.
# Set LD_LIBRARY_PATH before importing heavy deps.
if sys.platform == "linux" and "_JIT_LD_FIXED" not in os.environ:
    # Check cache first
    cache_file = os.path.expanduser("~/.jit/.libstdcpp_path")
    libdir = None
    if os.path.exists(cache_file):
        cached = open(cache_file).read().strip()
        if os.path.exists(os.path.join(cached, "libstdc++.so.6")):
            libdir = cached
    if not libdir:
        # Quick check of standard paths
        for candidate in ["/usr/lib/x86_64-linux-gnu", "/usr/lib64", "/usr/lib"]:
            if os.path.exists(os.path.join(candidate, "libstdc++.so.6")):
                libdir = candidate
                break
    if libdir:
        os.environ["LD_LIBRARY_PATH"] = libdir + ":" + os.environ.get("LD_LIBRARY_PATH", "")
        os.environ["_JIT_LD_FIXED"] = "1"
    # Don't re-exec; just continue. If numpy still fails, user needs to set LD_LIBRARY_PATH.

import click

from .config import DEFAULT_SKILL_PATHS


@click.group()
@click.version_option()
def main():
    """JIT — Just-In-Time Skill & MCP Tool Loader for AI Agents."""
    pass


@click.command()
def serve():
    """Start the JIT MCP server (stdio). Used by AI agents."""
    from .server import mcp
    from .config_manager import load_config
    cfg = load_config()
    if cfg.get("nebius_api_key"):
        os.environ.setdefault("NEBIUS_API_KEY", cfg["nebius_api_key"])
    if cfg.get("nebius_api_base"):
        os.environ.setdefault("NEBIUS_API_BASE", cfg["nebius_api_base"])
    mcp.run()


@click.command()
@click.option("--host", default="0.0.0.0", help="Host to bind to")
@click.option("--port", "-p", default=3000, help="Port to listen on")
def dashboard(host, port):
    """Start the web dashboard (management UI)."""
    from .dashboard import start_dashboard
    from .config_manager import load_config
    cfg = load_config()
    if cfg.get("nebius_api_key"):
        os.environ.setdefault("NEBIUS_API_KEY", cfg["nebius_api_key"])
    if cfg.get("nebius_api_base"):
        os.environ.setdefault("NEBIUS_API_BASE", cfg["nebius_api_base"])
    start_dashboard(host=host, port=port)


main.add_command(serve)
main.add_command(dashboard)


if __name__ == "__main__":
    main()