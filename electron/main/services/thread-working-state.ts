import { createHash } from 'crypto'
import { interpretationOf, type TaskContract } from '../../../src/shared/task-contract'
import {
  ThreadWorkingStateSchema,
  type ThreadWorkingState
} from '../../../src/shared/thread-working-state'
import type { AgentRunnerEvent } from './agent/types'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
/** Captures actual runtime events, never parses assistant completion claims. */
export class ThreadWorkingStateBuilder {
  private effects = new Map<string, ThreadWorkingState['effects'][number]>()
  private checks = new Map<string, ThreadWorkingState['checks'][number]>()
  private questions: ThreadWorkingState['questions'] = []
  private omitted = 0
  constructor(
    private task: TaskContract,
    private sourceMessageId: string
  ) {}
  observe(event: AgentRunnerEvent) {
    if (event.type === 'diff') {
      for (const check of this.checks.values()) if (check.state === 'passed') check.state = 'stale'
      const effect = {
        id: `diff:${event.diff.checkpointId}:${event.diff.opIndex}`,
        path: event.diff.path.slice(0, 4096),
        operation: event.diff.op,
        digest: digest(JSON.stringify([event.diff.before, event.diff.after]))
      }
      if (this.effects.size < 64 || this.effects.has(effect.path))
        this.effects.set(effect.path, effect)
      else this.omitted++
    } else if (
      event.type === 'tool' &&
      event.tool.status !== 'running' &&
      (event.tool.name === 'verify' ||
        (event.tool.name === 'run' &&
          /\b(?:test|pytest|vitest|lint|typecheck|cargo check|go test)\b/i.test(
            event.tool.path ?? ''
          )))
    ) {
      const command = event.tool.path?.slice(0, 500) || `unidentified-check:${event.tool.id}`
      if (this.checks.size < 16 || this.checks.has(command))
        this.checks.set(command, {
          id: event.tool.id,
          command,
          state: event.tool.status === 'ok' ? 'passed' : 'failed',
          digest: digest(event.tool.detail)
        })
      else this.omitted++
    }
  }
  question(text: string, answered: boolean) {
    if (this.questions.length < 8)
      this.questions.push({ id: digest(text).slice(0, 24), text: text.slice(0, 300), answered })
    else this.omitted++
  }
  snapshot(terminal: string): ThreadWorkingState {
    const obligations = interpretationOf(this.task).obligations
    const recommendations = this.task.recommendations
    const effects = [...this.effects.values()]
    return ThreadWorkingStateSchema.parse({
      version: 1,
      taskId: this.task.taskId,
      taskRevision: this.task.revision,
      sourceMessageId: this.sourceMessageId,
      projectRoot: this.task.scope.projectRoot,
      terminal,
      obligations: [
        ...obligations.map((o) => ({
          id: o.id,
          text: o.text.slice(0, 300),
          state: 'pending',
          effectIds: []
        })),
        ...recommendations.map((r) => {
          const matching = effects.filter((e) => r.targets?.includes(e.path))
          return {
            id: r.id,
            text: r.text.slice(0, 300),
            state: matching.length ? 'effect-observed' : 'pending',
            effectIds: matching.slice(0, 16).map((e) => e.id)
          }
        })
      ].slice(0, 32),
      effects,
      checks: [...this.checks.values()],
      questions: this.questions,
      omitted: this.omitted + Math.max(0, obligations.length + recommendations.length - 32)
    })
  }
}
