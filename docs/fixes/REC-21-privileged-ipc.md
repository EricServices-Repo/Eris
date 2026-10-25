# REC-21 / issue 67: privileged IPC admission

The registration adapter in electron/main/ipc/privileged.ts guards checkpoint, Git, model and fs:write handlers. It wraps registration synchronously, restores the Electron registration API afterward, and fails closed for new channels in these families until a bounded runtime schema is supplied. Handler implementations retain public return types. Admission failures use a versioned JSON rejection in the IPC error message.

Only the main application window and its main frame are admitted. A strict version-1 envelope supplies canonical workspace association and bounded arguments. Checkpoints must belong to that root and indices must exist. Git paths/branch/messages are bounded and mutation leases recheck workspace after queue waits. Existing checkpoint/review/commit services retain their own leases. Model cancellation checks window ownership; invalid requests cannot cancel an active download. Model probe persistence uses its captured workspace.

Preload transparently envelopes calls while keeping IdeApi signatures. It captures the workspace at bootstrap and updates it when workspace selection returns. Old direct raw privileged IPC submissions are intentionally rejected; the bundled preload is the migration path. This also applies to new checkpoint review and reviewed-commit channels. Manual editor writes remain restricted by the existing canonical filesystem guard.

Validation: TypeScript, targeted ESLint and whitespace checks passed. Foreign-frame, malformed-payload, stale-workspace and packaged Electron scenarios remain integration qualification work. Unmigrated capability families retain existing admission; this change is a staged boundary migration rather than a claim that every IPC channel has been audited.
