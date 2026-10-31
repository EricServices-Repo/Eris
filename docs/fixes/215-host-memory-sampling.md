# #215 — reclaimable-aware host memory on macOS

`os.freemem()` on macOS counts only free pages, which the OS deliberately keeps low. Against a 25% reserve that produced `critical` pressure, and an empty RAM store, on healthy hosts. It replaces the limitation accepted in the #130 notes.

`host-memory.ts` samples `vm_stat` (free + inactive + speculative + purgeable) and `kern.memorystatus_vm_pressure_level` every 5 seconds in the background. Admission and `refreshMemoryPressure()` read the latest sample synchronously and never spawn a process. A sample older than 20 seconds, or an unreadable one, falls back to `os.freemem()`, so a failed sampler degrades to the previous behaviour.

The OS verdict outranks the arithmetic: `warn` means at least `constrained`, and `critical` means `critical`. While the OS reports `normal` and no native allocation is pending, arithmetic alone cannot reach `critical`.

Optional memory is measured against a new `pressureReserve` of `max(2 GiB, 12.5%)` on macOS, because reclaimable pages now count as free. Model admission keeps the existing 25% reserve, so this does not change which models can load. The 12.5% figure comes from one 16 GiB host and needs wider measurement. Windows keeps `os.freemem()`, which libuv reads from the OS available figure.

Verification: `npx vitest run tests/host-memory.test.ts tests/inference-governor.test.ts`. The sampler was also run against the real commands on a 16 GiB Apple Silicon host: 6.13 GiB available with OS pressure `normal`, while free pages alone were 0.46 GiB. `tests/setup.ts` stubs the `os` memory functions, so the suite cannot observe real host values. Packaged and Windows behaviour are not exercised here.
