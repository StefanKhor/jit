"""Configuration management for JIT — web-first, zero-config by default."""

import json
import os
import secrets
from pathlib import Path

from .config import INDEX_DIR

CONFIG_FILE = INDEX_DIR / "config.json"

DEFAULT_CONFIG = {
    "nebius_api_key": "",
    "nebius_api_base": "https://api.studio.nebius.ai/v1",
    "nemotron_nano_model": "nvidia/nemotron-nano",
    "nemotron_ultra_model": "nvidia/nemotron-3-ultra",
    "api_key": "",  # Auto-generated on first run
    "first_run": True,
    "theme": "dark",
}


def load_config() -> dict:
    """Load config from file, env vars, or defaults."""
    config = dict(DEFAULT_CONFIG)

    # Load from file
    if CONFIG_FILE.exists():
        try:
            file_config = json.loads(CONFIG_FILE.read_text())
            config.update(file_config)
        except (json.JSONDecodeError, OSError):
            pass

    # Override with env vars (production)
    if os.environ.get("NEBIUS_API_KEY"):
        config["nebius_api_key"] = os.environ["NEBIUS_API_KEY"]
    if os.environ.get("NEBIUS_API_BASE"):
        config["nebius_api_base"] = os.environ["NEBIUS_API_BASE"]
    if os.environ.get("JIT_API_KEY"):
        config["api_key"] = os.environ["JIT_API_KEY"]

    # No auto-generation — auth is opt-in via env var or explicit config.
    # If no api_key is set, auth is disabled (local dev mode).

    return config


def save_config(config: dict):
    """Save config to file."""
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    # Don't save env-var overrides as file values if they came from env
    CONFIG_FILE.write_text(json.dumps(config, indent=2))


def get_config_value(key: str, default=None):
    """Get a single config value."""
    config = load_config()
    return config.get(key, default)


def is_first_run() -> bool:
    """Check if this is the first run."""
    config = load_config()
    return config.get("first_run", True)


def complete_first_run():
    """Mark first run as complete."""
    config = load_config()
    config["first_run"] = False
    save_config(config)