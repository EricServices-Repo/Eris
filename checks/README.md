# Client performance checks

Reviewed against integrated `main` `0a54629` on 2026-11-01; package v0.6.10. Released tag `f14e409` is older than this source baseline. See [the documentation index](../docs/README.md) for the current architecture and evidence boundaries.

Run `npm run check:client` from the repository root. This checks types, tests chat
migration and partial saves, builds the app, exercises the compiled workspace
worker, and opens a hidden Electron fixture using an isolated temporary profile.

The renderer fixture checks a 10,000-row virtual list, stream subscription isolation,
persistent editor models, unsaved text, cursor and undo restoration, model disposal,
and the diff worker. Generated fixture assets stay in `.eris/cache/client-check`.
These checks establish behavior and bounds; they are not end-to-end latency benchmarks.

Chat storage uses `chats.sqlite` inside the existing workspace or user chat directory.
The first access imports existing JSON transcripts transactionally and leaves the
original files untouched. Subsequent sidebar loads read metadata only, message
history loads in pages, and new messages append atomically. A failed import reports
the source filename rather than silently hiding the conversation.

CI invokes this profile. It includes scripted chat IPC/approval tests in addition
to renderer, editor, worker and storage fixtures; it never calls a live provider.

`npm run check:recovery` launches actual Electron utility processes and exercises
loading/generation exits, repeated cancellation and a successful fresh worker.
The report labels its fixture backend and does not claim GPU/model certification.

After packaging, `node scripts/check-packaged-app.cjs --auto` launches the actual
production executable with a temporary application-data root. It checks rendered
content, preload IPC, isolation, default credential policy and malformed chat
rejection; updater and model warmup are skipped. CI runs this on macOS/Windows,
and release CI requires it before upload. This is a launch check, not proof that
an installer or signed update has installed successfully. Full packaged scripted
chat/approval/diff/reload interaction remains a separate acceptance profile.

`npm run check:quality` validates the budgeted quality harness. See
[quality/README.md](quality/README.md) for opted-in live comparisons.

## Agent and memory qualification

`npm run check` includes all Vitest suites; `npm run test:agents` is the production prebuild gate and `npm run test:dev-app` gates Eris-Dev. Profile membership and exclusions are in [qualification-profiles.json](../tests/qualification-profiles.json). Current targeted boundaries include model selection/switching, request-scoped recall, child requirements/constraints, subtree cancellation and journal admission.

`npm run check:context` is deterministic context qualification. Exact-source packaged/hardware/live evidence is separately evaluated by `check:context:release` and release policy; a skipped certification step is not a pass. No fixed historical test total is a completion criterion. Capture/routing corpus counts, complete agent-loop cases, provider calls, real GPU recovery and independently graded artifacts have different denominators.
