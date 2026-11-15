# Eris Cloud Agent (retired)

This package is the former Cloud Agent worker: a separately deployed Node service that ran agent jobs in a container with its own model. **It is no longer deployed or used by the desktop app.**

Since v0.7.1 (#608):

- The desktop's Cloud Agents client is switched off (`CLOUD_AGENTS_ENABLED = false` in `src/shared/cloud-agents.ts`). It makes no network requests, and all agents and subagents run on the user's computer.
- `agents.ericservic.es` now serves **Eris Cloud**, the hosted Ollama models. The desktop reaches it as an ordinary OpenAI-compatible provider (`https://agents.ericservic.es/v1`), authenticated with the user's EricServic.es device token. In Eris, its models are named `cloud:<model>`.

The source stays in the repository for reference, and the `cloud-agent:*` npm scripts still build it, but nothing in the desktop app depends on it. Remove it in a separate change if it is not going to be revived.
