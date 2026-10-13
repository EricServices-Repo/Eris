# EricServic.es Cloud Agents API stubs

Copy `api/eris/v1/cloud-agents/` into the EricServices website document root so these URLs exist:

- `https://www.ericservic.es/api/eris/v1/cloud-agents/admin/create.php`
- `…/admin/list.php`
- `…/admin/config.php`
- `…/enroll.php`
- `…/heartbeat.php`
- `…/config.php`

Data defaults to `data/eris-cloud-agents/agents.json` (override with `ERIS_CLOUD_AGENTS_DATA`).

Wire `eris_ca_require_admin()` in `_store.php` to your real `eseris_` admin session before production.

See [docs/CLOUD_AGENT_FLEET.md](../../docs/CLOUD_AGENT_FLEET.md) for the full contract and agent env vars.
