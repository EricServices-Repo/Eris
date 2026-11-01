# Typed child outcome receipts (#264)

Background runs retain bounded receipts built from runtime diff/check events, source evidence and task-tree identity. Narrative and self-reported changed paths do not manufacture effects. Failed/stopped results and separate-worktree edits remain unverified in the source workspace. A real merge checks file digests against child evidence; previous check results become stale until source-workspace verification runs.

Import uses canonical chat append with a deterministic child/result-revision message ID. Repeating an import into the same thread is idempotent; default import targets are saved separately from sourceThreadId. Imports preserve other thread outcomes. Context projection retains typed status, integration, checks and provenance; RAM renders a typed historical receipt instead of upgrading done-job prose to observed truth. Source snapshots are revalidated by the existing dependency filter.

Receipts are bounded below the normal metadata budget, with omitted evidence never promoted. Existing legacy/cloud jobs receive an unverified receipt. Parent summaries label child narrative unverified and include available typed metadata.

Tests use scripted runner events and real temporary canonical chat/evidence storage. They verify unapplied results, partial failure, prose-only output, idempotent import, actual merge-state projection and dependency invalidation. Simulated check events are not live test/model qualification.
