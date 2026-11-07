# Required artifact completion

Named output files must resolve inside the selected project, be nonempty and have been observed by the run. Required JS/TS/JSX/TSX outputs additionally receive bounded parser checks; JSON must parse; PHP containing only tags/comments is rejected. Validation reads at most 1 MB per artifact and 2 MB in aggregate and never evaluates generated code. Unsupported language syntax is not implicitly certified.

Required code output sets must also have a successful independent project verification result. Reading an existing file, or skipping verification because no command is configured, cannot satisfy the request. Already-correct files do not require gratuitous edits: inspection plus successful project checks is sufficient. The final verification path also runs for unchanged requested code files when execution authority permits it. Missing tools or forbidden verification leave the outcome incomplete, with no expansion of command authority.

Syntax and project checks do not prove every business requirement. Candidate qualification still needs independent fixture expectations and installed/live-model runs. Tests cover comment-only placeholders, broken JS/TS and JSON, empty PHP, all-file identity checks, deleted files, and already-existing outputs with and without independent verification. Refs #413, #320, #342.
