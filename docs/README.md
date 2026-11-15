---
slug: /guides
sidebar_label: Guide index
---

# Eris documentation

## Use Eris

- [Using Eris](ERIS_USAGE.md): install, connect a model, chat with the agent, review changes, project rules and skills, shortcuts.
- [Account sync](PROFILE-SYNC.md): what syncs to your EricServic.es profile, plus the server contract for sync and usage.
- [Image generation](image-generation.md): local Diffusers models or an Images API, `/image`, and how images are stored.
- [Feedback](FEEDBACK.md): how bug reports reach GitHub, and what is redacted.

## How it works

- [Architecture](ARCHITECTURE.md): processes, the life of a chat message, the agent loop, roles, models, tools, permissions, memory and limits.
- [Request resolution and execution](design/REQUEST-EXECUTION.md): requested versus effective work, reference binding, completion evidence, outcome review and model reasoning. Start here for chat-routing changes.
- [Automatic model selection](design/AUTO-MODEL-EXECUTION.md): Fixed and Auto policies, candidate admission, ranking, preparation and recovery.
- [Conversation memory](CONTEXT-MEMORY.md): what is retained, recalled and sent to the model, with defaults and pressure behavior.
- [RAM context architecture](RAM-CONTEXT-ARCHITECTURE.md) and [Amendment 001](RAM-CONTEXT-AMENDMENT-001.md): the target design for memory tiers. These are design references; [conversation memory](CONTEXT-MEMORY.md) records what is built.

## Develop and test

- [Eris-Dev](ERIS-DEV.md): the diagnostics app for capturing requests and replaying scenarios.
- [Live-model runs](ERIS-DEV-LIVE-MODELS.md): running question batches against real models.
- [Diagnostics and replay](DIAGNOSTICS-RUNS.md): the scripted diagnostics runtime and its sandbox.
- [Client and runtime checks](../checks/README.md) and the [quality harness](../checks/quality/README.md).
- [GitHub workflow](GITHUB-WORKFLOW.md): branches, pull requests, rebuilds and releases.

## Release and operations

- [Updates](UPDATES.md): update feeds, assets and provenance.
- [Signing](SIGNING.md): macOS signing and notarization, Windows signing.
- [Recovery runbooks](RECOVERY-RUNBOOKS.md): low memory, damaged downloads, failed workers, storage, updates and revoked credentials.

## Keeping these docs current

Each guide describes the code on `main`. When you change behavior, update the guide in the same pull request. Open work and past investigations live in [GitHub issues](https://github.com/EricServices-Repo/Eris/issues) and pull requests, not in this folder.
