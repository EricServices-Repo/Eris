# Memory-tier visibility (#236)

Settings → Memory includes a read-only tier view backed by the same loaded allocation, inference governor, journal and final-dispatch diagnostics used by execution. It distinguishes measured window/layers, runtime-estimated KV, dedicated versus unified devices and unavailable remote metrics. Pressure includes an explanation; RAM budget sizing is identified as the existing profile/headroom policy, not advertised as automatic hardware tier sizing.

Journal counters cover currently open runs (the selected conversation when provided); dispatch counts cover the selected conversation’s last request. Closed journals are not retained for telemetry. Unknown offload is never displayed as fully on GPU. The new view uses semantic headings, a named section and status text.

Validation covers placement-label projection and diagnostics IPC/regressions. Packaged screen-reader and real-hardware checks remain separate from deterministic tests.

The PR's Windows package gate exposed the existing 120-case serial chat simulation exceeding one 30-second timeout. The fixture now executes the same 120 unique cases as twelve sequential ten-case tests, each retaining the original assertions and timeout. No corpus cases or validation were removed.
