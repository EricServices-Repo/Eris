# Eris in-app bug reports → GitHub Issues

End users submit bugs from **Help → Report a Bug** (or Settings → General).
Reports land as issues on
[`EricServices-Repo/Eris`](https://github.com/EricServices-Repo/Eris/issues).
No GitHub App, no user PAT, no browser draft.

## How a report is filed

1. If this build has a feedback credential, the client creates the issue directly on
   [`EricServices-Repo/Eris`](https://github.com/EricServices-Repo/Eris/issues).
2. Otherwise the client `POST`s `{ title, body, owner, repo }` to
   `https://www.ericservic.es/api/eris/v1/feedback.php`.
   Optional `Authorization: Bearer eseris_…` attaches the EricServic.es username.
3. The relay must create the issue on `EricServices-Repo/Eris`. A response whose
   issue URL is not under `https://github.com/EricServices-Repo/Eris/issues` is rejected.
4. Rate limit on the relay: 8 submissions / hour / IP.

Website files (EricServices site repo):

- `api/eris/v1/feedback.php`
- `config.php` + `config.local.php` → `$ERIS_FEEDBACK_GITHUB_TOKEN`

Token scope: fine-grained PAT limited to **EricServices-Repo/Eris** → **Issues: Read and write**.
Deploy the updated `feedback.php` (`$repo = 'Eris'`) before relying on the website relay.

## Fallback: EricServic.es relay

If this build has no feedback credential, the packaged app uses the relay above.
`feedback.php` in the EricServices site must keep `$repo = 'Eris'`.

| Source | When |
|--------|------|
| `ERIS_FEEDBACK_GITHUB_TOKEN` env | Dev / CI |
| `resources/eris-feedback-token` | Packaged via electron-builder `extraResources` |

CI (`release.yml`) writes that file from secret `ERIS_FEEDBACK_GITHUB_TOKEN` before
`electron-builder`. The file is gitignored.

Same PAT scope as the server token (Issues on `EricServices-Repo/Eris`). Rotate if leaked;
prefer keeping the relay live so clients do not need a shipped token long-term.

## What is not used

- GitHub Apps / OAuth device flow for feedback
- Settings → GitHub user token
- Opening a prefilled Issues “new” URL in the browser
