# Eris Cloud Agent

Dockerized worker that runs Cloud Agent jobs for **every Eris install**.

Inference runs **inside the container** with a local GGUF (Composer Lite / Qwen2.5-Coder-1.5B) via `node-llama-cpp`. No external LLM API is required.

**GPU:** The image includes CUDA libraries. With NVIDIA drivers + Container Toolkit on the host, the model runs on GPU (`ERIS_CLOUD_GPU=auto`). Without a GPU it falls back to CPU.

## Client URL (no user configuration)

```
http://agents.ericservic.es:6443
```

Plain HTTP — no TLS certificate required. Container listen port: **6443**.

## Build & run (GPU)

Host prerequisites:

```bash
# NVIDIA driver + toolkit (once)
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
nvidia-ctk cdi list
```

```bash
# from repo root
podman build -t eris-cloud-agent ./cloud-agent
# or: docker build -t eris-cloud-agent ./cloud-agent

# Manual run with GPU
podman run -d --name eris-cloud-agent \
  --restart unless-stopped \
  --device nvidia.com/gpu=all \
  --security-opt=label=disable \
  -p 6443:6443 \
  -e ERIS_CLOUD_PUBLIC_URL=http://agents.ericservic.es:6443 \
  -e ERIS_CLOUD_GPU=auto \
  -v eris-cloud-data:/var/lib/eris-cloud \
  eris-cloud-agent
```

Verify GPU inside the container:

```bash
podman exec eris-cloud-agent npx --no node-llama-cpp inspect gpu
curl -sS http://127.0.0.1:6443/v1/health | jq '.localModel.gpu,.gpuMode'
```

On first start the worker downloads Composer Lite (~1 GB) into `/var/lib/eris-cloud/models`.

| `ERIS_CLOUD_GPU` | Behavior |
|------------------|----------|
| `auto` (default) | Prefer CUDA/Vulkan; fall back to CPU |
| `cuda` | Force CUDA |
| `vulkan` | Force Vulkan |
| `false` / `cpu` | CPU only |

## Run as a systemd service (survives closing the CLI)

Prefer **Podman Quadlet** so systemd owns the container (GPU device included):

```bash
# 1) Build image on the host
podman build -t eris-cloud-agent ./cloud-agent

# 2) Install unit (system-wide)
sudo mkdir -p /etc/containers/systemd
sudo cp cloud-agent/deploy/eris-cloud-agent.container /etc/containers/systemd/
sudo systemctl daemon-reload
sudo systemctl enable --now eris-cloud-agent.service

# 3) Check
systemctl status eris-cloud-agent.service
curl -sS http://127.0.0.1:6443/v1/health
```

Rootless user service (keeps running after logout with linger):

```bash
mkdir -p ~/.config/containers/systemd
cp cloud-agent/deploy/eris-cloud-agent.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user enable --now eris-cloud-agent.service
loginctl enable-linger "$USER"
```

Fallback without Quadlet: `cloud-agent/deploy/eris-cloud-agent.service` → copy to `/etc/systemd/system/` and `enable --now`.

If a previous manual container is still around: `podman rm -f eris-cloud-agent`.

### Optional remote override (ops only)

```bash
-e ERIS_CLOUD_LLM_BASE=https://api.openai.com/v1 \
-e ERIS_CLOUD_LLM_KEY=sk-... \
-e ERIS_CLOUD_LLM_MODEL=gpt-4o-mini
```

When `ERIS_CLOUD_LLM_BASE` is unset (default), the local GGUF is used.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/health` | Liveness + local model / GPU status |
| GET | `/v1/jobs` | List jobs |
| POST | `/v1/jobs` | Create job `{ goal, agentId?, repoUrl?, branch?, files? }` |
| GET | `/v1/jobs/:id` | Job status / tools / answer |
| POST | `/v1/jobs/:id/stop` | Cancel |

Health includes `inference: "local"`, `gpuMode`, and `localModel: { status, modelId, modelName, gpu }`.
