FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY pyproject.toml .
COPY jit/ ./jit/
COPY skills/ ./skills/
COPY dashboard.html .

# Install JIT
RUN pip install --no-cache-dir -e .

# Create index directory
RUN mkdir -p /root/.jit

# Expose dashboard port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/api/health')" || exit 1

# Default: run dashboard
CMD ["jit", "dashboard", "--host", "0.0.0.0", "--port", "8080"]