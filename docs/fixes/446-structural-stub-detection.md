# Structural artifact checks (#446)

Completion no longer treats all files below 250 bytes as stubs or checks only the latest twelve files. Changed product artifacts use the existing bounded parser/validation boundary, shared with requested-file checks. Invalid syntax, comment-only JS/TS and explicit placeholder function bodies are reported as concrete artifact problems. A passing unrelated check does not erase them.

Short helpers, types, JSON and CSS are not rejected for length. Explicit placeholder detection is structural and conservative: it does not claim to prove business behavior or reject every ordinary TODO comment. Behavioral verification and per-requirement acceptance remain separate evidence. Validation is bounded to 100 changed files, 1 MB per file and 2 MB total, with an explicit incomplete result if the bound is exceeded.

Tests cover small helper behavior, padded TODO implementations, legitimate small configuration/style/type files, non-placeholder exceptions and a scripted tool-loop completion after a behavioral check. No live-model or hardware quality claim is implied.
