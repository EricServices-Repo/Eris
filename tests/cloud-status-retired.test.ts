import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CLOUD_AGENTS_ENABLED } from '../src/shared/cloud-agents'
import { StatusBar } from '../src/layout/StatusBar'
import { AgentPanel } from '../src/features/settings/panels/AgentPanel'

/** Cloud Agents are retired: nothing reports a cloud worker as "offline". */
describe('retired Cloud Agents status', () => {
  const bar = (accountNeedsReauth = false) =>
    renderToStaticMarkup(
      createElement(StatusBar, {
        agents: [],
        selectedAgentId: 'auto',
        routeLabel: null,
        composerReady: false,
        modelsOk: true,
        cloudHealth: {
          ok: false,
          authenticated: true,
          service: 'eris-cloud-agent',
          version: '',
          llmConfigured: false,
          maxParallel: 0,
          running: 0,
          queued: 0,
          error: 'Cloud Agents are not available'
        },
        accountNeedsReauth,
        onOpenSettings: () => {},
        onAgentChange: () => {}
      })
    )

  it('is off', () => expect(CLOUD_AGENTS_ENABLED).toBe(false))

  it('shows no cloud indicator in the status bar', () => {
    const html = bar()
    expect(html).not.toContain('Cloud: offline')
    expect(html).not.toContain('Local agents')
    expect(html).not.toContain('Composer')
  })

  it('still offers re-authentication when the account session expired', () => {
    expect(bar(true)).toContain('Re-auth')
  })

  it('describes where agents run without a cloud worker or Composer models', () => {
    const html = renderToStaticMarkup(createElement(AgentPanel))
    expect(html).toContain('Where agents run')
    expect(html).toContain('cloud:&lt;model&gt;')
    expect(html).not.toContain('Cloud Agents')
    expect(html).not.toContain('Composer')
  })
})
