# Eris in-app bug reports → GitHub Issues

End users submit bugs from **Help → Report a Bug** (or Settings → General).
Reports land on the public issues repo
[`EricServices-Repo/Eris-feedback`](https://github.com/EricServices-Repo/Eris-feedback).
No GitHub App, no user PAT, no browser draft.

## Preferred path: EricServic.es relay

1. Client `POST`s `{ title, body }` to  
   `https://www.ericservic.es/api/eris/v1/feedback.php`
2. Optional `Authorization: Bearer eseris_…` attaches the EricServic.es username
3. Server uses `$ERIS_FEEDBACK_GITHUB_TOKEN` (config.local.php / env) to create the issue
4. Rate limit: 8 submissions / hour / IP

Website files (EricServices site repo):

- `api/eris/v1/feedback.php`
- `config.php` + `config.local.php` → `$ERIS_FEEDBACK_GITHUB_TOKEN`

Token scope: fine-grained PAT limited to **Eris-feedback** → **Issues: Read and write**.

Deploy `feedback.php` (and the config token) before relying on this path in production.
Until then the client falls through to the built-in credential below.

## Fallback: built-in client credential

If the relay is unreachable / not configured (404/503), the packaged app may use a
build-time credential:

| Source | When |
|--------|------|
| `ERIS_FEEDBACK_GITHUB_TOKEN` env | Dev / CI |
| `resources/eris-feedback-token` | Packaged via electron-builder `extraResources` |

CI (`release.yml`) writes that file from secret `ERIS_FEEDBACK_GITHUB_TOKEN` before
`electron-builder`. The file is gitignored.

Same PAT scope as the server token (Issues only on `Eris-feedback`). Rotate if leaked;
prefer keeping the relay live so clients do not need a shipped token long-term.

## What is not used

- GitHub Apps / OAuth device flow for feedback
- Settings → GitHub user token
- Opening a prefilled Issues “new” URL in the browser
