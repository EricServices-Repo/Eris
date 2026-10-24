/**
 * Behavior versions recorded in diagnostic exports. Bump when routing or prompt
 * assembly changes meaning, so two captures are compared only when their
 * versions, settings and fixtures are shown side by side.
 */
export const ROUTING_VERSION = '2026-10-24.1'
export const PROMPT_VERSION = '2026-10-24.1'
/** Request invariant checks; a change here can add or remove findings for an identical request. */
export const INVARIANT_VERSION = '2026-10-23.2'
/** Diagnostic oracle, rubric grading and claim checks. */
export const EVALUATION_VERSION = '2026-10-24.1'
