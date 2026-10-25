# REC-19 / issue 65: reviewed Git ownership

Agent review actions submit checkpoint operation IDs and expected repository/branch/HEAD instead of display paths. The service reconstructs both sides of renames, verifies contiguous operation preimages, compares HEAD to the earliest preimage and compares the current file to the final agent postimage. It refuses mixed user content, different staged content, changed modes, linked paths escaping the root, binary changes and large files requiring manual review. Stage kept uses the same checks.

After validation it stages selected paths, then uses Git commit --only, whose temporary commit index excludes unrelated staging. Selected new/deleted files are staged explicitly so Git handles them correctly. Hook failure leaves reviewed paths staged for recovery, while unrelated staging is retained. Commit receipts include root, branch and resulting SHA; UI push/PR actions check root/branch association before proceeding. General Git-panel commits retain explicit full-index semantics.

The existing review drawer supplies per-operation content inspection. This fix does not implement interactive mixed-hunk selection; those cases fail closed and require manual Git review. The application write lease does not exclude external editors or arbitrary external Git processes. Cross-process transaction races remain within REC-20 qualification scope. Commit/push/PR publication is not a single distributed transaction.

Validation: TypeScript, targeted ESLint and whitespace checks passed. Unrelated staged-file, mixed-hunk, hook-failure and packaged Git scenarios remain integration qualification work. GitHub CI also receives the shared truncated-stream error-prefix compatibility repair.
