# Eris profile usage (www.ericservic.es)

Reviewed against integrated `main` `0a54629` on 2026-11-01. Package version: **0.6.10**; published tag `v0.6.10` is the older immutable `f14e409` source. Later source changes require another build.

The usage synchronization contract records chat requests, tokens and Cloud Agent jobs per calendar day on the user’s **EricServic.es profile**. Eris sums the last 30 days — the higher of this device and the profile for each day — and applies Free-tier caps to that rolling window.

## API

The client/stub contract targets www.ericservic.es at `api/eris/v1/usage.php` (Bearer device token, same as `/me.php`).

Migration: `sql/migrations/20261016_eris_usage_devices.sql` in the EricServices site.  
Stub: `cloud-agent/website-stubs/api/eris/v1/usage.php`

| Method | Auth | Body / query | Result |
|--------|------|--------------|--------|
| `GET` | Bearer `eseris_…` | `?day=YYYY-MM-DD&days=30` | `{ usage, days }` for profile (`days` is up to 30, max 90) |
| `POST` | Bearer `eseris_…` | `{ day, delta }` or `{ day, set }` | Merged day totals |

### Delta (preferred)

```json
{
  "day": "2026-10-13",
  "delta": {
    "requests": 1,
    "inputTokens": 1200,
    "outputTokens": 400,
    "cloudJobs": 0
  },
  "source": "eris-desktop"
}
```

Server **adds** deltas (multi-device safe).

### Fields

| Field | Meaning |
|-------|---------|
| `requests` | Chat / completion calls |
| `inputTokens` / `outputTokens` | Token usage (estimated or provider-reported) |
| `cloudJobs` | Cloud Agent enqueues |

## Clients

- **Eris desktop** — after each local record, debounced POST delta; pulls on login + Usage panel refresh. Entitlements use `sum(max(local, profile))` over the last 30 days. The Usage tab can still open any day in that window.
- **Cloud Agent** — on free-plan enqueue, POST `{ cloudJobs: 1 }`; gate uses `max(local worker, profile)`.

## Production wiring

Replace `eris_usage_resolve_user()` in the stub with real token → username / plan from Control Hub (`me.php`). Store under username, not token hash.

Optional: show the same counters on `/account/eris.php`.

## Evidence and model-routing distinction

Usage totals and entitlements are distinct from local routing outcomes/eval scores. Automatic model choice uses task-specific versioned evidence in the desktop; a billed/request token count is not an answer-quality score. Provider/native usage can be measured or estimated and must retain that provenance. Website deployment, account reconciliation and billing behavior require service-level acceptance, not a local scripted test.
