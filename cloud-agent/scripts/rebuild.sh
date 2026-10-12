#!/usr/bin/env bash
# Rebuild and restart Eris Cloud Agent on the VM.
# Usage (from repo root or any cwd):
#   ./cloud-agent/scripts/rebuild.sh
#   ./cloud-agent/scripts/rebuild.sh --install
#   ./cloud-agent/scripts/rebuild.sh --cpu --install
#   ./cloud-agent/scripts/rebuild.sh --no-pull --cuda 13.1
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CDIR="$ROOT/cloud-agent"

DO_PULL=1
DO_INSTALL=0
USE_DOCKER=0
USE_COMPOSE=0
CPU_ONLY=0
CUDA_VERSION=""
ENGINE=podman

usage() {
  cat <<'EOF'
Rebuild and restart Eris Cloud Agent.

  ./cloud-agent/scripts/rebuild.sh [flags]

Flags:
  --install     Install/replace Quadlet unit + enable service
  --cpu         CPU-only image (no CUDA) + CPU Quadlet unit (no NVIDIA)
  --no-pull     Do not git pull
  --cuda <ver>  GPU image CUDA build arg (ignored with --cpu)
  --docker      Use docker instead of podman
  --compose     docker compose up -d --build
  -h, --help    Show this help
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) DO_INSTALL=1; shift ;;
    --cpu) CPU_ONLY=1; shift ;;
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

if [[ "$CPU_ONLY" -eq 1 && -n "$CUDA_VERSION" ]]; then
  echo "rebuild: ignoring --cuda (CPU-only build)"
  CUDA_VERSION=""
fi

cd "$ROOT"
echo "==> repo: $ROOT"
if [[ "$CPU_ONLY" -eq 1 ]]; then
  echo "==> mode: CPU-only (ERIS_CLOUD_GPU=false, no NVIDIA device)"
else
  echo "==> mode: GPU (default)"
fi

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
COMPOSE_FILE="$CDIR/docker-compose.yml"
if [[ "$CPU_ONLY" -eq 1 ]]; then
  BUILD_ARGS+=(--target runtime-cpu)
  COMPOSE_FILE="$CDIR/docker-compose.cpu.yml"
elif [[ -n "$CUDA_VERSION" ]]; then
  BUILD_ARGS+=(--build-arg "INSTALL_CUDA_VERSION=${CUDA_VERSION}")
  echo "==> CUDA build arg: $CUDA_VERSION"
fi

# System Quadlet (eris-cloud-agent.service) runs as root — the image must be in
# root's Podman store. Building only as a regular user is the #1 start failure.
SYSTEM_SERVICE=0
if systemctl cat eris-cloud-agent.service >/dev/null 2>&1 || [[ "$DO_INSTALL" -eq 1 ]]; then
  SYSTEM_SERVICE=1
fi

if [[ "$USE_COMPOSE" -eq 1 ]]; then
  echo "==> docker compose -f $(basename "$COMPOSE_FILE") build + up"
  if [[ -n "$CUDA_VERSION" ]]; then
    export INSTALL_CUDA_VERSION="$CUDA_VERSION"
  fi
  docker compose -f "$COMPOSE_FILE" up -d --build
else
  if [[ "$ENGINE" == "podman" && "$SYSTEM_SERVICE" -eq 1 ]]; then
    echo "==> sudo podman build eris-cloud-agent:latest${CPU_ONLY:+ (target runtime-cpu)}  (root store for systemd)"
    sudo podman build -t localhost/eris-cloud-agent:latest -t eris-cloud-agent:latest \
      "${BUILD_ARGS[@]}" "$CDIR"
  else
    echo "==> ${ENGINE} build eris-cloud-agent:latest${CPU_ONLY:+ (target runtime-cpu)}"
    "$ENGINE" build -t localhost/eris-cloud-agent:latest -t eris-cloud-agent:latest \
      "${BUILD_ARGS[@]}" "$CDIR"
  fi
fi

