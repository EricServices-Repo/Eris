# #233 — KV reuse across turns: measurement (RAM-CTX-061)

The issue ships KV reuse only if a measurement justifies its memory. This records
that measurement on one unified-memory host. It does not change Eris.

## Method

`scripts/measure-kv-reuse.mjs` drives node-llama-cpp 3.22.1 directly, outside Eris,
against a local GGUF. A deterministic synthetic thread of N user/model turns is
followed by one new question, timed to the first generated token after one warmup:

- **fresh:** a new context sequence, so the whole history is evaluated again. This
  is what a per-run native session costs today (CONTEXT-MEMORY.md: no cross-turn
  KV reuse).
- **retained:** the same sequence as the previous turn. Only the new message is
  evaluated.
- **parked:** the thread's state was saved with `saveStateToFile`, the sequence then
  served a different thread, and the state was loaded back with
  `loadStateFromFile(…, { acceptRisk: true })`. The load time is included.

Three repeats per row; medians reported, with all samples in
`checks/performance/observations/kv-reuse-m4.json`.

## Result: Apple M4, 16 GB unified memory, Metal, context 8192, all layers on GPU

| Model                     | History  |  Fresh | Retained | Parked (incl. load) | Evaluated tokens (fresh → retained) | State file | Save / load  |
| ------------------------- | -------- | -----: | -------: | ------------------: | ----------------------------------- | ---------: | ------------ |
| Qwen2.5-Coder-1.5B Q4_K_M | 24 turns |  3.7 s |    53 ms |               61 ms | 3,268 → 19                          |     89 MiB | 26 / 9 ms    |
| Qwen2.5-Coder-1.5B Q4_K_M | 48 turns |  9.0 s |    74 ms |               87 ms | 6,580 → 19                          |    180 MiB | 55 / 17 ms   |
| Qwen2.5-Coder-7B Q4_K_M   | 24 turns | 22.4 s |   262 ms |              304 ms | 3,268 → 19                          |    178 MiB | 45 / 55 ms   |
| Qwen2.5-Coder-7B Q4_K_M   | 48 turns | 52.9 s |   311 ms |              401 ms | 6,580 → 19                          |    359 MiB | 197 / 113 ms |

## Reading it

- **Latency justifies the feature.** On a long thread, re-evaluating the history
  dominates time to first token: 50–170× slower than a retained sequence. Parking
  and reloading a thread costs a few tens of milliseconds more than keeping it.
- **Memory is the real cost.** A parked state is the KV of every token in it:
  about 28 KB per token for the 1.5B model and 57 KB for the 7B one, at this
  runtime's default KV type. One 48-turn 7B thread is 359 MiB on disk. An LRU cap
  must be in bytes, not thread count, and the files are conversation data
  (forget, delete and retention rules apply, per the issue).
- **Retaining costs no extra VRAM while the thread is active.** The sequence already
  holds that KV at the end of a turn. Keeping it only defers its release.

## Limits

- One host class (unified memory). Dedicated-GPU hosts were not measured; there the
  retained KV is VRAM the next model load cannot use.
- Synthetic, deterministic thread text. Real threads with tool output are larger
  per turn.
- Measures the runtime capability, not Eris. Eris's prompt compiler changes the
  prefix between turns when recall or task blocks change; #232 orders the stable
  prefix first, but how much of a real Eris prompt stays reusable turn to turn was
  not measured.
- No crash-safety, mismatch-refusal or invalidation work: those are the
  implementation's acceptance items and remain open.

## Follow-up: the Eris prompt prefix was not stable turn to turn

The measurement above assumed that Eris's prompt keeps an identical prefix between
turns. It didn't. The per-request **RESPONSE CONTRACT** (artifact, requested stack and
the request's own obligations, from `artifactResponseContract`) was compiled into the
`instructions` block, which is part of the reusable system prefix (#232). Two requests
with different contracts therefore diverged inside the system message. A retained KV
sequence could reuse only the part before it, and none of the conversation history.

The contract now goes in a new `turnInstructions` input. The compiler appends it to
the required task block in the current turn, after `TASK CONTRACT` and any
`CURRENT PLAN`, in both the worker path (`buildPreservedWorkerMessages`) and the
answer-only path (`loop.ts`). The Eris capability tip is also derived from the
request, so it moved too. Admission is unchanged: the task block and the instructions
block are both required.

### Shared prefix between consecutive turns

`tests/turn-prefix-stability.test.ts` builds a scripted five-request thread through
`buildPreservedWorkerMessages`, all with the same role and intent. The requests differ
in stack and obligations. The table shows the characters each prompt shares with the
previous one, from the start.

| Turn | Before: shared / total | After: shared / total |
|---:|---:|---:|
| 2 | 2,196 / 3,286 | 2,325 / 3,286 |
| 3 | 2,196 / 3,381 | 2,428 / 3,381 |
| 4 | 2,196 / 3,554 | 2,591 / 3,554 |
| 5 | 2,196 / 3,599 | 2,784 / 3,599 |

**Before, the shared prefix was a constant**: it ended inside the system message, so
every turn re-evaluated the whole history. **After, it grows with the thread**: it is
the system prefix plus everything before the previous request. On the 48-turn thread
measured above, that is the difference between re-evaluating the whole history
(the 52.9 s "fresh" case) and only the last exchange plus the new turn.

### What still breaks the prefix

- **The previous request itself.** It was sent in layered form (task contract, recall,
  request) and comes back next turn as plain text, so reuse stops at its start. That
  costs one exchange per turn.
- **A change of role or intent.** The playbook and role lines are in the prefix and
  depend on the turn's plan, so an edit turn after an answer turn diverges in the
  system message.
- **History trimming.** When older turns are dropped to fit the window, the history
  shifts and reuse stops after the system message.
- **Renderer-supplied project context** (`priorSystem`) is in the prefix. It was not
  varied here.

This is a deterministic, character-level measure on the compiled messages. It is not
a token-level or native KV measurement, and no live model ran.
