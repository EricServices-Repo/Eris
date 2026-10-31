# #219 — loopback model servers receive recall

Recall was allowed only for `builtin:` and `local:` refs, so a model served by Ollama or LM Studio on the same machine counted as remote. The only workaround also opened recall to real remote providers.

`modelDestination(settings, model)` is now the one classifier for compilation, reference binding, dispatch revalidation and the inspector. It returns a locality (`in-process`, `loopback` or `remote`) and whether recall is allowed without `shareWithRemoteModels`.

- **Same connection as the transport:** it calls `resolveConnectionForModel()`, so the verdict is about the connection the request will take.
- **Strict URL parsing:** `isLoopbackUrl()` uses the WHATWG parser that `fetch` uses. It accepts `localhost`, `127.0.0.0/8` and `[::1]`. It refuses credentials in the URL, `localhost.example.com` and `0.0.0.0`. Connection names and provider labels are never read.
- **LAN hosts stay remote:** a connection can carry `recallApprovedUrl`, which covers that exact URL, so editing the address ends the approval. Only the user profile can grant it. The rule is stricter than the issue asked: a trusted workspace cannot grant it either, matching `shareWithRemoteModels`.
- **Redirects refused:** requests to a destination cleared for recall use `redirect: 'error'`, so a 307 cannot carry history to another host.
- **Dispatch checks both settings:** `withEligibleMemory()` and `assertTaskReferences()` require the request's settings and the current settings to agree, so withdrawing an approval takes effect mid-run.

`memoryForDestination()` blocks recall for non-native models when no settings are passed, and `withEligibleMemory()` requires them.

Three test files used `http://127.0.0.1:1` as their "remote" fixture. They now use `https://remote.invalid`, with their assertions unchanged.

Known limits: `localhost` is trusted to resolve to this machine, as RFC 6761 expects, so an edited hosts file is out of scope. `0.0.0.0` and IPv4-mapped IPv6 forms stay remote, which only costs recall.

Verification: `npx vitest run tests/model-destination.test.ts`. This covers deterministic checks and a real local HTTP redirect. It has not been run against a live Ollama or LM Studio server, or in a packaged build.
