# Eris Cloud Agent — local GGUF (Composer Lite) via node-llama-cpp
# Client URL: http://agents.ericservic.es:6443 (plain HTTP, no TLS cert)
#
# GPU: CUDA libraries included. Host needs NVIDIA Container Toolkit.
# Run: podman run --device nvidia.com/gpu=all --security-opt=label=disable ...
# CPU-only hosts still work (node-llama-cpp falls back when no GPU is visible).

ARG TARGETARCH=amd64

FROM node:22-bookworm AS build

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

# Runtime with CUDA libs (node-llama-cpp Docker guide)
FROM node:22-bookworm

ARG TARGETARCH=amd64
# CUDA toolkit series for prebuilt node-llama-cpp binaries (12.4+)
ARG INSTALL_CUDA_VERSION=12.5

SHELL ["/bin/bash", "-c"]

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
  && rm -rf /var/lib/apt/lists/* \
  && echo "/usr/local/nvidia/lib" >> /etc/ld.so.conf.d/nvidia.conf \
  && echo "/usr/local/nvidia/lib64" >> /etc/ld.so.conf.d/nvidia.conf \
  && ldconfig

ENV NVIDIA_VISIBLE_DEVICES=all \
  NVIDIA_DRIVER_CAPABILITIES=compute,utility \
  NODE_ENV=production \
  ERIS_CLOUD_HOST=0.0.0.0 \
  ERIS_CLOUD_PORT=6443 \
  ERIS_CLOUD_PUBLIC_URL=http://agents.ericservic.es:6443 \
  ERIS_CLOUD_DATA=/var/lib/eris-cloud \
  ERIS_CLOUD_MAX_PARALLEL=2 \
  ERIS_CLOUD_GPU=auto \
  ERIS_CLOUD_LLM_MODEL=composer

WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /var/lib/eris-cloud/models \
  && chown -R node:node /var/lib/eris-cloud /app

USER node

EXPOSE 6443

# First boot downloads Composer Full (~4.7 GB) into the volume
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=8 \
  CMD node -e "fetch('http://127.0.0.1:6443/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
