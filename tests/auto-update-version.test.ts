import { describe, expect, it } from 'vitest'
import { isRemoteNewer } from '../electron/main/services/auto-update'

describe('isRemoteNewer', () => {
  it('treats equal versions as not newer', () => {
    expect(isRemoteNewer('0.2.25', '0.2.25')).toBe(false)
    expect(isRemoteNewer('v0.2.25', '0.2.25')).toBe(false)
  })

  it('does not offer an older public feed over a newer local build', () => {
    expect(isRemoteNewer('0.2.16', '0.2.25')).toBe(false)
  })

  it('offers a newer feed version', () => {
    expect(isRemoteNewer('0.2.26', '0.2.25')).toBe(true)
    expect(isRemoteNewer('v0.3.0', '0.2.25')).toBe(true)
  })
})
