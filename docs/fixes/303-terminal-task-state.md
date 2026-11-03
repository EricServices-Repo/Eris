# #303 — Terminal chat tasks stay terminal (EX-02 slice)

The issue's EX-02 requires the task to "reject invalid transitions and late events
from older attempts", and its acceptance criteria say "late chunks/outcomes do not
revive the task" and "completion after cancellation is ignored or recorded as late
evidence, never a state resurrection".

## Defect

`chat-job-controller.ts` already froze the task **timeline** once it reached a
terminal phase. The job **snapshot** around it did not:

- `finishChatJob` overwrote any status. A task recorded as `done` became `failed`
  if a second outcome arrived, for example when the outer `chat:stream` catch ran
  after the publisher had already sent `chat:done`. A `stopped` task could become
  `done`. The snapshot then disagreed with its own timeline (status `failed`,
  timeline phase `done`).
- `recordChatJobEvent` kept applying `chat:answer`, `chat:status` and `chat:model`
  after the end. The persisted answer, the one replayed on reattach, could gain
  text that arrived after a stop.
- `markChatJobRunning` set any job back to `running`.

## Change

Once a job is `done`, `stopped`, `failed` or `incomplete`, it is final:

- A different terminal status, a restart or a substantive event is not applied. It
  increments `lateEvents` and appends a `chat:late-event` record (channel and the
  attempted status), logged as a warning. Records are bounded at 8 per job; the
  count keeps every one.
- Late `chat:thinking` and `chat:phase` updates are dropped silently. They carry
  nothing to keep, and the timeline was already final.
- Running tasks behave exactly as before.

`replayChatJob` ignores `chat:late-event`, so reattachment shows the recorded
result.

## Also fixed

`tests/specialist-context-handle.test.ts` (#151, merged in #359) was never
classified in `tests/qualification-profiles.json`, so
`qualification-profile.test.ts` failed on main. It is now in the `agents` profile.

## Limits

- The outer `chat:stream` catch still sends its own `chat:error` straight to the
  renderer after a `chat:done` in that rare path. The stored task no longer
  changes, but the renderer may briefly show the error. Routing that send through
  the publisher is a separate change.
- This is one EX-02 slice. Attempt IDs, the obligation ledger and resume
  reconciliation (EX-01, EX-03 to EX-09) are not addressed.
