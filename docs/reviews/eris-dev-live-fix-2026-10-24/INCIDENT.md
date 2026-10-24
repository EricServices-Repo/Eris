# Live agent run failure and fixes

Source: `eris-dev-requests-test.jsonl`, three saved cases from the 10,000-question corpus. The source run used Composer Lite, Agent mode, an 8,192-token context and the two-file sample project.

## What happened

The three cases consumed 29 model calls in roughly 150 seconds. Two were labeled inference-completed even though their final responses were incomplete summaries. The third exhausted the model-call limit.

1. Connection-pooling advice became a review after a confident semantic classification. The model initially supplied advice, but the runtime demanded workspace tools. Repeated nudges, context compaction and rerouting consumed ten agent steps and replaced the useful draft with an incomplete summary.
2. A TypeScript soft-delete example became an edit task. Its initial code answer was rejected because no files changed. Subsequent model calls copied the prompt’s literal `search_replace` example (`src/index.ts`, a→b), attempted invalid edits and generated compaction summaries until the call limit was reached. These operations concerned the disposable fixture, not the user’s actual project.
3. The safest-approach question about magic links became a review. The agent attempted an invalid retrieve call, then refused because the reviewer contract did not match the user’s request. Completion recovery incorrectly told this read-only worker to continue with edit tools. Its incomplete outcome was also reported as an answer.

## Production fixes

- `task-resolver.ts`: confident semantic proposals cannot turn explicit chat examples into workspace edits. Generic approach questions preserve an answer deliverable instead of being converted into reviews. Explicit repository work, recommendations, references to prior work and requested plans retain their separate handling.
- `agent/workflow.ts`: source evidence is required when the task scope requires it, rather than because a plan or review role was selected. Explicit execution and real edits retain their evidence requirements.
- `agent/loop.ts`: generic tasks can answer directly without forced workspace activity. Tool-continuation decisions use the actual outcome contract. Read-only outcome recovery does not instruct the worker to edit files.
- `agent/context-compiler.ts`: the textual protocol example uses a harmless tree call rather than a fabricated source edit that a local model can copy.

## Eris-Dev fixes

Live records now contain a structured `completion` outcome separate from model inference. The app consumes the production loop’s incomplete flag. Incomplete and failed tasks appear under Needs attention and are excluded from the answered count. Saved outcomes are preserved in summaries, exports and result views. Earlier live runs with recorded Incomplete or step-budget stop events are upgraded when read, so the two false successes in this source run are correctly shown as incomplete.

Raw provider outputs remain available per request. A failed run can retain its last draft without claiming it completed successfully. Budget-triggered aborts retain their actual error instead of being mislabeled as timeouts. Routing, prompt and evaluation versions were advanced to `2026-10-24.1`; start a new run after updating rather than mixing old and new behavior by resuming an incompatible run.

## Native worker reliability found during verification

The first native replay completed questions one and two, then a native addon/worker crash occurred on the third. The worker-channel code lacked exit handling for outstanding load responses and generation waits. Runtime errors could also cause the main process to attempt in-process inference.

The new worker response helper rejects on exit/error, observes cancellation during loading, uses a finite load deadline, and removes listeners from the original worker instance. Streaming listens for worker failure and wakes the waiting request. Native runtime failures now return an actionable error instead of moving the failed workload into the UI process. These changes contain and report native failures; they do not claim to eliminate the underlying native addon crash.

## Verification

All three original questions were replayed with the installed Composer Lite model and completed as answer tasks with two model calls each. The first two were in the same process; the third was replayed in a fresh worker after the native crash. Actual final answers and request traces are saved in `native-replay-results.json`; before/after counts are in `replay-summary.json`. Model-answer correctness has not been graded, and the full 10,000 questions were not sent to a real model in this verification.

Regression tests include deliberately wrong high-confidence intent replies for all three inputs, no workspace edits or unnecessary tool loop, incomplete step-budget reporting, legacy outcome correction, cancellation and worker-exit listener cleanup. Production and Eris-Dev build results are recorded in the final task response.
