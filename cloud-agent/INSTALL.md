# Eris Cloud Agent — VM install & rebuild

Ops notes for **agents.ericservic.es** (or any Linux VM with NVIDIA + Podman/Docker).

Client URL (no TLS): `http://agents.ericservic.es:6443`

---

## One-time host setup

```bash
# Clone the Eris repo (once)
sudo mkdir -p /opt/eris && sudo chown "$USER:$USER" /opt/eris
git clone https://github.com/EricServices-Repo/Eris.git /opt/eris
cd /opt/eris
```

**GPU hosts only** (skip for CPU-only nodes):

```bash
nvidia-smi
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
nvidia-ctk cdi list
```

Prefer **Podman + Quadlet** on the VM (systemd owns the container).

---

## First install — CPU-only node (no NVIDIA)

Use this on a VM without a GPU. Builds the smaller `runtime-cpu` image (no CUDA packages), sets `ERIS_CLOUD_GPU=false`, and does **not** request NVIDIA devices. Inference is slower; parallelism defaults to **1**.

```bash
cd /opt/eris
./cloud-agent/scripts/rebuild.sh --cpu --install
```

Manual equivalent:

```bash
cd /opt/eris
podman build --target runtime-cpu -t eris-cloud-agent:latest ./cloud-agent

sudo mkdir -p /etc/containers/systemd
sudo cp cloud-agent/deploy/eris-cloud-agent-cpu.container \
  /etc/containers/systemd/eris-cloud-agent.container
sudo systemctl daemon-reload
sudo systemctl enable --now eris-cloud-agent.service

curl -sS http://127.0.0.1:6443/v1/health | jq '{ok,ready,gpuMode,localModel}'
# Expect gpuMode: "false" and localModel.gpu: false once ready
```

Docker Compose (CPU):

```bash
cd /opt/eris
./cloud-agent/scripts/rebuild.sh --cpu --compose
# or: docker compose -f cloud-agent/docker-compose.cpu.yml up -d --build
```

Classic systemd (no Quadlet):

```bash
podman build --target runtime-cpu -t eris-cloud-agent:latest ./cloud-agent
sudo cp cloud-agent/deploy/eris-cloud-agent-cpu.service /etc/systemd/system/eris-cloud-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now eris-cloud-agent.service
```

Rebuild later on a CPU node:

```bash
./cloud-agent/scripts/rebuild.sh --cpu
```

---

## First install — GPU (Quadlet)

```bash
cd /opt/eris

# Build image
podman build -t eris-cloud-agent:latest ./cloud-agent

# Install systemd unit
sudo mkdir -p /etc/containers/systemd
sudo cp cloud-agent/deploy/eris-cloud-agent.container /etc/containers/systemd/
sudo systemctl daemon-reload
sudo systemctl enable --now eris-cloud-agent.service

# Verify (first boot may download ~4.7 GB Composer Full)
systemctl status eris-cloud-agent.service --no-pager
curl -sS http://127.0.0.1:6443/v1/health | jq '{ok,ready,gpuMode,localModel}'
```

Or use the helper script (same steps):

```bash
cd /opt/eris
./cloud-agent/scripts/rebuild.sh --install
```

---

## Rebuild from CLI (common ops)

After pulling code changes on the VM:

```bash
cd /opt/eris
./cloud-agent/scripts/rebuild.sh
```

What it does:

1. `git pull` (optional; skip with `--no-pull`)
2. `podman build -t eris-cloud-agent:latest ./cloud-agent`
3. Restart `eris-cloud-agent.service` (Quadlet) or recreate the container
4. Print `/v1/health`

### Useful flags

| Flag | Meaning |
|------|---------|
| `--install` | Also copy Quadlet unit + `daemon-reload` + enable |
| `--cpu` | CPU-only image (`runtime-cpu`) + CPU Quadlet (no NVIDIA) |
| `--no-pull` | Do not `git pull` (build local tree only) |
| `--cuda 13.1` | Build with `INSTALL_CUDA_VERSION=13.1` (must be ≤ host driver; ignored with `--cpu`) |
| `--docker` | Use `docker` instead of `podman` |
| `--compose` | `docker compose up -d --build` (uses `docker-compose.cpu.yml` with `--cpu`) |

Examples:

