# Eris feedback

Reviewed against integrated `main` `0a54629` on 2026-11-01. Package version: **0.6.10**; published tag `v0.6.10` is the older immutable `f14e409` source. Later source changes require another build.

Help → Report a Bug submits to the EricServic.es feedback relay, which creates issues in the configured Eris inbox. The desktop never receives a shared GitHub issue-creation credential. User GitHub credentials are not used for feedback.

The client posts the redacted title/body and fixed repository to `/api/eris/v1/feedback.php`; an optional EricServic.es bearer token identifies the account. Requests time out after 20 seconds. The client requests EricServices-Repo/Eris. The relay must create issues in that repository; Eris-feedback is not an accepted destination. Only HTTPS issue URLs in EricServices-Repo/Eris are accepted as success and recorded in history. GitHub-style `html_url` and client-style `htmlUrl` response fields are supported. The issue number comes from the validated URL, and a conflicting response number is rejected. Transport failures explain that submission could not be confirmed, because a timeout does not prove the server failed to create an issue. Invalid success responses warn that the report may already exist and should not be submitted again before contacting support; no report is recorded as submitted without a valid issue URL.

The relay must keep its issue-creation credential on the server, limited to Issues access on EricServices-Repo/Eris. Configure the relay destination as owner=EricServices-Repo and repo=Eris; remove any Eris-feedback override. Updating the desktop alone cannot change a server-side destination override. Its deployment is owned by the website repository; desktop builds do not configure it.

Both desktop builders exclude `resources/eris-feedback-token*`. The shared after-pack hook rejects legacy credential filenames and GitHub-token-shaped bytes, including ASAR payloads, without printing values. CI no longer injects a feedback secret. Synthetic regression fixtures exercise filenames and tokens crossing scan chunk boundaries.

If an older release distributed a shared token, revoke/rotate it server-side and inspect/remove affected release assets. This implementation did not inspect real secret values or establish historical exposure.

## Design boundary

Feedback submission is an external network effect through the relay, separate from model transport and agent tool authority. A validated issue URL proves only that a recognized issue reference was returned, not that every attachment/log field is safe or that a defect is reproduced. Keep redaction and ambiguous-submit/retry behavior distinct from successful issue creation. See [bug-report.ts](../electron/main/services/bug-report.ts) and [architecture](ARCHITECTURE.md).
