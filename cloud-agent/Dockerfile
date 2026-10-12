# Eris Cloud Agent — runs its own local GGUF (Composer Lite) via node-llama-cpp
# Client URL: http://agents.ericservic.es:6443 (plain HTTP, no TLS cert)

FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git ca-certificates bash python3 make g++ cmake curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates bash curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production \
  ERIS_CLOUD_HOST=0.0.0.0 \
  ERIS_CLOUD_PORT=6443 \
  ERIS_CLOUD_PUBLIC_URL=http://agents.ericservic.es:6443 \
  ERIS_CLOUD_DATA=/var/lib/eris-cloud \
  ERIS_CLOUD_MAX_PARALLEL=2 \
  # Leave ERIS_CLOUD_LLM_BASE unset — use the bundled local model
  ERIS_CLOUD_LLM_MODEL=composer-lite

RUN mkdir -p /var/lib/eris-cloud/models \
  && chown -R node:node /var/lib/eris-cloud /app

USER node

EXPOSE 6443

# Longer start period: first boot downloads ~1GB GGUF into the volume
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:6443/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
