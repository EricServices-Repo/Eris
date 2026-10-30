# #145 — make inspector previews use the real scope and destination

The inspector selected recall without the task scope or destination, so it could show receipts from another project and facts a remote or small model would never get. Its source IDs led nowhere.

The dialog now compiles its selection through the shared compiler for the selected model and shows, for each fact, whether it would be sent or why not. Recall uses the project root the latest turn resolved, remembered per conversation in main, so the preview needs no renderer-supplied scope. Controls stay snapshot-bound through the existing lease.

`Open message N` loads only the page holding that source and reveals it. Evicted pages between it and the live tail stay unloaded, and the existing gap controls return to the latest messages.

This also fixes a #143 omission: `ChatPanel` never passed `rendererBytes`, so the renderer-memory line added there could not appear.

Limits:

- **Project rules:** these are only known when a turn runs, so a preview has the same or more room than a real request. The dialog says so. Parity is exact only when project text is empty, so #145 stays open.
- **Auto:** the model is chosen per turn, so there is no destination to preview.
- **Scope:** before the first turn of a session, recall has no resolved scope and the dialog shows none.
- **Search coverage:** source navigation finds selected facts, not arbitrary archive search, which is #134.

Validation: `npx vitest run tests/context-preview.test.ts`, and `npx vite build --config checks/vite.config.ts && npx electron scripts/check-client-renderer.cjs` for reveal in real Electron (with the reveal effect disabled, that check fails with "Opening a recalled source did not reveal its message"). `scripts/check-accessibility.cjs` still passes. No live model, packaged app or hardware run.
