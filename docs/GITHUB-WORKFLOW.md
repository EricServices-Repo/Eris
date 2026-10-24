# GitHub integration rules

These rules govern how Eris changes reach GitHub and how release code reaches users. They apply to Codex, Claude, other agents, and human contributors.

## Active branch model: through the v1.0.1 promotion

`main` is the stable release line. `dev` is the integration line for the next release. Each task or release preparation gets its own branch, created from the appropriate current integration branch.

```text
task branch ── pull request ──> dev ── v1.0.1 promotion pull request ──> main
```

- Make commits only on the task/release branch. Use a descriptive name such as `codex/fix-json-rendering`, `claude/agent-routing`, or `release/v1.0.1`.
- Never commit, merge, or push a branch tip directly to `dev` or `main`. Do not use `git push origin HEAD`, `git push origin dev`, or `git push origin main` to integrate code.
- Before v1.0.1, feature and fix pull requests target `dev`. Review and merge them through GitHub. Keep `main` on its stable release history.
- Prepare version and changelog changes on their own release branch from `dev`; merge that branch into `dev` by pull request before making a release tag.
- The v1.0.1 release is the one planned `dev` → `main` promotion. Open a pull request from `dev` to `main`, review its checks, and merge through GitHub. Tag/release the integrated `main` commit. The repository workflow rejects other PR targets to `main` and rejects this promotion unless its version is 1.0.1.
- A release tag push is allowed only after its commit is already integrated into the approved source branch. A tag does not authorize pushing or synchronizing the source branch.

## After v1.0.1

After the v1.0.1 promotion, Eris will move to a major-version branch model. The exact branch names, integration targets, release source, and migration steps are not defined yet. Do not invent them or continue using the pre-v1.0.1 assumptions for later work. Update this document, the local GitHub skills, CI branch filters, release validation and GitHub protection settings together when that model is established.

## Every change

1. Check `git status`, current branch, and upstream before editing. Preserve unrelated changes.
2. Create/use a dedicated task branch from the current approved base; never do implementation work directly on `main` or `dev`.
3. Commit related work to that branch. Do not include local-only `.agents/skills` or `.cursor/skills` in commits; those directories intentionally stay off GitHub.
4. Push only the named task/release branch, then open a pull request to the currently approved target. Do not locally merge and push the destination branch.
5. Wait for required CI and review. Resolve feedback on the same branch and let GitHub perform the merge.
6. Report the branch, PR/base target, commit, and checks. Do not claim integration until the PR is merged.

If `dev` does not exist on GitHub, do not silently substitute `main`, create it from unrelated local work, or push a branch named `dev`. Stop before integration and ask the repository owner to establish `dev` from the intended reviewed baseline. The current code workflow runs CI on pushes to both `dev` and `main`, but branch creation and protection are GitHub repository settings.

## Release procedure

- Before v1.0.1, the release commit must already be on `dev`. For v1.0.1, it must already be on `main` after the promotion PR.
- Run `/update-github` only from that integrated source branch, with a clean worktree, the correct version already committed, and no existing tag. The release script must create/push the tag and release without pushing the branch tip.
- The release workflow builds installers from the tagged commit. Verify the macOS DMG and ZIP, Windows installer, update feeds, and green release CI before saying the release is complete.
- Do not publish a version greater than v1.0.1 until the post-promotion major-version branch model has been documented and configured.

## Repository protections to configure

GitHub repository administrators should protect `dev` and `main` against direct pushes and force pushes, require pull requests, and require the Branch policy and CI checks. Keep deletion disabled. During the v1.0.1 promotion, allow the reviewed `dev` → `main` PR under the normal protections; do not temporarily bypass branch protection for convenience. GitHub rulesets/branch protection live in repository settings and are not enforced solely by files in this checkout.

## Enforcement in this repository

- `.github/workflows/branch-policy.yml` accepts task PRs into `dev`; PRs into `main` are reserved for `dev` at version `1.0.1`.
- `.github/workflows/ci.yml` runs on pull requests and on pushes to `dev` or `main`.
- `.github/PULL_REQUEST_TEMPLATE.md` repeats the required destination and promotion checklist.
- `.agents/skills/update-github/SKILL.md` is local-only by project policy and must agree with this tracked document.
