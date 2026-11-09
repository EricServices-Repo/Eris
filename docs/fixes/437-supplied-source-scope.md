# Supplied source review scope (#437)

Intake reuses the existing `RequestSpans` structured operands to identify a review or explanation of supplied fenced/inline source. These operands remain content, never instructions. When the instruction names that supplied code and no workspace destination, path or project comparison, the task is generic, retains the original supplied source and exposes no workspace tools or commands. It does not require an unrelated project source read.

An explicit instruction to apply a fix to a workspace file, or to compare with a named project/path, still follows workspace scope and authority. A request with no supplied source retains ordinary workspace inspection. No additional history store, permission source or saved-task schema is introduced.

Production-capture regressions cover open/no-project cases, retained model input, tool absence, quoted-only requests and explicit application to a project file. These are deterministic dispatch tests, not a live answer-quality grade.
