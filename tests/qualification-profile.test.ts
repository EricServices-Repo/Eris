import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * FR-045: the build gate runs named qualification profiles. A new suite must be
 * classified into a profile or into general, so it cannot silently miss the gate.
 */
const config = JSON.parse(readFileSync(join(__dirname, 'qualification-profiles.json'), 'utf8')) as {
  profiles: Record<string, { files: string[]; notRun?: string[] }>
  general: { files: string[] }
}
const classified = new Set([
  ...Object.values(config.profiles).flatMap((profile) => profile.files),
  ...config.general.files
])

describe('qualification profiles', () => {
  it('classify every test file', () => {
    const files = readdirSync(__dirname)
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => `tests/${name}`)
    expect(files.filter((file) => !classified.has(file))).toEqual([])
  })

  it('name only files that exist', () => {
    expect([...classified].filter((file) => !existsSync(join(__dirname, '..', file)))).toEqual([])
  })

  it('state what each gate does not exercise', () => {
    expect(config.profiles.agents!.notRun).toEqual(
      expect.arrayContaining(['live model inference', 'desktop chat UI delivery'])
    )
  })

  it('build scripts gate on the profiles, and the app relaunches only after a successful build', () => {
    const scripts = (
      JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts
    expect(scripts['test:agents']).toBe('node scripts/run-qualification.mjs agents')
    expect(scripts['test:dev-app']).toBe('node scripts/run-qualification.mjs dev-app')
    expect(scripts.prebuild).toBe('npm run test:agents')
    // A failed dist must not fall through to quitting and reopening an older binary.
    expect(scripts['start:app']).not.toMatch(/;/)
  })
})
