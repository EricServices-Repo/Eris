# Model-facing schema documentation (#471)

The canonical architecture and request execution guides now describe `model-task/6`, including optional requested `evidence: source-read`. The request guide includes a JSON projection checked against `modelFacingTask(createTaskContract(...))`, not a separate hand-maintained schema implementation.

The permanent agent qualification suite compares this tested fixture projection with the embedded example and verifies that both current guides name the runtime's schema constant. A schema or requested-record change without matching documentation fails the check. Saved `TaskContract.version = 2` compatibility is tested and documented separately; older tasks without requested metadata gain no inferred permissions.
