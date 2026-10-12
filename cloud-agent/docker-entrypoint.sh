#!/usr/bin/env bash
# Thin entrypoint: ensure data dirs exist, then exec the main process.
set -euo pipefail

DATA="${ERIS_CLOUD_DATA:-/var/lib/eris-cloud}"
mkdir -p "${DATA}/models" "${DATA}/workspaces" "${DATA}/jobs"

if [[ "${ERIS_CLOUD_VERBOSE:-0}" == "1" ]]; then
  echo "[eris-cloud-agent] data=${DATA} gpu=${ERIS_CLOUD_GPU:-auto} port=${ERIS_CLOUD_PORT:-6443}"
fi

exec "$@"
