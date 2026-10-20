import { useEffect, useState } from 'react'
import type { ChatJobSnapshot } from '@/shared/chat-jobs'

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** Main-process activity survives panel switches and renderer reconnection. */
export function ChatAgentActivity() {
  const [job, setJob] = useState<ChatJobSnapshot | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const next = await window.ide.getLatestChatJob()
        if (!disposed) {
          setJob(next)
          setError('')
        }
      } catch {
        if (!disposed) setError('Could not load chat activity.')
      } finally {
        if (!disposed) timer = setTimeout(refresh, 2000)
      }
    }
    void refresh()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [])
  const route = job?.events
    .slice()
    .reverse()
    .find((event) => event.channel === 'chat:routed')?.payload
  const plan =
    route?.executionPlan && typeof route.executionPlan === 'object'
      ? (route.executionPlan as Record<string, unknown>)
      : null
  const steps = Array.isArray(plan?.steps)
    ? plan.steps.filter((step): step is string => typeof step === 'string')
    : []
  const delegates = new Map<string, Record<string, unknown>>()
  for (const event of job?.events ?? []) {
    const value = event.payload.delegation
    if (event.channel === 'chat:delegation' && value && typeof value === 'object') {
      const delegation = value as Record<string, unknown>
      delegates.set(text(delegation.id), delegation)
    }
  }
  return (
    <section className="agent-chat-activity" aria-label="Latest chat activity">
      <div className="agent-section-heading">
        <h3>Latest chat</h3>
        <span className={`agents-inbox-status ${job?.status === 'running' ? 'is-live' : ''}`}>
          {job?.status ?? 'Ready'}
        </span>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : !job ? (
        <p>Send a message in chat to see its agent, plan, and specialist results here.</p>
      ) : (
        <>
          <p className="agent-current-goal">{job.goal}</p>
          <dl className="agent-route-facts">
            <div>
              <dt>Owner</dt>
              <dd>{text(route?.agentName) || 'Routing…'}</dd>
            </div>
            <div>
              <dt>Task</dt>
              <dd>{text(route?.intent) || 'Classifying…'}</dd>
            </div>
            <div>
              <dt>Tools</dt>
              <dd>{text(route?.toolPolicy) || 'Resolving…'}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{job.model || text(route?.model) || 'Resolving…'}</dd>
            </div>
          </dl>
          <p className="agents-inbox-live">{job.statusText}</p>
          {route && (
            <details className="agent-evidence">
              <summary>Routing decision</summary>
              <p>{text(route.reason)}</p>
            </details>
          )}
          {steps.length > 0 && (
            <details className="agent-evidence">
              <summary>Plan and completion criteria</summary>
              <ol>
                {steps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
              {text(plan?.doneWhen) && <p>Done when: {text(plan?.doneWhen)}</p>}
            </details>
          )}
          {[...delegates.values()].map((delegation) => (
            <details className="agent-evidence agent-specialist" key={text(delegation.id)}>
              <summary>
                {text(route?.agentName) || 'Coordinator'} → {text(delegation.agentName)} ·{' '}
                {text(delegation.status)}
              </summary>
              <p>{text(delegation.goal)}</p>
              <pre>{text(delegation.result) || 'Waiting for the specialist’s result.'}</pre>
            </details>
          ))}
          {job.answer && (
            <details className="agent-evidence">
              <summary>Response</summary>
              <pre>{job.answer}</pre>
            </details>
          )}
        </>
      )}
    </section>
  )
}
