# Eris Cloud Agent

Dockerized worker that runs Cloud Agent jobs for **every Eris install**.

Inference runs **inside the container** with a local GGUF (Composer Lite / Qwen2.5-Coder-1.5B) via `node-llama-cpp`. No external LLM API is required.

## Client URL (no user configuration)

```
http://agents.ericservic.es:6443
```

Plain HTTP — no TLS certificate required. Container listen port: **6443**.

## Build & run

```bash
# from repo root
docker build -t eris-cloud-agent ./cloud-agent
# or: podman build -t eris-cloud-agent ./cloud-agent

podman run -d --name eris-cloud-agent \
  -p 6443:6443 \
  -e ERIS_CLOUD_PUBLIC_URL=http://agents.ericservic.es:6443 \
  -v eris-cloud-data:/var/lib/eris-cloud \
  eris-cloud-agent
```

On first start the worker downloads Composer Lite (~1 GB) into `/var/lib/eris-cloud/models` and loads it with CPU inference.

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
| GET | `/v1/health` | Liveness + local model status |
| GET | `/v1/jobs` | List jobs |
| POST | `/v1/jobs` | Create job `{ goal, agentId?, repoUrl?, branch?, files? }` |
| GET | `/v1/jobs/:id` | Job status / tools / answer |
| POST | `/v1/jobs/:id/stop` | Cancel |

Health includes `inference: "local"` and `localModel: { status, modelId, modelName }`.
