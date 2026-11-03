# #304 — Run journal keeps evidence it cannot replace (PM-02 slice)

PM-02 and the acceptance criteria ask for durable tool evidence with explicit
omission status, and that "rejected reservations leave no leaked budget".

## Defect

When the context store refused a reservation for a new tool result,
`RunJournal.append` evicted this run's older resident entries one at a time and
retried. If the new entry could not fit even with all of them gone (larger than
the envelope after other owners' reservations and pins), the loop emptied the
journal and then omitted the new entry anyway.

Reproduced with a 16 MiB tier: three 200 KB file reads were resident, then one
20 MiB command output arrived. Afterwards all four entries were `over-budget`
and nothing was readable. The run lost evidence it could have kept, in exchange
for nothing.

Separately, `append` after `close()` took a reservation that nothing would
release: 10,512 bytes stayed reserved in the repro. The agent loop appends
sequentially before it closes, so no current production path does this. It is
hardened here because the journal is the boundary a memory process would call.

## Change

- **Futile eviction is skipped.** Before evicting, `append` computes the most a new
  entry could ever be granted: the envelope less other owners' reservations and
  pins, counting this run's resident entries as available. If the entry exceeds
  that, it is omitted as `over-budget` and the older entries stay resident.
  Eviction still runs, oldest first, when it can make room.
- **A closed journal reserves nothing.** A late append records metadata, omitted
  as `run-ended`.

## Limits

- **Upper bound only.** The ceiling treats every owned thread byte as evictable.
  If the protected thread's own bytes keep a fit impossible, the old path can
  still evict some entries before failing.
- **Not a persistence change.** This keeps evidence within one run;
  persistence across restarts is the separate durable journal.
