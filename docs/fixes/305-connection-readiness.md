# #305 — Auto excludes connections that cannot authenticate (MO-03 slice)

MO-03 requires eligibility before ranking: "Apply model pin, locality, disclosure,
tools/protocol, required prompt fit, **readiness** and resource checks first."

## Defect

`chooseExecutionModel` (`auto-model-policy.ts`) marked every model on an enabled
OpenAI-compatible connection as ready. Connection models rank 18, above Composer
Lite at 10. So when a connection names a key (`apiKeyRef`) that is not stored
(never entered, cleared, or unreadable), Auto chose that model over a ready Lite.
The provider then rejected the unauthenticated request. The same happened to a
connection with no base URL, which the runtime refuses with "has no base URL".
Mid-run recovery used the same candidate list, so it could also reroute to such a
model.

## Change

Before ranking, a connection model is ineligible, with the reason shown in the
candidate list, when:

- its connection names a key that is missing or blank in the credential store
  ("connection API key is not stored"), or
- its connection has no base URL ("connection has no base URL").

Connections without a key reference, such as local Ollama or LM Studio, stay
eligible. The check reads the main-process credential store at each decision, so
storing the key makes the model eligible on the next turn. The model is
deduplicated by name exactly as the transport's resolver picks the first matching
connection, so the verdict is about the connection the request would use.

## Limits

- Presence of a key is checked; validity is not. A wrong or revoked key still
  fails at the provider.
- Reachability of the endpoint is not probed here (MO-01 readiness inventory).
- Fixed selection is unchanged: a pinned model with a missing key still fails
  with the provider's error rather than being substituted.
