# #217 — recall steps down under critical pressure

Critical pressure returned no recall at all, even though pins and the durable archive live in SQLite and need very little memory. §7.5 already required critical pressure to keep serving compact facts.

Recall now steps down one tier at a time, and `manifest.recallTier` records where it stopped:

1. `ram`: normal recall.
2. `durable-and-pins`: RAM is paused, so the archive and pins are read from SQLite.
3. `pins`: the archive failed or its source changed.
4. `recent`: controls could not be read, or selection was refused.

`reserveRecovery()` provides the only allocation that works with an empty envelope. It is the same 16 MB ceiling the archive probe already uses, is limited to one holder at a time, cannot grow, and is charged to the ledger. A small temporary store holds the recovered rows and is released after selection. The archive probe also falls back to this allowance when `constrained` pressure leaves the envelope below 16 MB.

Recovered evidence keeps the normal safety checks. It carries the source header and revocation token, so an unchanged source passes dispatch, while a forget or rewrite fails closed. A second concurrent recall during critical pressure gets `recent`.

Verification: `npx vitest run tests/context-critical-pressure.test.ts`, using a real SQLite database and worker handler, with pressure injected. No packaged or low-memory hardware run has been done.
