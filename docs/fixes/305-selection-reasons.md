# #305 — Auto records why it chose a model (MO-03 / MO-08)

`chooseExecutionModel` gave every eligible candidate the same reason:
"eligible; heuristic task rank N". This held even when telemetry or eval scores chose
the model, so the candidate list in the turn plan and in recovery errors could not
show what decided the selection, or why the top-ranked model lost.

## Change

After selection, each eligible candidate's reason states the decision:

- **Selected model:** `selected by <evidence>; heuristic task rank N; <cost>`. The
  evidence is one of `heuristic task rank`, `measured run outcomes for <intent>` or
  `evaluation scores for <intent>`.
- **Every other eligible model:**
  `eligible, not selected: <winner> won on <evidence> (28 vs 10); <cost>`. When ranks
  are equal, the tie-break is named instead: `(tied at 28; broken by name)`.
- **Ineligible models:** keep their exclusion reason.

Selection itself is unchanged.
