# syntax=docker/dockerfile:1.7
# Eris Cloud Agent — Composer Full (GGUF) via node-llama-cpp
# Client URL: http://agents.ericservic.es:6443 (plain HTTP)
#
# GPU: CUDA runtime libs included. Host needs NVIDIA Container Toolkit.
#   podman run --device nvidia.com/gpu=all --security-opt=label=disable ...
# CPU-only hosts still work (node-llama-cpp falls back when no GPU is visible).
#
# Build:
#   docker build -t eris-cloud-agent ./cloud-agent
#   # optional: --build-arg INSTALL_CUDA_VERSION=13.1  (must be ≤ host driver CUDA)

ARG NODE_VERSION=22
ARG INSTALL_CUDA_VERSION=12.5

# ── compile TypeScript ──────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force

# ── production runtime + CUDA ───────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm AS runtime

ARG TARGETARCH=amd64
ARG INSTALL_CUDA_VERSION=12.5
ARG NODE_VERSION=22

LABEL org.opencontainers.image.title="Eris Cloud Agent" \
  org.opencontainers.image.description="Cloud Agent worker for Eris IDE (Composer Full + CUDA)" \
  org.opencontainers.image.source="https://github.com/EricServices-Repo/Eris" \
  org.opencontainers.image.vendor="Eris"

SHELL ["/bin/bash", "-c"]

# tini = proper PID 1 (forwards SIGTERM for graceful drain)
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

RUN set -euo pipefail \
  && if [ "$TARGETARCH" = "arm64" ]; then NVARCH=sbsa; else NVARCH=x86_64; fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends gnupg2 curl ca-certificates \
  && curl -fsSL "https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/${NVARCH}/3bf863cc.pub" \
       | gpg --dearmor -o /usr/share/keyrings/cuda-archive-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/cuda-archive-keyring.gpg] https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/${NVARCH} /" \
       > /etc/apt/sources.list.d/cuda.list \
  && apt-get update \
  && CUDA_VER="${INSTALL_CUDA_VERSION//./-}" \
  && apt-get install -y --no-install-recommends \
       "cuda-cudart-${CUDA_VER}" \
       "cuda-compat-${CUDA_VER}" \
       "cuda-libraries-${CUDA_VER}" \
       "libnpp-${CUDA_VER}" \
       "cuda-nvtx-${CUDA_VER}" \
       "libcusparse-${CUDA_VER}" \
       "libcublas-${CUDA_VER}" \
       git ca-certificates bash curl cmake clang libgomp1 \
  && apt-mark hold "libcublas-${CUDA_VER}" \
  && apt-get purge -y --auto-remove gnupg2 \
  && rm -rf /var/lib/apt/lists/* \
  && echo "/usr/local/nvidia/lib" >> /etc/ld.so.conf.d/nvidia.conf \
  && echo "/usr/local/nvidia/lib64" >> /etc/ld.so.conf.d/nvidia.conf \
  && ldconfig

ENV NVIDIA_VISIBLE_DEVICES=all \
  NVIDIA_DRIVER_CAPABILITIES=compute,utility \
  LD_LIBRARY_PATH=/usr/local/nvidia/lib:/usr/local/nvidia/lib64:/usr/local/cuda/lib64 \
  NODE_ENV=production \
  NODE_OPTIONS=--max-old-space-size=4096 \
  ERIS_CLOUD_HOST=0.0.0.0 \
  ERIS_CLOUD_PORT=6443 \
  ERIS_CLOUD_PUBLIC_URL=http://agents.ericservic.es:6443 \
  ERIS_CLOUD_DATA=/var/lib/eris-cloud \
  ERIS_CLOUD_MAX_PARALLEL=2 \
  ERIS_CLOUD_GPU=auto \
  ERIS_CLOUD_LLM_MODEL=composer

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod 755 /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /var/lib/eris-cloud/models /var/lib/eris-cloud/workspaces \
  && chown -R node:node /var/lib/eris-cloud /app

USER node

EXPOSE 6443
STOPSIGNAL SIGTERM

# First boot may download Composer Full (~4.7 GB) into the volume
HEALTHCHECK --interval=30s --timeout=8s --start-period=600s --retries=8 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ERIS_CLOUD_PORT||6443)+'/v1/health').then(async r=>{if(!r.ok)process.exit(1);const j=await r.json();process.exit(j&&j.ok?0:1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
