import { isAutomaticModelSelection } from './model-execution'

/** Which model class each built-in role runs on when its definition does not say. */
export type AgentModelClass = 'primary' | 'fast'

export const BUILTIN_MODEL_CLASS: Readonly<Record<string, AgentModelClass>> = {
  composer: 'primary',
  coder: 'primary',
  planner: 'primary',
  verifier: 'primary',
  // Findings need a strong model.
  reviewer: 'primary',
  explainer: 'fast',
  fast: 'fast'
}

/** The role's class: its own field, else the built-in table, else primary. */
export function agentModelClass(agent: { id: string; modelClass?: AgentModelClass }): AgentModelClass {
  return agent.modelClass ?? BUILTIN_MODEL_CLASS[agent.id] ?? 'primary'
}

/** The parent model a delegated role runs on: its pin, else the model its class names. */
export function inheritedModelForAgent(
  agent: { id: string; model?: string; modelClass?: AgentModelClass } | null | undefined,
  models: { primary?: string; fast?: string },
  fallback: string
): string {
  const pin = agent?.model?.trim()
  if (pin && !isAutomaticModelSelection(pin)) return pin
  const cls = agent ? agentModelClass(agent) : 'primary'
  return (cls === 'fast' ? models.fast || models.primary : models.primary || models.fast) || fallback
}
