# Shared hydration cancellation (#124)

A shared load owns its AbortController and at most 64 consumer subscriptions. Each consumer detaches promptly on its own abort; one consumer cannot cancel another. The last detached consumer cancels publication and further pages. The current worker RPC remains counted in the two-load admission bound until it settles, because the worker protocol has no RPC cancellation. Explicit conversation invalidation aborts every consumer. Late results and abandoned-worker errors cannot publish stale RAM or cause unhandled rejections.
