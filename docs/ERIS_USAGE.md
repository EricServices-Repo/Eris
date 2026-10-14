# Eris profile usage (www.ericservic.es)

Daily usage (chat requests, tokens, Cloud Agent jobs) is stored on the user’s **EricServic.es profile** so Free-tier caps apply across devices and Cloud Agents.

## API

Deploy: `api/eris/v1/usage.php`  
Stub: `cloud-agent/website-stubs/api/eris/v1/usage.php`

| Method | Auth | Body / query | Result |
|--------|------|--------------|--------|
| `GET` | Bearer `eseris_…` | `?day=YYYY-MM-DD` | `{ usage, days }` for profile |
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

- **Eris desktop** — after each local record, debounced POST delta; pulls on login + Usage panel refresh. Entitlements use `max(local, profile)`.
- **Cloud Agent** — on free-plan enqueue, POST `{ cloudJobs: 1 }`; gate uses `max(local worker, profile)`.

## Production wiring

Replace `eris_usage_resolve_user()` in the stub with real token → username / plan from Control Hub (`me.php`). Store under username, not token hash.

Optional: show the same counters on `/account/eris.php`.
