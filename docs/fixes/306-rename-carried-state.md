# #306 — Renaming a folder must not move Git metadata or Eris state (IW-03)

#310 made file tools refuse any path naming `.git` or protected Eris state
(`.eris/checkpoints`, `.eris/settings.json` and the like). `rename_path` checked only
its two path strings. Renaming the folder that *contains* that data moved it anyway:

- `vendor/lib/.git`: a submodule link file
- `packages/api/clone/.git`: a nested clone
- `site/.eris/checkpoints`: Eris state for a project folder

Reproduced: `rename_path vendor → third_party` succeeded and carried the submodule's
`.git` file with it.

## Change

`movedTreeReason(root, path)` in `file-mutations.ts` walks the folder being renamed
and applies `protectedMutationReason` to every entry. `renameWorkspacePath` refuses
the rename with a `MutationConflict` naming the protected entry
("… would move vendor/lib/.git"). Nothing is moved.

- **Symbolic links are not followed.** A rename moves a link as a link, so a link
  to `.git` carries nothing.
- **The walk is bounded at 50,000 entries.** A larger folder is refused as too many
  to check, not assumed clean.
- **Only the agent `rename_path` tool uses this path.** Renames the user makes
  in the file tree are not affected.
- **`delete_path` needs no equivalent.** It removes only files and empty folders.

## Limits

- Commands (`run`) can still move anything. They are trusted host execution, not a
  sandbox (IW-10).
- Windows junctions and reparse points were not tested.
