#!/usr/bin/env node
/**
 * One-shot: read ERIS_FEEDBACK_GITHUB_TOKEN from EricServices config.local.php,
 * write resources/eris-feedback-token, and set the GitHub Actions secret.
 * Does not print the token.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const configPath =
  process.env.ERIS_SITE_CONFIG ||
  join(root, '../EricServices/config.local.php')

const raw = readFileSync(configPath, 'utf8')
const m = raw.match(/\$ERIS_FEEDBACK_GITHUB_TOKEN\s*=\s*['"]([^'"]+)['"]/)
if (!m?.[1] || /REPLACE|…|\.\.\./i.test(m[1]) || m[1].length < 20) {
  console.error('No usable $ERIS_FEEDBACK_GITHUB_TOKEN in', configPath)
  process.exit(1)
}
const token = m[1]

const localPath = join(root, 'resources/eris-feedback-token')
writeFileSync(localPath, token, { mode: 0o600 })
console.log('Wrote resources/eris-feedback-token (gitignored)')

const tmp = join(tmpdir(), `eris-feedback-ghsecret-${process.pid}`)
writeFileSync(tmp, token, { mode: 0o600 })
const r = spawnSync(
  'gh',
  ['secret', 'set', 'ERIS_FEEDBACK_GITHUB_TOKEN', '-R', 'EricServices-Repo/Eris'],
  { input: token, encoding: 'utf8' }
)
unlinkSync(tmp)
if (r.status !== 0) {
  console.error(r.stderr || r.stdout || 'gh secret set failed')
  process.exit(r.status || 1)
}
console.log('Set GitHub secret ERIS_FEEDBACK_GITHUB_TOKEN on EricServices-Repo/Eris')