install_nginx_status_proxy() {
  local conf_src="$CDIR/deploy/nginx-eris-cloud-status.conf"
  local conf_dst=""
  if [[ ! -f "$conf_src" ]]; then
    echo "==> skip nginx status proxy (missing $conf_src)"
    return 0
  fi
  if [[ ! -d /etc/nginx ]]; then
    echo "==> nginx not installed — status is on http://127.0.0.1:8080/ (publish host :80 yourself)"
    return 0
  fi
  if [[ -d /etc/nginx/conf.d ]]; then
    conf_dst=/etc/nginx/conf.d/eris-cloud-status.conf
  elif [[ -d /etc/nginx/sites-available ]]; then
    conf_dst=/etc/nginx/sites-available/eris-cloud-status.conf
  else
    echo "==> nginx present but no conf.d/sites-available — install $conf_src manually"
    return 0
  fi
  echo "==> install nginx :80 → 127.0.0.1:8080 status proxy ($conf_dst)"
  sudo cp "$conf_src" "$conf_dst"
  if [[ "$conf_dst" == /etc/nginx/sites-available/* && -d /etc/nginx/sites-enabled ]]; then
    sudo ln -sfn "$conf_dst" /etc/nginx/sites-enabled/eris-cloud-status.conf
    # Avoid default site 403 stealing :80
    if [[ -L /etc/nginx/sites-enabled/default ]]; then
      sudo rm -f /etc/nginx/sites-enabled/default
      echo "==> disabled nginx sites-enabled/default (was likely returning 403 on :80)"
    fi
  fi
  if sudo nginx -t 2>/tmp/eris-nginx-test.log; then
    sudo systemctl reload nginx 2>/dev/null || sudo nginx -s reload 2>/dev/null || true
    echo "==> nginx reloaded — http://127.0.0.1/ should show Cloud Agent status"
  else
    echo "==> nginx -t failed; status proxy not active:"
    cat /tmp/eris-nginx-test.log >&2 || true
    echo "    Fix the conflict, then: sudo nginx -t && sudo systemctl reload nginx"
  fi
}

if [[ "$DO_INSTALL" -eq 1 ]]; then
  echo "==> install Quadlet unit"
  sudo mkdir -p /etc/containers/systemd
  if [[ "$CPU_ONLY" -eq 1 ]]; then
    sudo cp "$CDIR/deploy/eris-cloud-agent-cpu.container" \
      /etc/containers/systemd/eris-cloud-agent.container
  else
    sudo cp "$CDIR/deploy/eris-cloud-agent.container" /etc/containers/systemd/
  fi
  sudo systemctl daemon-reload
  sudo systemctl enable eris-cloud-agent.service
  install_nginx_status_proxy
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
  RUN_EXTRA=()
  GPU_ENV=auto
  PARALLEL=2
  if [[ "$CPU_ONLY" -eq 1 ]]; then
    GPU_ENV=false
    PARALLEL=1
  else
    if [[ "$ENGINE" == "docker" ]]; then
      RUN_EXTRA=(--gpus all)
    else
      RUN_EXTRA=(--device nvidia.com/gpu=all --security-opt=label=disable)
    fi
  fi
  RUN_LIMITS=()
  RUN_ENV=(
    -e ERIS_CLOUD_PUBLIC_URL=http://agents.ericservic.es:6443
    -e ERIS_CLOUD_STATUS_PORT=8080
    -e "ERIS_CLOUD_GPU=${GPU_ENV}"
    -e "ERIS_CLOUD_MAX_PARALLEL=${PARALLEL}"
  )
  if [[ "$CPU_ONLY" -eq 1 ]]; then
    RUN_LIMITS+=(--cpus=2 --memory=6g)
    RUN_ENV+=(-e ERIS_CLOUD_MAX_THREADS=2 -e ERIS_CLOUD_CONTEXT_SIZE=4096)
  fi
  "$ENGINE" run -d --name eris-cloud-agent \
    --restart unless-stopped \
    "${RUN_EXTRA[@]}" \
    "${RUN_LIMITS[@]}" \
    --stop-signal=SIGTERM \
    -p 6443:6443 \
    -p 8080:8080 \
    "${RUN_ENV[@]}" \
    -v eris-cloud-data:/var/lib/eris-cloud \
    eris-cloud-agent:latest
  install_nginx_status_proxy
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
    jq '{ok,ready,gpuMode,version,localModel,adminKillAllConfigured,endpoints}' </tmp/eris-cloud-health.json
  else
    cat /tmp/eris-cloud-health.json
    echo
  fi
  ver="$(python3 -c 'import json;print(json.load(open("/tmp/eris-cloud-health.json")).get("version",""))' 2>/dev/null || true)"
  echo "==> rebuild done · version=${ver:-unknown} · http://127.0.0.1:6443/v1/health"
  echo "==> status (direct): http://127.0.0.1:8080/"
  echo "==> status (:80 via nginx): http://127.0.0.1/"
  if curl -fsS http://127.0.0.1:8080/ 2>/dev/null | grep -q 'Force kill all'; then
    echo "==> OK: Force kill all present on :8080 status page"
  else
    echo "==> WARN: Force kill all not found on :8080 — image may be stale (need cloud-agent >= 0.2.16)"
  fi
  if curl -fsS http://127.0.0.1/ 2>/dev/null | grep -q 'Force kill all'; then
    echo "==> OK: Force kill all present on :80 (nginx → status)"
  else
    echo "==> :80 not serving status yet — installing nginx proxy"
    install_nginx_status_proxy
    sleep 1
    if curl -fsS http://127.0.0.1/ 2>/dev/null | grep -q 'Force kill all'; then
      echo "==> OK: Force kill all present on :80 after nginx install"
    else
      code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1/ 2>/dev/null || echo err)"
      echo "==> WARN: :80 still not OK (HTTP $code). On the VM run:"
      echo "    sudo cp $CDIR/deploy/nginx-eris-cloud-status.conf /etc/nginx/conf.d/"
      echo "    sudo rm -f /etc/nginx/sites-enabled/default"
      echo "    sudo nginx -t && sudo systemctl reload nginx"
      echo "    # and ensure Quadlet publishes 8080:8080 (rebuild with --install)"
    fi
  fi
  if [[ "$CPU_ONLY" -eq 1 ]]; then
    echo "==> CPU node: expect localModel.gpu=false once the model is loaded"
  fi
  if [[ -n "$ver" && "$ver" != "0.2.16" && "$ver" != "0.2.15" ]]; then
    echo "==> NOTE: expected cloud-agent >= 0.2.16 for kill-all; got $ver"
  fi
else
  echo "rebuild: health endpoint not up yet (model may still be downloading)"
  echo "  journalctl -u eris-cloud-agent.service -f"
  echo "  ${ENGINE} logs -f eris-cloud-agent"
  exit 1
fi
