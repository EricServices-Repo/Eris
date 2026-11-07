# Eris recovery runbooks

Reviewed against main `067470e` on 2026-11-07. These procedures cover the desktop, Eris-Dev and their local evidence. Use a disposable workspace for acceptance exercises. Preserve the original failing run and its version before retrying.

## Capture the failure

Record the app version, platform, selected agent, model policy, actual model, task/request ID, last tool, elapsed time, effective context allocation and terminal reason. Record whether the run changed files and whether verification finished. Include the first failing stage and any storage warning.

Use Help → Report a Bug to prepare a report. Review the report and attachments for private code, prompts, paths and credentials before submitting. Keep the returned issue URL. A submission timeout can occur after issue creation, so check existing issues before sending again. See [feedback behavior](FEEDBACK.md) and [usage](ERIS_USAGE.md).

Escalate to the runtime maintainer when the same scoped fixture fails after one controlled retry. Escalate credential exposure to the security owner immediately. The release tracker [#311](https://github.com/EricServices-Repo/Eris/issues/311) must assign the named engineering, QA, security and release owners before candidate signoff.

## Low VRAM or Metal memory pressure

**Recognize** allocation failures, worker errors during context creation, CPU spill, repeated loading, or an image worker exhausting shared memory.

1. Stop the active generation and wait for it to terminate. Save editor buffers and inspect any applied edits.
2. Close other inference workloads. On a unified-memory Mac, account for the application's RAM, image generation and other applications as well as the model.
3. In model settings, reduce the requested context or select a smaller downloaded model. Retry one small question before the original workload.
4. Check the effective allocation in the Context Memory inspector. Record requested, forecast and effective capacity separately.
5. For images, stop concurrent chat/image inference and use the configured image model's supported settings. Capture image preflight and worker errors if the small retry also fails.

**Success** means the small request completes, the application responds to Stop, and the original workspace changes remain available. Escalate repeated process exits, an unresponsive UI, or pressure that persists after workers terminate. Hardware capacity must be measured on the affected host.

Source checks exercise [native context allocation](../tests/llama-worker-context.test.ts), [device classification](../tests/inference-device-class.test.ts), and [image safeguards](../tests/image-generation.test.ts).

## Model corruption or incomplete download

**Recognize** an invalid model header, failed hash/size validation, interrupted download or worker failure while reading weights.

1. Record the model ID, filename and download error. Stop active inference using that model.
2. Open Settings → Models and select the model's download/management page. Use the app's validation and download controls to repair or download the selected model again.
3. If manual intervention is needed, quit the application first and copy the affected file and diagnostic metadata to a separate backup location. Confirm the exact model path from the catalog before replacing that file.
4. Reopen the app, refresh the catalog and send one small request using the repaired model.

**Success** means validation and a small generation complete. Escalate repeated hash failures, downloads resuming at an invalid offset, or disagreement between the catalog and the selected file. Preserve credentials in the operating-system vault.

Source checks exercise [download range recovery](../tests/model-download-resume-range.test.ts) and [shared model discovery](../tests/eris-dev-model-discovery.test.ts).

## Worker crash, stuck task or repeated recovery

1. Use Stop and capture the final task state. Preserve the original request and model identity.
2. Inspect the workspace diff and any checkpoint before retrying. A stopped or incomplete run may have applied edits.
3. If the app remains responsive, send one short request after the worker has terminated. If it is unresponsive, quit and reopen it, then inspect the recovered task and workspace.
4. A recovered interrupted job should remain stopped. Start a new attempt only after reconciling its existing effects and selecting a model that fits the host.
5. If checkpoint or task persistence failed after a mutation, inspect disk and storage before further agent edits. Treat missing evidence as an unresolved result.

**Success** means one terminal result, released owned work, preserved edits and a usable subsequent request. Escalate a task that reactivates after Stop, a child that continues writing after cancellation, or any replay of an uncertain effect.

Source checks exercise [terminal event handling](../tests/chat-job-terminal.test.ts), [durable admission/restart](../tests/chat-admission.test.ts), [child cancellation](../tests/background-cancellation.test.ts), and [agent effects](../tests/chat-agent-smoke.test.ts).

## Storage, migration or receipt failure

1. Stop new writes. Record the exact failure and affected workspace/profile path.
2. Inspect Settings → General → Private evidence storage. Record the inventory and available disk space. Resolve disk-full, permission or locked-file conditions through the operating system.
3. Quit Eris before copying the complete affected profile/workspace state to a backup. Preserve SQLite sidecar files with their database when present. Keep the original files for diagnosis.
4. Reopen the same version first. If the error concerns migration or corruption, escalate with the preserved data rather than repeatedly importing or recreating it.
5. Compare the workspace diff to the last known checkpoint. Confirm canonical chat/task data is readable and one new save survives a restart in a disposable fixture.

**Success** means saves persist across restart and the original evidence is retained. A cleanup operation must respect active references. Escalate migration failures, silent loss of chat history, or a saved-success message after a failed write.

Source checks exercise [evidence storage](../tests/evidence-storage.test.ts), [project-fact storage](../tests/project-fact-storage.test.ts), and [chat persistence](../tests/chat-database.test.ts).

## Broken update

1. Record the installed version, offered version, channel and updater error. Save work and inspect active task changes.
2. Check Settings → General → Updates and the release's published artifacts. Verify the platform and architecture before installing.
3. If automatic installation fails, quit Eris and use the matching installer from the [official releases](https://github.com/EricServices-Repo/Eris/releases). Back up the profile first when a schema transition is involved.
4. Confirm the application version after launch, then test model discovery, one saved conversation and one disposable edit. Preserve the original updater logs.

**Success** means the expected version starts and existing user data remains readable. Escalate signature failures, missing updater metadata, wrong-platform artifacts or an unsupported downgrade. The release owner controls feed pause and replacement artifacts through the documented release process. See [updates](UPDATES.md) and [signing](SIGNING.md).

## Revoked or expired provider credentials

1. Stop requests to the affected connection and record its name and endpoint without copying its token into a report.
2. Replace or remove the credential through Settings. Revoke exposed credentials at the provider as well.
3. Refresh the connection's model catalog and send a small request to the intended endpoint. Verify that the reported actual model/destination matches the selected connection.
4. Inspect the redacted support report before submitting. If authentication still fails, escalate the status code, timestamp and connection ID through the support process.

**Success** means the old credential cannot authorize new requests and the replacement works through the intended connection. Preserve stored-value confidentiality when exporting diagnostics. Source checks exercise [redacted report boundaries](../tests/bug-report-sanitize.test.ts) and [feedback validation](FEEDBACK.md).

## Acceptance record

For each installed-app exercise, record the candidate commit and artifact hash, OS/hardware/model fingerprint, run IDs, exact procedure, applied changes, terminal state, independent checks and remaining failures. Mark a procedure not evaluated when its platform, credentials or model are unavailable.

The source test commands below exercise disposable fixtures for the runbook boundaries:

```sh
npx vitest run tests/llama-worker-context.test.ts tests/inference-device-class.test.ts tests/image-generation.test.ts tests/model-download-resume-range.test.ts tests/eris-dev-model-discovery.test.ts
npx vitest run tests/chat-job-terminal.test.ts tests/chat-admission.test.ts tests/background-cancellation.test.ts tests/chat-agent-smoke.test.ts
npx vitest run tests/evidence-storage.test.ts tests/project-fact-storage.test.ts tests/chat-database.test.ts
```

Installed macOS/Windows walkthroughs, real allocation pressure, real provider revocation, updater installation and release-owner signoff require their own recorded acceptance. Track those under [#351](https://github.com/EricServices-Repo/Eris/issues/351).
