# Eris feedback

Help → Report a Bug submits to the EricServic.es feedback relay, which creates issues in EricServices-Repo/Eris. The desktop never receives a shared GitHub issue-creation credential. User GitHub credentials are not used for feedback.

The client posts the redacted title/body and fixed repository to `/api/eris/v1/feedback.php`; an optional EricServic.es bearer token identifies the account. Requests time out after 20 seconds. Only an exact GitHub issue URL in EricServices-Repo/Eris is accepted as success. Relay errors explain that the report could not be submitted and can be retried; no report is recorded as submitted without a valid issue URL.

The relay must keep its issue-creation credential on the server, limited to Issues access on the intended repository. Its deployment is owned by the website repository; desktop builds do not configure it.

Both desktop builders exclude `resources/eris-feedback-token*`. The shared after-pack hook rejects legacy credential filenames and GitHub-token-shaped bytes, including ASAR payloads, without printing values. CI no longer injects a feedback secret. Synthetic regression fixtures exercise filenames and tokens crossing scan chunk boundaries.

If an older release distributed a shared token, revoke/rotate it server-side and inspect/remove affected release assets. This implementation did not inspect real secret values or establish historical exposure.
