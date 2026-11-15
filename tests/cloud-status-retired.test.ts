import { describe, expect, it } from 'vitest'
import {
  CLOUD_AGENTS_ENABLED,
  cloudStatusIndicator,
  LOCAL_AGENTS_DESCRIPTION
} from '../src/shared/cloud-agents'

/** Cloud Agents are retired: nothing reports a cloud worker as "offline". */
describe('retired Cloud Agents status', () => {
  it('is off', () => expect(CLOUD_AGENTS_ENABLED).toBe(false))

  it('hides the status bar cloud indicator while retired', () => {
    expect(cloudStatusIndicator(false)).toBe('hidden')
  })

  it('still offers re-authentication when the account session expired', () => {
    expect(cloudStatusIndicator(true)).toBe('reauth')
  })

  it('keeps the cloud indicator if Cloud Agents come back', () => {
    expect(cloudStatusIndicator(false, true)).toBe('cloud')
    expect(cloudStatusIndicator(true, true)).toBe('cloud')
  })

  it('describes where agents run without Composer models', () => {
    expect(LOCAL_AGENTS_DESCRIPTION).toContain('cloud:<model>')
    expect(LOCAL_AGENTS_DESCRIPTION).not.toMatch(/Composer|Cloud Agents/)
  })
})
