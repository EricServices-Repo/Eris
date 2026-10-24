# GitHub workflow

`main` is the only integration and release branch for EricServices-Repo/Eris. The `dev` branch is retired. Pull requests and releases must use `main`.

## Changes and commits

- Work may be committed directly to `main` and pushed to GitHub when appropriate.
- Feature and release work may also use a task or release branch and a pull request into `main`.
- Do not force-push or rewrite `main` history. Use ordinary fast-forward commits or GitHub PR merges.
- Keep local-only files such as `.agents/skills` and `.cursor/skills` out of commits.
- CI runs for pull requests and pushes to `main`.

## Releases

- Prepare version and changelog changes on `main` or on a release branch that will be integrated into `main`.
- Run `/update-github` from a clean checkout of the exact `origin/main` tip with the intended version already committed and no existing tag.
- The release script creates and pushes only the tag and creates the GitHub Release. It does not push a branch tip.
- The release workflow verifies that each tag points to a commit integrated into `main`, builds the macOS and Windows installers, and uploads the update feeds.
- Verify the macOS DMG and ZIP, Windows installer, update feeds, and successful release CI before saying the release is complete.

## Enforcement

- `.github/workflows/branch-policy.yml` allows pull requests into `main` from work branches.
- `.github/workflows/ci.yml` runs on pull requests and pushes to `main`.
- `.github/workflows/release.yml` accepts release tags only when their commit is an ancestor of `main`.
- GitHub branch protection and rulesets are configured separately from repository files. The current `main` branch has no protection or ruleset preventing direct pushes.
