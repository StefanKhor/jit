.PHONY: lint format serve dashboard clean setup

# NixOS: find libstdc++ automatically
LIBSTDCPP := $(shell find /nix/store -name "libstdc++.so.6" -path "*/lib/*" 2>/dev/null | head -1 | xargs dirname 2>/dev/null)

setup:
	@echo "Setting up environment..."
	@echo "export LD_LIBRARY_PATH=$(LIBSTDCPP):$$LD_LIBRARY_PATH" > .env.local
	@echo "Created .env.local — source it before running: source .env.local"

lint:
	LD_LIBRARY_PATH=$(LIBSTDCPP):$$LD_LIBRARY_PATH ruff check jit/

format:
	LD_LIBRARY_PATH=$(LIBSTDCPP):$$LD_LIBRARY_PATH ruff format jit/

serve:
	LD_LIBRARY_PATH=$(LIBSTDCPP):$$LD_LIBRARY_PATH jit serve

dashboard:
	LD_LIBRARY_PATH=$(LIBSTDCPP):$$LD_LIBRARY_PATH jit dashboard

clean:
	rm -rf .jit __pycache__ jit/__pycache__
	rm -rf build dist *.egg-info .env.local