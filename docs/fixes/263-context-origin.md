# Source conversation and execution worktree identity (#263)

Task contracts can carry a versioned host-sealed context origin: canonical profile/source workspace registration, thread namespace, project-relative scope, source incarnation, controls and disclosure-policy digest. A separate signed execution binding names the task and execution workspace/project. Child contracts rebind execution scope while retaining the original conversation source.

Every origin search/read validates the host seal, profile, registration, namespace, source epoch, controls, policy and execution binding before and after asynchronous access. Source settings supply disclosure checks. The adapter resolves only the authorized source project; filesystem tools retain the child worktree root. Invalid or legacy/unregistered mappings grant no cross-workspace recall. Existing top-level context pulls use this adapter when a mapped source is present.

This supplies the explicit origin adapter for a child; it does not automatically clone parent memory or enable the broader specialist context-handle capability in #151. Background tasks retain origin metadata, and explicit host callers can request original-source evidence through the adapter. The host capability key lives in profile data and is never included in prompts or committed.

Qualification covers separate worktrees, forged/cross-thread/profile mappings, registration replacement, source controls, disclosure rejection, nested project scope, serialization and POSIX aliases. Native Windows casing and packaged restart remain platform acceptance work; Windows uses the existing canonical filesystem resolver.
