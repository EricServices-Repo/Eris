# #473 — Build identity in every feedback export

**Problem.** A feedback report named only `appVersion`. Two builds of the same version (or an
installed app older than the latest merge) were indistinguishable, so a regression report could
not be traced to the exact bundle.

**Change.**

- `electron.vite.config.ts` stamps a per-build `buildId` (ISO time + random suffix) next to the
  existing `gitSha`, `dirty` and `lockSha256` in `__ERIS_SOURCE_IDENTITY__`.
- `electron/main/services/build-identity.ts` reads identity **only** from the baked stamp
  (production or Eris-Dev). It never runs Git or reads the checkout, so rebuilding source without
  installing cannot make a running app claim the newer identity. Without a stamp everything is
  explicitly `unknown` / `dirty: null`, never assumed clean.
- Bug reports now carry role, version, commit, dirty flag, build ID, platform/arch, command
  approval policy and a random per-report trace ID. A machine-readable
  `eris-feedback-identity/1` JSON block is always attached; with diagnostics disabled it contains
  only the build identity and trace ID (no project name or model).
- The feedback form summary shows the short commit.

**Privacy.** The identity block never includes filesystem paths, log directory, credentials or
account plan. Covered by `tests/build-identity.test.ts`.

**Not done here.** No About-dialog UI, no effective per-run model (only the configured default),
no packaged/installed-app verification.
