# Automatic model selection and recovery

Eris makes two separate choices for every turn. **Agent Auto** picks the *role* (Agent, Coder, Explainer, Reviewer, Plan, Verification or Fast). The **model picker** picks the *execution model*. This guide covers the second choice: how a model is selected, ranked, prepared and, when a run stalls, replaced.

Source: [`auto-model-policy.ts`](../../electron/main/services/auto-model-policy.ts), [`mid-run-adapt.ts`](../../electron/main/services/agent/mid-run-adapt.ts), [`model-transition.ts`](../../electron/main/services/agent/model-transition.ts).

## Policies

| Picker entry | Policy | What it may choose |
|---|---|---|
| A named model (for example `local:qwen2.5-coder-7b`, `cloud:qwen3:8b`, `gpt-4o`) | **Fixed** | Exactly that model. Recovery never replaces it. |
| **Auto (this computer only)** | `auto-local` | Downloaded GGUF models and model servers on a loopback address (Ollama or LM Studio on `127.0.0.1`). A LAN server counts as remote, even if it is approved to receive recalled context. |
| **Auto (any connected model)** | `auto-any` | Everything above, plus enabled remote connections: OpenAI-compatible APIs, OpenRouter and Eris Cloud. |
| **Auto (settings policy)** (`auto`, older saved value) | Follows `models.defaultModel` | `auto-local` when the saved default is `auto-local`, or when `agent.routing.profile` is `local`; otherwise `auto-any`. |

An explicit model on an agent definition (`.eris/agents.json`) acts as a Fixed choice for that role. If it conflicts with the local-only policy, the turn is blocked with an explanation rather than silently sending the request to a remote model.

## Candidate pool

`chooseExecutionModel` rebuilds the pool for every decision, so changed readiness, URLs, keys and free memory are always seen. A candidate is excluded, with a reason recorded on the route, when:

- it is not ready, or was already tried in this run;
- it is remote and the policy is `auto-local`;
- it is not a chat model (embedding, projector, CLIP or encoder files);
- **local GGUF**: its weights plus context headroom don't fit the current GPU/unified-memory budget (a model that is already loaded with at least a 1,024-token context counts as fitting), or its declared routing capabilities rule out the intent or tools;
- **connections**: the connection has no base URL, or names an API key that isn't stored;
- its capability profile says it has no tool calling and the turn needs tools, or its declared context window is smaller than the prompt needs.

Eris Cloud models enter the pool as `cloud:<model>` refs. Their requests go to the Eris Cloud server with the bare model id.

## Ranking

Eligible candidates are sorted by rank. Ties are broken by the user's priority list (`models.priority`), in order.

1. **Capability profile**, when one is set for the model in `models.capabilityProfiles` (settings JSON; there is no UI for it yet):
   - the tier sets the base rank: `small` 10, `standard` 30, `strong` 60, `frontier` 90;
   - native tool calling adds 5 on tool turns.
2. **Without a profile**, a heuristic applies:
   - a local GGUF scores 20, adjusted by name-based specialization: coding models get +8 on code tasks and −2 otherwise, and general models get +6 on answer tasks;
   - a connection model scores 18.

   File size is only used to check that a model fits, never as a quality score.
3. **Auto preference** (Settings → Models → *Auto preference*):
   - **Prefer best** uses the ranks as they are.
   - **Prefer local** adds 1,000 to local candidates.
   - **Prefer cheapest** adds 1,000 for free local models, 500 for `low`-cost profiles and 0 for `high`.
4. **Measured evidence**, when `evals.useScoresForRouting` is on (the default) and a model has at least `evals.minRuns` runs for the intent (default 3): real outcomes win first, then eval results. Evidence is tied to the runtime, the weights or endpoint, the context settings and the protocol, and it expires after 30 days.
5. **Residency**: if the choice came from the heuristic or a profile, and the loaded local model is within 10 rank points of the winner (`SWITCH_MARGIN`), Eris keeps the loaded model and avoids a reload. Measured evidence always overrides this.

## Model preparation

Selection happens when the turn is planned; preparation happens later, after intake has resolved the request. If intake blocks the turn (missing references, or an Agent-mode request that a read-only assignment can't do), no model is loaded at all. The same guard (`taskIntakeBlocked`) is used by the desktop and by Eris-Dev.

For local GGUF models, the context window is allocated first and the prompt is then packed to the size that was actually allocated (`prepareMessages`, called under the inference lease). Recall and task references are checked again at that point, so a source that was revoked while the model loaded never reaches the request.

## Recovery

A run can switch model when it repeats empty or invalid output, stops making progress, fails verification, or hits a recoverable native or context failure. Recovery:

- is bounded by the shared two-adaptation budget, and every model already tried is excluded;
- moves only to **local** alternatives, so execution state built on this computer is never sent to a remote endpoint;
- never applies to a Fixed model, a safety refusal, or an approval the user denied;
- records the excluded candidates and their reasons when there is no alternative.

A transition happens between completed model calls or tool batches:

1. Check the policy, readiness and fit again.
2. Check cancellation and release the old KV session.
3. Prepare the target through the exclusive inference scheduler, with serialized load and dispose.
4. Read the target's measured capacity, rebuild the instructions and tool protocol, and refresh the context budget.
5. Continue with the same task, authority, transcript, tool observations, checkpoints, journal and completed edits.

A failed preparation doesn't commit the new model or replay completed edits. It uses up recovery budget and records why.

## Tests

- `auto-model-policy.test.ts`: pool ordering, locality before scoring, endpoint changes, Fixed pins, exclusions, residency, profiles and preferences.
- `model-switching.test.ts`: real planning and the real agent loop over scripted transport. It covers switching to another local worker, edits surviving recovery without being replayed, capacity, cancellation, admission failure and refusal policy.
- `memory-dispatch.test.ts`: sources revoked while a model is being prepared never reach the final request.

These are deterministic logic and transport tests. They are not live-model quality measurements, GPU certification or packaged-app validation.
