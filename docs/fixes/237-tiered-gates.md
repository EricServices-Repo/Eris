# #237 — lossless-compaction and VRAM-residency gates

The #146 and #147 gates could not see the claims the tiered design makes. `tests/setup.ts` stubs host memory, so the suite never observed a real macOS reading, and the governor and store were tested apart.

## Gates

Thresholds are in `checks/performance/context-budgets.json` under `tiered`. The report version is now 3.

| # | Gate | Threshold | Evidence | Enforced by |
| --- | --- | --- | --- | --- |
| 1 | Compaction recoverability | 100% | Scripted: 200 results, real compaction and journals | `check:context` |
| 2 | Recall after 1, 3 and 10 compactions | 100% | Scripted: facts removed from the prompt | `check:context` |
| 3 | Avoidable effort per run | 3 summary calls, 3 re-executed tools, 10 re-evaluations | Live hardware | Release evidence |
| 4 | Store wipes per turn on a healthy host | 0 | Scripted: real governor, leases and store | `check:context` |
| 5 | Eris pressure state matches the OS | All samples | Live hardware | Release evidence |
| 6 | Budget and actual tokens within allocated window | Within window | Live hardware | Release evidence |
| 7 | Placement | All layers on GPU, no RAM spill | Live hardware | Release evidence |
| 8 | Turn N first token | 1.5× turn 1 | Live hardware | Release evidence |

Gates 1, 2 and 4 run on every `check:context`, which CI and release builds run, so a regression there blocks both. A fixture that evicts nothing fails, rather than reading as 100%.

Gate 1 measures the journal, not `context_read`. A model cannot read these refs until #222 and #223.

The gate 3 and gate 8 numbers are provisional placeholders with no measurement behind them. Tighten gate 3 when #222 lands, because the target for summary calls is 0.

## Evidence labels

- `report.tiered.evidence` is always `deterministic-scripted`.
- Hardware results go in `liveModel.tiered`, with `evidence: 'live-hardware'` and a required `hostClass`. A release needs one `unified` and one `dedicated` host.
- `evaluateTieredHardware()` rejects anything else, so a scripted pass cannot satisfy a hardware gate.

## Other changes

- `tests/host-memory-real.test.ts` undoes the `os` stub and reads this machine. On macOS it also runs the real pressure sampler.
- `measureStoreStability()` uses real leases. With `residentModel: false` it reproduces #216, and a test confirms the gate catches that.
- Eris-Dev traces gain `storeWiped`, the stateful-replay form of gate 4.

## Rollout

Bumping to version 3 invalidates older evidence reports. Pre-1.0 development releases do not require release evidence, as described in `docs/fixes/147-context-release-gates.md`, so this does not block them. A non-development release now needs hardware evidence that nothing collects yet. The `--eris-context-qualification` flag does not load a model, so `liveModel.tiered` must come from a separate live run, like the existing `liveModel.paired` data.

Verification: `npx vitest run tests/tiered-gates.test.ts tests/host-memory-real.test.ts tests/context-release-gate.test.ts` and `npm run check:context`. No hardware or live-model results exist yet; the live gates are validated against fixtures only.
