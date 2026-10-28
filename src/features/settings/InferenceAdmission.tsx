import { useEffect, useState } from 'react'
import type { IdeApi } from '@/shared/api'
export function InferenceAdmission() {
  const [state, setState] = useState<Awaited<ReturnType<IdeApi['inferenceAdmission']>> | null>(
      null
    ),
    [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    const refresh = () =>
      void window.ide
        .inferenceAdmission()
        .then((value) => {
          if (!disposed) setState(value)
        })
        .catch((e) => {
          if (!disposed) setError(String(e))
        })
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [])
  return (
    <section aria-label="Local inference queue">
      <h3>Local inference queue</h3>
      <p>
        Memory reservations are estimates. Device capacities are separate; GPU visibility does not
        imply pooled memory. Cancel work using its chat or image Stop button.
      </p>
      {error && <p role="alert">{error}</p>}
      {state && (
        <>
          <p>
            {state.active.length} active · {state.queued.length} queued
          </p>
          <ul>
            {state.active.map((r) => (
              <li key={r.id}>
                {r.owner} · {r.workload} · {r.deviceId ?? 'host / device unconfirmed'} · estimated{' '}
                {(r.reservedBytes / 1024 ** 3).toFixed(1)} GiB host
              </li>
            ))}
            {state.queued.map((r) => (
              <li key={r.id}>
                #{r.position} {r.owner} · {Math.round(r.waitMs / 1000)}s · {r.reason}
              </li>
            ))}
          </ul>
          <details>
            <summary>Recent resource incidents</summary>
            <ul>
              {state.incidents.map((r, i) => (
                <li key={i}>
                  {r.owner}: {r.kind} · {r.reason}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  )
}
