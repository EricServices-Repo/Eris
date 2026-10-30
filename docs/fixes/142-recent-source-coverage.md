# #142 — deduplicate canonical recent sources

Main intake retains canonical source IDs when replacing renderer history. The same compactHistory function used to build prompts reports IDs of complete admitted recent turns. Recall suppresses raw excerpts from those sources, preserving distinct older messages with identical words and structured outcome receipts absent from raw text. Truncated turns and summary-only sources are deliberately not marked fully covered. No renderer-provided list can replace the canonical source set for persisted chat.

Memory manifests export duplicate source count and character-estimated candidate tokens avoided (not a claim about provider token billing or later transport compaction). Tests cover source identity, partial coverage, receipt preservation and the production chat IPC path.

Validation: `npx vitest run tests/context-memory.test.ts tests/agent-context.test.ts tests/chat-stream.test.ts`. Scripted deterministic checks; no live inference.
