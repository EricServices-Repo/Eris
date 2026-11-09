# Terminal assistant reply ownership (#451)

Main is the only writer of terminal assistant messages for successful, incomplete, stopped and failed chat execution. After the canonical append succeeds, the terminal event includes the saved reply, including its context sequence, completion evidence, assets, delegations and changed-file metadata. The renderer reconciles that snapshot by request-derived identity and never appends a second terminal record.

Job reattachment replays the stored terminal snapshot. Duplicate submissions and late events retain the existing idempotency and terminal-state guards. Events from an older record without a snapshot may be displayed locally but cannot fabricate durable completion or issue a new append. The earlier partial-error preservation and explicit failed-durability behavior remain intact.

IPC/SQLite tests close and reopen history, resubmit the same request and assert exactly one runner invocation and one assistant append with matching replay metadata. Other task/transcript/job projection coordination remains the separate scope of #452.
