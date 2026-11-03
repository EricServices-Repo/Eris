# #306 — Workspace walkers do not follow symlinks out of the workspace (IW-03 slice)

IW-03 requires effect admission to "enforce realpath containment" and to "handle
symlink/reparse changes". The acceptance criteria say traversal and symlink
attempts "cannot escape admitted roots".

## Defect

`read_file`, `list_dir`, `write_file`, `mkdir` and `delete_path` already refuse a
path whose real location is outside the workspace. The directory walkers behind
`grep`, `glob`, retrieval and `tree` did not apply the same rule, because they used `statSync`, which follows links:

| Tool                                                    | Walker                               | What leaked                             |
| ------------------------------------------------------- | ------------------------------------ | --------------------------------------- |
| `grep` (in-process scan, used when `rg` is unavailable) | `walkFiles` in `workspace-search.ts` | contents of files outside the workspace |
| `glob`, and the scan behind retrieval                   | `walkFiles`                          | paths of outside files                  |
| `tree`                                                  | `workspaceTree` in `workspace-fs.ts` | names under a linked directory          |

Reproduced with a workspace containing `linked-dir → ../outside` and
`src/linked-file.ts → ../outside/secret.ts`: `grep MARKER` returned the outside
file's line twice, once through each link, while `read_file linked-dir/secret.ts`
was refused. A link to a home directory or a credentials folder would expose that
text to the model, including a remote one.

The in-process scan is the normal `grep` path on a machine without `rg` on
`PATH`, since Eris does not bundle ripgrep. `glob` and retrieval's fallback scan
(`retrieveContext`) always use it.

`code-index.ts` has the same `statSync` walk in `buildCodeIndex`, but no
production code calls it: the symbol tools build their index through the
workspace worker's `index` job, which already skips links. It is patched for
consistency, not because it leaked.

## Change

All three walkers use `lstatSync` and skip symbolic links, the rule ripgrep (no
`--follow`) and the workspace index job (`workspace-index-job.ts`) already apply.
`tree` still lists a link as an entry, marked `name@`, but does not descend into it.

## Limits

- **Links inside the workspace are skipped too.** A link to an in-workspace
  directory is no longer walked, so its contents appear once, through the real
  path. This matches rg.
- **Windows behaviour is unverified.** Junctions and reparse points report as
  symbolic links to `lstat` in Node, but this was not tested on Windows.
- **Commands are unchanged.** `run` commands remain trusted host execution, not a
  sandbox.
