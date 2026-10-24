FROM node:24-bookworm-slim AS build

ENV npm_config_update_notifier=false

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY README.md LICENSE ./

RUN npm run build

# Download the local embedding model into the image so the first dashboard
# request does not depend on the network. The model cache is separate from the
# user's /data volume. An air-gapped or offline build can pass
# --build-arg JIT_SKIP_MODEL_WARMUP=1 and supply the model at run time; JIT
# falls back to lexical retrieval until it is there.
ARG JIT_SKIP_MODEL_WARMUP=0
RUN mkdir -p /app/models \
    && if [ "$JIT_SKIP_MODEL_WARMUP" = "1" ]; then \
         echo "skipping embedding model warmup"; \
       else \
         JIT_MODEL_CACHE=/app/models node --input-type=module \
           -e "import('./dist/embedding.js').then((m) => m.warmupEmbeddingModel())"; \
       fi

RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    JIT_HOME=/data \
    JIT_MODEL_CACHE=/app/models

WORKDIR /app

# git is required by the skills CLI that resolves repository sources.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      libgomp1 \
      libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 jit \
    && mkdir -p /data \
    && chown jit:jit /data

COPY --from=build --chown=jit:jit /app/package.json /app/package-lock.json ./
COPY --from=build --chown=jit:jit /app/node_modules ./node_modules
COPY --from=build --chown=jit:jit /app/dist ./dist
COPY --from=build --chown=jit:jit /app/static ./static
COPY --from=build --chown=jit:jit /app/models ./models
COPY --from=build --chown=jit:jit \
      /app/README.md \
      /app/LICENSE \
      ./

USER jit

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/cli.js", "dashboard", "--host", "0.0.0.0", "--port", "3000"]
