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

Settings → Models exposes per-model capability overrides and tie-breaking priority. Eris resolves a profile from the user override, endpoint-scoped provider facts (model list and Ollama's model details), the bundled family table, and parameter or GGUF size estimates, in that order. An inexpensive model can still rank highly when its capabilities fit the task.

- Tier weights are 10 for small, 30 for standard, 60 for strong and 90 for frontier. Native tool calling, context fit and task specialization contribute to the rank.
- Prefer local puts eligible local workers first. Prefer cheapest prioritizes free-local, then low-cost models.
- Measured outcomes and eval scores can decide among candidates within the preferred group after the configured minimum number of runs. Tied ranks use tier, then the user's priority and stable catalog order. A resident native model can keep its place within the switch margin and same tier.
- The newest request and framing reserve set the minimum context for Auto. Older history is compacted after allocation. Run details show candidate exclusions and the evidence used to choose a worker.

## Model preparation

Selection happens when the turn is planned; preparation happens later, after intake has resolved the request. If intake blocks the turn (missing references, or an Agent-mode request that a read-only assignment can't do), no model is loaded at all. The same guard (`taskIntakeBlocked`) is used by the desktop and by Eris-Dev.

For local GGUF models, the context window is allocated first and the prompt is then packed to the size that was actually allocated (`prepareMessages`, called under the inference lease). Recall and task references are checked again at that point, so a source that was revoked while the model loaded never reaches the request.

## Recovery

A turn uses one execution model for both its conversation and tool calls. The legacy Max routing setting loads as Auto.

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

## Optional helper calls

Fast is the default for conversational routing, semantic interpretation, outcome checks, and optional context summaries. Review and verification use Primary for the outcome check. A fixed selection keeps its own model. Native helpers reuse the loaded model or skip inference before a cold load. Disabling helpers leaves deterministic intake, evidence checks, and context eviction in place.

## Tests

- `auto-model-policy.test.ts`: pool ordering, locality before scoring, endpoint changes, Fixed pins, exclusions, residency, profiles and preferences.
- `model-switching.test.ts`: real planning and the real agent loop over scripted transport. It covers switching to another local worker, edits surviving recovery without being replayed, capacity, cancellation, admission failure and refusal policy.
- `memory-dispatch.test.ts`: sources revoked while a model is being prepared never reach the final request.

These are deterministic logic and transport tests. They are not live-model quality measurements, GPU certification or packaged-app validation.

## Model classes

Each role has a `modelClass`: `primary` or `fast` (built-in table in `src/shared/agent-model-class.ts`; Composer, Coder, Plan, Verification and Reviewer are primary, Explainer and Fast are fast). `planChatTurn` resolves both models for every Auto turn and records them as `models.primary` and `models.fast` on the turn plan:

- **Primary** is the normal Auto choice for the turn (or `models.defaultModel` when Fixed).
- **Fast** is `models.fast` when it is Fixed and eligible under the turn's policy, otherwise *Auto-fast*: `chooseExecutionModel(..., { modelClass: 'fast' })` ranks models at tier standard or below first, then by cost class. The capability hierarchy applies to Auto-fast as well.
- When both picks are native local models, the fast class keeps the primary model, so roles never swap the loaded worker.
- A role's `model` pin overrides its class, and a Fixed chat selection applies to every role.

The route reason names the class and model, for example `fast local:qwen2.5-coder-1.5b`.


## Recovery destinations

Automatic recovery keeps the existing two-transition budget and skips attempted models. An eligible model on the original provider can recover a remote run. Crossing to a different remote provider requires Auto-any and an explicit account-level opt-in, which a workspace can restrict. A run that has used a local model can only recover locally. A workspace's local-only ceiling takes precedence.

Configured recovery model IDs are tried in order within those constraints. Automatic fallback prefers a higher declared capability tier when available.
