"""Configuration for JIT."""

import os
from pathlib import Path

# Skill search paths (checked in order)
DEFAULT_SKILL_PATHS = [
    Path.home() / ".skills",
    Path.home() / ".claude" / "skills",
    Path.home() / ".config" / "opencode" / "skills",
    Path.cwd() / ".opencode" / "skills",
    Path.cwd() / "skills",
]

# Index storage
INDEX_DIR = Path.home() / ".jit"
INDEX_FILE = INDEX_DIR / "skills.faiss"
META_DB = INDEX_DIR / "skills.db"

# Retrieval
CONFIDENCE_THRESHOLD = 0.60
TOP_K_RETRIEVE = 20
TOP_K_RERANK = 3

# Embedding model (local, free)
EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"

# Nemotron via Nebius Token Factory
# These can be set via env vars or config file (~/.jit/config.json)
NEBIUS_API_BASE = os.environ.get("NEBIUS_API_BASE", "https://api.studio.nebius.ai/v1")
NEBIUS_API_KEY = os.environ.get("NEBIUS_API_KEY", "")
NEMOTRON_NANO_MODEL = os.environ.get("NEMOTRON_NANO_MODEL", "nvidia/nemotron-nano")
NEMOTRON_ULTRA_MODEL = os.environ.get("NEMOTRON_ULTRA_MODEL", "nvidia/nemotron-3-ultra")

# Try loading from config file (web UI settings)
try:
    import json
    _cfg_path = Path.home() / ".jit" / "config.json"
    if _cfg_path.exists():
        _cfg = json.loads(_cfg_path.read_text())
        if not NEBIUS_API_KEY and _cfg.get("nebius_api_key"):
            NEBIUS_API_KEY = _cfg["nebius_api_key"]
        if _cfg.get("nebius_api_base"):
            NEBIUS_API_BASE = _cfg["nebius_api_base"]
        if _cfg.get("nemotron_nano_model"):
            NEMOTRON_NANO_MODEL = _cfg["nemotron_nano_model"]
        if _cfg.get("nemotron_ultra_model"):
            NEMOTRON_ULTRA_MODEL = _cfg["nemotron_ultra_model"]
except Exception:
    pass