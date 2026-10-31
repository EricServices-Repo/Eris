# Eris-Dev model discovery on Windows

## Root cause

Eris stores models in `%APPDATA%\Eris\models\builtin` and `%APPDATA%\Eris\models\local`. Hub-installed entries are described by `local\catalog-extra.json`. Eris-Dev stores its own state under `%APPDATA%\Eris-Dev`.

Previously, `electron/dev/models.ts` tried to create file symlinks in Eris-Dev for the Eris weights and extra catalog. On Windows these often require Developer Mode or elevated privileges. Exceptions were silently swallowed, so the catalog and runtime searched an empty Eris-Dev directory.

## Resolution

Shared path helpers in `electron/main/services/paths.ts` now search the debug app's own model directory first, then Eris's model directory when the application name is Eris-Dev. Production Eris continues searching only its own directory. No symlink, hardlink, or weight copy is needed.

Local model catalog discovery merges Eris-Dev's extra entries with Eris's extra entries on every refresh. The same resolved paths are used for readiness, runtime loading and warm-up. Valid shared downloads are reused rather than downloaded again. New downloads and deletions always target the calling application's own model directory.

Eris-Dev treats shared Eris weights and verification sidecars as read-only. Verification can report corruption but cannot delete a borrowed Eris model or write its sidecar. Catalog updates replace the local file atomically so an old catalog symlink is detached instead of modifying Eris's catalog.

## Tests and deployment

`tests/eris-dev-model-discovery.test.ts` covers production and debug directory isolation, Composer and Hub discovery, refresh after additions/removals, runtime paths, shared delete/verification protection, download reuse, and migration of old catalog symlinks. It is included in the Eris-Dev prebuild qualification gate. These fixtures exercise the filesystem and production catalog functions without needing a real model or administrative symlink privileges. The legacy symlink migration test is skipped on Windows; normal discovery tests need no symlinks and run there.

A new Eris-Dev Windows installer must be built and distributed for installed v0.6.8 users to receive this change. Windows GPU inference itself is not certified by these tests. Models must be installed under the same Windows user profile as Eris-Dev.
