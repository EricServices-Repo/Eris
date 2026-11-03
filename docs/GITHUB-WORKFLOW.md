# GitHub development and release workflow

Reviewed against integrated `main` `0a54629` on 2026-11-01. Package version: **0.6.10**; published tag `v0.6.10` is the older immutable `f14e409` source. Later source changes require another build.

`main` is the integration/release source for EricServices-Repo/Eris. The earlier `dev` promotion model is retired for this workflow. Branch operations and release publication are separate permissions.

## Contributions

- Commit work on a descriptive feature/task branch, normally `codex/...`; rebuilds use `rebuild/vX.Y.Z`.
- Push the named work branch and open/update a PR targeting `main`. Do not commit, merge or push directly to `main` or `dev` as part of the contributor/agent workflow.
- Preserve unrelated working-tree changes. Review the entire PR diff, stage explicit intended paths, and run checks appropriate to the change.
- Keep local skills, credentials, caches, generated build output/installers and scratch push archives out of commits.
- Do not force-push shared history or retarget the integration source to bypass a check. PR creation does not authorize merging or release publication.

## Rebuild versus release

A rebuild bumps package/lock root versions and changelog on a dedicated rebuild branch, qualifies/packages/launches the local macOS app, verifies its version/process and opens a PR to main. It is not a GitHub Release.

Release publication uses the already-integrated package version. Fetch origin/main; require a clean checkout with local HEAD equal to that exact tip, matching committed lock/changelog versions and no existing version tag. The release script creates/pushes the annotated version tag and release shell only. It does not commit or push a branch tip.

Release CI resolves the tag once, validates its integrated source, builds macOS DMG/ZIP and Windows Eris/Eris-Dev installers, runs qualification/packaged launch checks and uploads both production update feeds and source/asset provenance. Verify macOS DMG/ZIP, Windows setup, latest-mac.yml, latest.yml and successful CI before reporting complete distribution.

Source changes require a new version/tag. Explicit `repair_existing` can replace artifacts only for the same immutable source; it cannot silently move the tag. Do not delete/force tags without explicit authorization.

## Repository checks versus hosting configuration

The [branch-policy workflow](../.github/workflows/branch-policy.yml) validates PRs targeting main. It is not evidence that GitHub rulesets prohibit direct pushes. Rulesets, branch protection, environments and merge rights live outside these files and were not audited here. The stricter contributor rules above apply even if hosting permissions technically allow more.

CI runs on PRs and pushes to main. Required checks and release evidence are declared in [CI](../.github/workflows/ci.yml), [release workflow](../.github/workflows/release.yml), [qualification profiles](../tests/qualification-profiles.json) and [release-source validation](../scripts/release-source.cjs).

See [UPDATES.md](UPDATES.md) and [SIGNING.md](SIGNING.md) for updater assets and signing boundaries.
