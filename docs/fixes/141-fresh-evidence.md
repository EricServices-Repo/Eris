# #141 — current evidence before historical memory

The system compiler now prioritizes retrieval leads, then project context, then historical recall for project-dependent tasks. Historical memory is capped at 40% of the optional system allocation. Generic questions reserve no unrelated source capacity. Recent turns/tools retain the existing 45% conversation allocation. Identical optional source blocks are deduplicated with fresh evidence winning.

The compiler exports policy, allocated character counts, duplicate blocks and historical ceiling in its budget manifest. Counts remain explicit three-character token estimates, not backend tokenizer measurements. This is block-level allocation; semantic chunk ranking and backend tokenization remain separate work (#139). No authority or task fields are truncated.

Validation: `npx vitest run tests/agent-evidence.test.ts` exercises tight-context A/B with and without huge memory at 2k/4k/8k inputs, retained fresh evidence, generic allocation and duplicate sources. These are deterministic compiler checks, not live model quality measurements.
