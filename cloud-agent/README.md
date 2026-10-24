# Eris Cloud Agent

Dockerized worker that runs Cloud Agent jobs for **every Eris install**.

Inference runs **inside the container** with **Composer Full** (Qwen2.5-Coder-7B GGUF) via `node-llama-cpp`. Desktop Eris keeps **Composer Lite** locally; Cloud Agents use the full model. No external LLM API is required.

**GPU:** The image includes CUDA libraries. With NVIDIA drivers + Container Toolkit on the host, the model runs on GPU (`ERIS_CLOUD_GPU=auto`). Without a GPU it falls back to CPU.

**VM install / rebuild:** see **[INSTALL.md](./INSTALL.md)** — GPU or **CPU-only** (`./cloud-agent/scripts/rebuild.sh --cpu --install`). The Eris GitHub repo is **private**; clone with `gh auth`, SSH deploy key, or a PAT (anonymous clone will fail).

## Client URL (no user configuration)

```
API:    https://agents.ericservic.es:443
Status: http://agents.ericservic.es/          (port 80 via nginx → :8080; Force kill all)
```

Clients use **TLS on port 443**. nginx proxies that to the container upstream on **6443**. Status page host **80** → container **8080**.

## Image improvements

1. Reproducible `npm ci` install from `package-lock.json`
2. `tini` as PID 1 + `SIGTERM` graceful drain (15s force exit)
3. Resumable Composer Full download (HTTP Range) into the data volume
4. Health reports `ready` when the local model (or remote LLM) can take jobs
5. Easier ops: `docker-compose.yml`, 600s health start period, `INSTALL_CUDA_VERSION` build arg, VM rebuild script

### Rebuild on the VM (fast path)

```bash
cd /opt/eris   # or your clone path
./cloud-agent/scripts/rebuild.sh
# first time on a host:
./cloud-agent/scripts/rebuild.sh --install
```

## Build & run (CPU-only)

No NVIDIA driver or toolkit required. Clone the **private** repo first (see [INSTALL.md](./INSTALL.md)), then:

```bash
cd /opt/eris   # authenticated clone of EricServices-Repo/Eris
./cloud-agent/scripts/rebuild.sh --cpu --install
# without git credentials on the VM:
./cloud-agent/scripts/rebuild.sh --cpu --install --no-pull

# Compose:
docker compose -f cloud-agent/docker-compose.cpu.yml up -d --build
```

Health should report `gpuMode: "false"`. Jobs still use Composer Full; expect slower step times and keep `ERIS_CLOUD_MAX_PARALLEL=1`.

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
# optional newer CUDA libs: --build-arg INSTALL_CUDA_VERSION=13.1

# Compose (Docker Engine + NVIDIA toolkit)
docker compose -f cloud-agent/docker-compose.yml up -d --build

# Manual run with GPU
podman run -d --name eris-cloud-agent \
  --restart unless-stopped \
  --device nvidia.com/gpu=all \
  --security-opt=label=disable \
  --stop-signal=SIGTERM \
  -p 6443:6443 \
  -e ERIS_CLOUD_PUBLIC_URL=https://agents.ericservic.es:443 \
  -e ERIS_CLOUD_GPU=auto \
  -v eris-cloud-data:/var/lib/eris-cloud \
  eris-cloud-agent
```

Verify GPU inside the container:

```bash
podman exec eris-cloud-agent npx --no node-llama-cpp inspect gpu
curl -sS http://127.0.0.1:6443/v1/health | jq '{ready,gpuMode,localModel}'
```

On first start the worker downloads Composer Full (~4.7 GB) into `/var/lib/eris-cloud/models` (resumes if interrupted).

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

## Auth

Job endpoints require `Authorization: Bearer <EricServic.es token>` (validated via `me.php`).  
Set `ERIS_CLOUD_ALLOW_ANONYMOUS=1` for local/dev only. Health stays public.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/health` | Liveness + local model / GPU status (`authRequired`) |
| GET | `/v1/jobs` | List jobs for the authenticated owner |
| POST | `/v1/jobs` | Create job `{ goal, agentId?, repoUrl?, branch?, githubToken?, openPr?, files?, resumeFromJobId? }` |
| GET | `/v1/jobs/:id` | Job status / tools / answer |
| GET | `/v1/jobs/:id/events` | SSE stream of job updates |
| POST | `/v1/jobs/:id/continue` | Resume from checkpoint (new job id) |
| GET | `/v1/jobs/:id/artifacts` | Patch bundle `{ files: [{ path, content, before }] }` for Eris Diff Review |
| POST | `/v1/jobs/:id/stop` | Cancel one job |
| POST | `/v1/jobs/stop-all` | Cancel all queued/running jobs for the authenticated owner |
| POST | `/admin/kill-all` or `/v1/admin/kill-all` | Force-kill **every** active job (admin token; auto-created at `/var/lib/eris-cloud/admin.token`) |
| GET | `/status` | Status HTML (includes **Force kill all**) — use when host `:80` is blocked |
| GET | `/v1/metrics` | Counters + recent audit (auth required) |

Health includes `ready`, `inference: "local"`, `gpuMode`, and `localModel: { status, modelId, modelName, gpu }`. `ok` means the process is up; `ready` means jobs can run.

Jobs persist across restarts; running jobs re-queue and resume from checkpoints when possible. Shell `run` tools are sandboxed. Private repos use a short-lived `githubToken`; `openPr: true` pushes a branch and opens a PR.

When a job finishes, Eris can **Apply changes** to download `/artifacts` and open Diff Review in the desktop app.

## Required command isolation

The shell tool now fails closed unless Linux provides bubblewrap, unprivileged
user/mount/PID/network namespaces, and a writable delegated cgroup v2 subtree at
`ERIS_CLOUD_CGROUP_ROOT` under `/sys/fs/cgroup/`. The service must be permitted to
create child cgroups with memory, swap, PID and CPU controllers and `cgroup.kill`.
Each command joins its own group before executing untrusted code. Limits are 4 GiB
aggregate memory, zero swap, 128 tasks, one CPU quota, 180 seconds wall time,
64 MiB per file/temporary filesystem and bounded output. Cancellation kills all
descendants, including processes that change session/group.

The Docker image installs the tools. The sample Compose files do not automatically
grant host cgroup delegation or namespace permissions. Until ops configures and
validates those boundaries, `run` returns an explicit isolation error; there is no
service-shell fallback. Do not solve this by broadly mounting service credentials
or the host filesystem. Validate peer-file denial, synthetic environment-secret
denial, network denial, aggregate resource exhaustion and descendant cancellation
on the actual deployment before accepting untrusted tenants.

Only the job/project root and read-only system runtime directories enter the
namespace; service data, peer workspaces and credentials are absent. Verification
contracts receive a read-only workspace. Git metadata is hidden from shell/file
tools, and publishing uses a separate authority check. Paths reject symlinks,
traversal and absolute/drive variants; reads are bounded before allocation.

Health `ready` describes inference readiness, not certification of command
isolation. `taskContractVersion` remains 1: v2 scope/tool/resume enforcement is
implemented, but command-artifact baseline and obligation-result conformance still
need qualification before advertising version 2. Desktop v2 tasks fall back locally
with the same permissions and an explanation. No deployment changes or Linux
isolation certification were made by this desktop implementation pass.
