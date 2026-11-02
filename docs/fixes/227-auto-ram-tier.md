# #227 — size the RAM tier from the host

`maxMemoryMiB` was 128 on every machine, with a 512 maximum. `agent.contextMemory.mode` now defaults to `auto`, and `src/shared/context-tier-budget.ts` computes the budget.

| Host | Budget | Limit |
| --- | --- | --- |
| Dedicated GPU | 25% of free host RAM after the pressure reserve. VRAM-resident weights are not subtracted. | 512 MiB |
| Unified memory | 10% of what is left after the reserve and admitted model work, using the lower of that figure and measured free memory. | 64, 128, 256 or 512 MiB by total RAM (§7.2) |
| No device detected yet | The unified rule, because it is the cautious one. | Same |

The shares are first estimates. They have not been benchmarked.

- **Ceiling:** auto stops at 512 MiB until #228 moves the store off the main-process V8 heap. The issue's 8 GiB and 2 GiB targets need that work.
- **No minimum:** zero is a valid budget (§7.2). The store then holds nothing, and recall falls back to durable sources.
- **Thread limit:** a quarter of the budget, at most 128 MiB. An automatic workspace policy adds no thread limit of its own.
- **Stability:** a budget change invalidates selections, so it moves in 16 MiB steps, shrinks at once, and grows only if the rise still holds with 20% less free memory. Second-to-second headroom stays with the governor's pressure limit, which still applies on top.
- **Manual mode:** the ceilings rise to 1024 and 256 MiB. Accounting is logical at 4× serialized size, so 1024 MiB is about 256 MiB of serialized history. Critical pressure still applies.
- **Existing users:** a saved non-default budget with no saved mode resolves to `manual`, so nobody's choice is overridden. A saved default budget becomes `auto`.
- **Settings:** the tier view shows the budget and the reason for it.

Change from §7.2: the existing user cap is not a ceiling in auto mode. Its default of 128 MiB would otherwise block every larger budget. A user who wants a cap picks manual.

## Known limits

- The `×4` multiplier is not replaced with measured accounting. Doing that properly depends on the #228 representation.
- No benchmark has been run on any host, so the targets are unrevised.
- `inferenceDevice()` reports a non-Metal integrated GPU as `dedicated`, so such a host gets the dedicated rule.
- A model that is loading but not yet admitted is not in the budget. The governor's existing shortfall limit sheds optional memory for it.

Verification: `npx vitest run tests/context-tier-budget.test.ts tests/settings.test.ts`. These are deterministic. Memory figures are injected, so no packaged, live-model or hardware run is claimed.
