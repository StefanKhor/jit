.PHONY: test lint format serve dashboard clean setup

# NixOS: find libstdc++ automatically
LIBSTDCPP := $(shell find /nix/store -name "libstdc++.so.6" -path "*/lib/*" 2>/dev/null | head -1 | xargs dirname 2>/dev/null)

setup:
	@echo "Setting up environment..."
	@echo "export LD_LIBRARY_PATH=$(LIBSTDCPP):$$LD_LIBRARY_PATH" > .env.local
	@echo "Created .env.local — source it before running: source .env.local"

test:
	LD_LIBRARY_PATH=$(LIBSTDCPP):$$LD_LIBRARY_PATH pytest -v

lint:
	LD_LIBRARY_PATH=$(LIBSTDCPP):$$LD_LIBRARY_PATH ruff check jit/ tests/

format:
	LD_LIBRARY_PATH=$(LIBSTDCPP):$$LD_LIBRARY_PATH ruff format jit/ tests/

serve:
	LD_LIBRARY_PATH=$(LIBSTDCPP):$$LD_LIBRARY_PATH jit serve

dashboard:
	LD_LIBRARY_PATH=$(LIBSTDCPP):$$LD_LIBRARY_PATH jit dashboard

clean:
	rm -rf .jit __pycache__ jit/__pycache__ tests/__pycache__
	rm -rf build dist *.egg-info .env.local