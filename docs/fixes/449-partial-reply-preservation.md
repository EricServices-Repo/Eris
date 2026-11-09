# Partial replies on stream failure (#449)

Main flushes streamed text, adds an explicit partial-result notice and observed changed files, and persists the assistant snapshot before publishing a model failure. The snapshot records failed terminal state and incomplete execution independently of verification. Reload reads the same request-derived assistant identity from canonical history.

The error event optionally carries that snapshot. The renderer reconciles it by message ID instead of appending a second assistant record or discarding accumulated text. Duplicate/late terminal events are ignored; pending paint work and accumulators are cleared only after retaining the reply. Assets and completion evidence remain attached.

If persistence fails, the event carries the same visible snapshot with failed durability and an explicit storage error. The UI can retain it for the current session but does not claim it will survive reload. Tests exercise disconnect after text and edits, actual transcript reload, failed storage and duplicate snapshot reconciliation. Installed UI and real-provider behavior still require separate qualification.
