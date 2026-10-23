# JIT — Just-In-Time Skill & MCP Tool Loader

Contributions welcome! Here's how to get started.

## Development setup

```bash
git clone https://github.com/jit-mcp/jit.git
cd jit
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

## Running tests

```bash
pytest
pytest --cov=jit
```

## Code style

We use [ruff](https://docs.astral.sh/ruff/) for linting and formatting:

```bash
ruff check jit/
ruff format jit/
```

## Pull requests

1. Fork the repo
2. Create a feature branch
3. Write tests for new functionality
4. Ensure all tests pass
5. Submit a PR

## Reporting issues

Use GitHub Issues. Include:
- Python version
- OS
- Steps to reproduce
- Expected vs actual behavior