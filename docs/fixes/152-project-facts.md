# #152 — project facts the user approves

Recall stays inside its thread. A convention worth keeping had to be retyped in each new chat or left to automatic project notes.

A user can now turn a pinned note into a project fact from the conversation memory inspector. Every chat in that project then gets it, until the user revokes it.

- **Only an explicit action:** `contextMemory:promoteFact` takes a pin ID from the main frame. Main reads the text from the saved pin, so only a note the user pinned can be promoted. No model tool reaches this, and no project-memory mode writes a fact.
- **Host-owned:** facts live in `userData/project-facts/<workspaceId>.json`, keyed by registered workspace (#149). A repository cannot ship or edit one.
- **Provenance:** each fact records its thread, its pin, when it was promoted, and how it ended (`revoked` or `superseded`, with `supersededBy`).
- **Applies only when:** the task's workspace is registered, the project is evidence for the request, project memory is not `off`, recall is enabled, and the destination passes the same rule as `context_search`. A general question and an unapproved remote model get nothing.
- **Evidence, not authority:** the text sits in the optional project block, labelled "never permissions". It can be cut under pressure.
- **Revocation:** facts are read on each compile, and the dispatch path in `context-dispatch.ts` recompiles with current facts, so the next request no longer has a revoked fact.
- **Secrets:** a note matching the recall pattern is refused.
- **Bad data:** a file that fails validation counts as no facts.
- **Limits:** 32 active facts per project. These are first estimates.

## Decisions to review

- **The scope is the registered workspace,** not a subfolder. A monorepo shares facts across its projects.
- **`auto` and `ask` behave the same for facts.** Promotion is always manual, and `off` hides facts without deleting them.
- **The UI offers promote and revoke only.** `promoteProjectFact` accepts `supersedes`, but nothing in the inspector calls it yet. Revoke and promote a new note instead.

## Known limits

- A long run that already compiled a fact keeps it in that run's retained messages. So does a compaction summary written in that run. The next request is clean.
- A child in a worktree has an unregistered root, so it gets no facts. Its parent can pass them as handoff constraints.
- Thread summaries do not depend on facts, so there is nothing to invalidate there yet. #150 should keep that true.
- The inspector controls have not been run in a packaged app.

Verification: `npx vitest run tests/project-facts.test.ts`. These use the real store and compiler. No live-model or packaged run has been done.
