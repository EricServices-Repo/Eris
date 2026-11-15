import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { privilegedChannel } from '../src/shared/privileged-ipc'
import { hasPrivilegedSchema } from '../electron/main/ipc/privileged'

/**
 * Every privileged handler (checkpoint:, git:, models:, fs:write) is rejected with
 * "Unregistered capability schema" unless it has an argument schema. That broke the
 * Local inference queue panel (models:admission).
 */
function registeredChannels(dir: string): string[] {
  const channels: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) channels.push(...registeredChannels(path))
    else if (entry.name.endsWith('.ts'))
      for (const match of readFileSync(path, 'utf8').matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g))
        channels.push(match[1]!)
  }
  return channels
}

describe('privileged IPC schemas', () => {
  const privileged = [...new Set(registeredChannels('electron/main'))].filter(privilegedChannel)

  it('finds the privileged handlers', () => {
    expect(privileged).toEqual(expect.arrayContaining(['models:admission', 'models:status', 'git:status']))
  })

  it('gives every registered privileged channel a schema', () => {
    expect(privileged.filter((channel) => !hasPrivilegedSchema(channel))).toEqual([])
  })
})
