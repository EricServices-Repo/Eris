#!/usr/bin/env bash
# Rebuild and restart Eris Cloud Agent on the VM.
# Usage (from repo root or any cwd):
#   ./cloud-agent/scripts/rebuild.sh
#   ./cloud-agent/scripts/rebuild.sh --install
#   ./cloud-agent/scripts/rebuild.sh --no-pull --cuda 13.1
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CDIR="$ROOT/cloud-agent"

DO_PULL=1
DO_INSTALL=0
USE_DOCKER=0
USE_COMPOSE=0
CUDA_VERSION=""
ENGINE=podman

usage() {
  sed -n '2,8p' "$0" | sed 's/^# //'
  echo "Flags: --install  --no-pull  --cuda <ver>  --docker  --compose  -h"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) DO_INSTALL=1; shift ;;
    --no-pull) DO_PULL=0; shift ;;
    --docker) USE_DOCKER=1; ENGINE=docker; shift ;;
    --compose) USE_COMPOSE=1; USE_DOCKER=1; ENGINE=docker; shift ;;
    --cuda)
      CUDA_VERSION="${2:-}"
      [[ -n "$CUDA_VERSION" ]] || { echo "rebuild: --cuda needs a version"; exit 1; }
      shift 2
      ;;
    -h|--help) usage ;;
    *) echo "rebuild: unknown flag $1"; usage ;;
  esac
done

cd "$ROOT"
echo "==> repo: $ROOT"

if [[ "$DO_PULL" -eq 1 ]]; then
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "==> git pull"
    git pull --ff-only || git pull
  else
    echo "==> skip git pull (not a git checkout)"
  fi
else
  echo "==> skip git pull (--no-pull)"
fi

BUILD_ARGS=()
if [[ -n "$CUDA_VERSION" ]]; then
  BUILD_ARGS+=(--build-arg "INSTALL_CUDA_VERSION=${CUDA_VERSION}")
  echo "==> CUDA build arg: $CUDA_VERSION"
fi

if [[ "$USE_COMPOSE" -eq 1 ]]; then
  echo "==> docker compose build + up"
  if [[ -n "$CUDA_VERSION" ]]; then
    export INSTALL_CUDA_VERSION="$CUDA_VERSION"
  fi
  docker compose -f "$CDIR/docker-compose.yml" up -d --build
else
  echo "==> ${ENGINE} build eris-cloud-agent:latest"
  "$ENGINE" build -t eris-cloud-agent:latest "${BUILD_ARGS[@]}" "$CDIR"
fi

if [[ "$DO_INSTALL" -eq 1 ]]; then
  echo "==> install Quadlet unit"
  sudo mkdir -p /etc/containers/systemd
  sudo cp "$CDIR/deploy/eris-cloud-agent.container" /etc/containers/systemd/
  sudo systemctl daemon-reload
  sudo systemctl enable eris-cloud-agent.service
fi

restart_service() {
  if systemctl cat eris-cloud-agent.service >/dev/null 2>&1; then
    echo "==> systemctl restart eris-cloud-agent.service"
    sudo systemctl restart eris-cloud-agent.service
    return 0
  fi
  return 1
}

if [[ "$USE_COMPOSE" -eq 1 ]]; then
  echo "==> compose already running"
elif restart_service; then
  :
else
  echo "==> no Quadlet unit — recreate container with ${ENGINE}"
  "$ENGINE" rm -f eris-cloud-agent 2>/dev/null || true
  RUN_GPU=(--device nvidia.com/gpu=all --security-opt=label=disable)
  if [[ "$ENGINE" == "docker" ]]; then
    RUN_GPU=(--gpus all)
  fi
  "$ENGINE" run -d --name eris-cloud-agent \
    --restart unless-stopped \
    "${RUN_GPU[@]}" \
    --stop-signal=SIGTERM \
    -p 6443:6443 \
    -e ERIS_CLOUD_PUBLIC_URL=http://agents.ericservic.es:6443 \
    -e ERIS_CLOUD_GPU=auto \
    -v eris-cloud-data:/var/lib/eris-cloud \
    eris-cloud-agent:latest
fi

echo "==> waiting for health…"
ok=0
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:6443/v1/health >/tmp/eris-cloud-health.json 2>/dev/null; then
    ok=1
    break
  fi
  sleep 2
done

if [[ "$ok" -eq 1 ]]; then
  if command -v jq >/dev/null 2>&1; then
    jq '{ok,ready,gpuMode,version,localModel}' </tmp/eris-cloud-health.json
  else
    cat /tmp/eris-cloud-health.json
    echo
  fi
  echo "==> rebuild done · http://127.0.0.1:6443/v1/health"
else
  echo "rebuild: health endpoint not up yet (model may still be downloading)"
  echo "  journalctl -u eris-cloud-agent.service -f"
  echo "  ${ENGINE} logs -f eris-cloud-agent"
  exit 1
fi
