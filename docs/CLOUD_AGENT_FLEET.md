# Cloud Agent fleet management (EricServic.es)

Manage Cloud Agent workers from **EricServic.es Admin**. Each worker heartbeats to the site, pulls config revisions, and can accept pushed settings.

## Flow

```
┌─────────────────────┐         enroll / heartbeat / config
│  EricServic.es      │◄──────────────────────────────────┐
│  Admin → Cloud Agents│                                   │
└─────────────────────┘                                   │
                                                          │
┌─────────────────────┐    PUT /v1/fleet/config (optional) │
│  Cloud Agent VM     │───────────────────────────────────┘
│  0.2.21+            │    also polls heartbeat.php every 60s
└─────────────────────┘
```

1. Admin creates an agent on the website → gets a one-time **enroll token**.
2. Ops sets `ERIS_CLOUD_FLEET_ENROLL_TOKEN` on the VM (or `POST /v1/fleet/enroll`) → agent receives `agentId` + `agentSecret`, stored in `/var/lib/eris-cloud/fleet.json`.
3. Agent POSTs heartbeats; platform may return a newer `config` + `configRevision`.
4. Website can also **push** config to a reachable agent: `PUT http://agent:6443/v1/fleet/config` with `X-Eris-Agent-Secret`.

## Website API (deploy under `/api/eris/v1/cloud-agents/`)

Copy stubs from `cloud-agent/website-stubs/api/eris/v1/cloud-agents/` into the EricServices site repo.

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `POST …/admin/create.php` | Admin Bearer `eseris_…` | Create agent + enroll token |
| `GET …/admin/list.php` | Admin Bearer | List agents + last heartbeat |
| `POST …/admin/config.php` | Admin Bearer | Set settings / bump revision (and optionally push) |
| `POST …/enroll.php` | Enroll token | Exchange for agentId + agentSecret |
| `POST …/heartbeat.php` | Agent id+secret | Status in; config out if newer |
| `GET …/config.php` | Agent id+secret | Current config revision |

### Auth headers (agent → site)

```
X-Eris-Agent-Id: agt_…
X-Eris-Agent-Secret: …
```

### Remote settings (safe subset)

```json
{
  "maxParallel": 1,
  "maxThreads": 3,
  "contextSize": 4096,
  "warmOnStart": true,
  "freeJobsPerDay": 5,
  "maxConcurrentFree": 1,
  "maxConcurrentPro": 3,
  "maxQueue": 100,
  "maxSteps": 24,
  "publicBaseUrl": "http://agents.ericservic.es:6443",
  "llmBase": "",
  "llmModel": "composer",
  "llmKey": "",
  "allowAnonymous": false,
  "displayName": "prod-cpu-1"
}
```

CPU agents clamp `maxParallel` to **1**. `llmKey` is never shown on the public status page.

## Agent env

| Variable | Purpose |
|----------|---------|
| `ERIS_CLOUD_FLEET_ENROLL_TOKEN` | One-time enroll (cleared after success recommended) |
| `ERIS_CLOUD_FLEET_AGENT_ID` | Skip enroll; use existing identity |
| `ERIS_CLOUD_FLEET_AGENT_SECRET` | Pair with agent id |
| `ERIS_CLOUD_FLEET_NAME` | Display name sent at enroll |
| `ERIS_CLOUD_FLEET_SYNC_MS` | Heartbeat interval (default 60000) |
| `ERIS_CLOUD_ERIS_API_BASE` | Default `https://www.ericservic.es/api/eris/v1` |

## Agent endpoints

| Method | Path | Auth |
|--------|------|------|
| GET | `/v1/fleet` | Public (no secrets) |
| POST | `/v1/fleet/enroll` | enrollToken in body |
| PUT/POST | `/v1/fleet/config` | Agent secret or admin token |

## Website UI (suggested)

**Admin → Cloud Agents**

- List: name, agentId, last seen, version, ready, running/queued
- Add agent → show enroll token once + install snippet
- Edit settings → save revision → push if `publicBaseUrl` reachable, else wait for next heartbeat

## Install snippet (shown after create)

```bash
# On the Cloud Agent VM
sudo tee -a /etc/containers/systemd/eris-cloud-agent.container >/dev/null <<'EOF'
Environment=ERIS_CLOUD_FLEET_ENROLL_TOKEN=enr_REPLACE_ME
Environment=ERIS_CLOUD_FLEET_NAME=prod-cpu-1
EOF
sudo systemctl daemon-reload
sudo systemctl restart eris-cloud-agent.service
```