```bash
# Rebuild only (no git pull)
./cloud-agent/scripts/rebuild.sh --no-pull

# CPU-only rebuild
./cloud-agent/scripts/rebuild.sh --cpu --no-pull

# Newer CUDA libs in the image
./cloud-agent/scripts/rebuild.sh --cuda 13.1

# Docker Compose path
./cloud-agent/scripts/rebuild.sh --docker --compose
./cloud-agent/scripts/rebuild.sh --cpu --compose
```

### Manual rebuild (no script)

```bash
cd /opt/eris
git pull
podman build -t eris-cloud-agent:latest ./cloud-agent
sudo systemctl restart eris-cloud-agent.service
curl -sS http://127.0.0.1:6443/v1/health | jq '{ok,ready,localModel}'
```

---

## Image enhancements (what you get)

1. **Reproducible builds** — `npm ci` from `package-lock.json`
2. **Clean shutdown** — `tini` + `SIGTERM` graceful drain
3. **Resumable model download** — HTTP Range for Composer Full (~4.7 GB)
4. **`ready` in health** — process up (`ok`) vs model can take jobs (`ready`)
5. **Easier ops** — compose file, 600s health start period, `INSTALL_CUDA_VERSION` build arg

## Patch artifacts (Apply changes in Eris)

Finished jobs expose a file patch bundle:

```bash
curl -sS "http://127.0.0.1:6443/v1/jobs/<job-id>/artifacts" | jq '{jobId,truncated,files:[.files[].path]}'
```

Desktop Eris → Agents → **Apply changes** downloads that bundle into Diff Review.

---

## Health & GPU checks

```bash
# API
curl -sS http://127.0.0.1:6443/v1/health | jq .

# Expect ready:true once the GGUF is loaded
curl -sS http://127.0.0.1:6443/v1/health | jq '.ready,.localModel.status,.localModel.gpu'

# GPU inside the container
podman exec eris-cloud-agent npx --no node-llama-cpp inspect gpu
```

Model files live on the volume (survive rebuilds):

```bash
podman volume inspect eris-cloud-data
# path typically under /var/lib/containers/storage/volumes/...
```

---

## Logs & restart

```bash
journalctl -u eris-cloud-agent.service -f
sudo systemctl restart eris-cloud-agent.service
podman logs -f eris-cloud-agent
```

Stop / remove a leftover manual container before Quadlet owns the name:

```bash
podman rm -f eris-cloud-agent 2>/dev/null || true
sudo systemctl restart eris-cloud-agent.service
```

---

## Environment (optional)

Set in the Quadlet file (`/etc/containers/systemd/eris-cloud-agent.container`) or `-e` flags:

| Variable | Default | Notes |
|----------|---------|--------|
| `ERIS_CLOUD_PUBLIC_URL` | `http://agents.ericservic.es:6443` | URL clients use |
| `ERIS_CLOUD_GPU` | `auto` (GPU image) / `false` (CPU image) | `auto` / `cuda` / `vulkan` / `false` / `cpu` |
| `ERIS_CLOUD_MAX_PARALLEL` | `2` | Concurrent jobs |
| `ERIS_CLOUD_DATA` | `/var/lib/eris-cloud` | Models + workspaces |
| `ERIS_CLOUD_ALLOW_ANONYMOUS` | _(unset)_ | `1` = allow unauthenticated jobs (dev only) |
| `ERIS_CLOUD_ERIS_API_BASE` | `https://www.ericservic.es/api/eris/v1` | Bearer token validation (`me.php`) |
| `ERIS_CLOUD_FREE_JOBS_PER_DAY` | `5` | Free-plan daily enqueue cap |
| `ERIS_CLOUD_MAX_CONCURRENT_FREE` | `1` | Free-plan concurrent jobs |
| `ERIS_CLOUD_MAX_CONCURRENT_PRO` | `3` | Pro-plan concurrent jobs |
| `ERIS_CLOUD_LLM_BASE` | _(unset)_ | Optional remote OpenAI-compatible API |

After editing the Quadlet unit:

```bash
sudo systemctl daemon-reload
sudo systemctl restart eris-cloud-agent.service
```

---

## Firewall

Allow inbound **6443/tcp** from Eris clients (or terminate on a reverse proxy). Plain HTTP — no certificate required for the default client URL.
