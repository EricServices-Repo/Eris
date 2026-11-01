# #257 — Keep the parent's requirements in a child task

`childTaskContract` intersected authority correctly but read the child's goal alone, so a child told to "implement the booking validator" under "implement a booking service in Python" had no language at all. Permission intersection could not help, because this is about meaning, not authority.

`inheritRequirements()` merges what the parent required into the child's reading. A new `inherited` record on the contract keeps this apart from authority:

- **Stack:** the child takes the parent's language when its goal states none, and frameworks add up.
- **Limits:** effect limits and `forbidsMutation` only add up, so a read-only parent stays read-only.
- **Clauses and files:** the parent's explicit clauses and named files reach the child, bounded to 8 and 12.
- **Top-level request:** the first 600 characters travel with every descendant, because the parser misses some wording. "Without changing the public API", for example, is neither a parsed clause nor an effect limit.
- **Prompt and checks:** the model-facing contract carries a `fromParentRequest` block labelled as limits, not additional work, and the requirements join the acceptance criteria.

Not inherited: obligations, follow-up state and recommendations. Children used to carry the parent's selected recommendations in their contract, and no longer do.

## Conflicts

If a goal names a different language, the parent's requirement stands, and the conflict is recorded in `inherited.conflicts`, the model-facing contract and acceptance, telling the child to report it to its coordinator. Three cases are not conflicts:

- The same language.
- A language the parent's own text also names. "Python and TypeScript" resolves to `Python`, so without this a child assigned the TypeScript half would be overruled.
- The source language of a conversion, which the child may need to read.

## Known limits

- Framework conflicts are not detected, because there is no list of which frameworks exclude each other. A child naming Flask under a Django parent gets both.
- A file the parent named is context, not an enforced boundary. Tool authority is unchanged.
- The language read from a goal is only as good as the interpreter: "a Go validator" gives no language, so a child saying that under a Python parent gets Python with no conflict recorded.

Scripted only. No live model run.

Verification: `npx vitest run tests/child-task-requirements.test.ts tests/agent-v2.test.ts tests/agent-conversation.test.ts`.
