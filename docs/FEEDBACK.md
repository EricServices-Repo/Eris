# Eris feedback

Help → Report a Bug submits to the EricServic.es feedback relay, which creates issues in the configured Eris inbox. The desktop never receives a shared GitHub issue-creation credential. User GitHub credentials are not used for feedback.

The client posts the redacted title/body and fixed repository to `/api/eris/v1/feedback.php`; an optional EricServic.es bearer token identifies the account. Requests time out after 20 seconds. The client requests EricServices-Repo/Eris. The deployed relay can instead use the dedicated EricServices-Repo/Eris-feedback inbox. Only HTTPS issue URLs in these two repositories are accepted as success; the client preserves the actual repository in the returned link and history. GitHub-style `html_url` and client-style `htmlUrl` response fields are supported. The issue number comes from the validated URL, and a conflicting response number is rejected. Transport failures explain that submission could not be confirmed, because a timeout does not prove the server failed to create an issue. Invalid success responses warn that the report may already exist and should not be submitted again before contacting support; no report is recorded as submitted without a valid issue URL.

The relay must keep its issue-creation credential on the server, limited to Issues access on its configured Eris inbox. Its deployment is owned by the website repository; desktop builds do not configure it.

Both desktop builders exclude `resources/eris-feedback-token*`. The shared after-pack hook rejects legacy credential filenames and GitHub-token-shaped bytes, including ASAR payloads, without printing values. CI no longer injects a feedback secret. Synthetic regression fixtures exercise filenames and tokens crossing scan chunk boundaries.

If an older release distributed a shared token, revoke/rotate it server-side and inspect/remove affected release assets. This implementation did not inspect real secret values or establish historical exposure.
