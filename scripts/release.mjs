#!/usr/bin/env node
/**
 * Version + distribute Eris, then publish a GitHub Release.
 *
 * Usage:
 *   node scripts/release.mjs                 # bump patch, build, tag, release
 *   node scripts/release.mjs --bump minor
 *   node scripts/release.mjs --bump major
 *   node scripts/release.mjs --version 0.2.0  # set exact version
 *   node scripts/release.mjs --no-bump        # use package.json as-is
 *   node scripts/release.mjs --dry-run        # print plan only
 *   node scripts/release.mjs --skip-build     # tag/release existing dist artifacts
 *
 * Requires: gh CLI authenticated with repo scope; clean git working tree for bump/tag.
 */

import { execSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pkgPath = join(root, 'package.json')
const changelogPath = join(root, 'CHANGELOG.md')

function parseArgs(argv) {
  const args = {
    bump: 'patch',
    version: null,
    noBump: false,
    dryRun: false,
    skipBuild: false,
    draft: false,
    prerelease: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--no-bump') args.noBump = true
    else if (a === '--skip-build') args.skipBuild = true
    else if (a === '--draft') args.draft = true
    else if (a === '--prerelease') args.prerelease = true
    else if (a === '--bump') args.bump = argv[++i] || 'patch'
    else if (a === '--version') args.version = argv[++i]
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
      process.exit(0)
    }
  }
  if (!['patch', 'minor', 'major'].includes(args.bump)) {
    die(`Invalid --bump ${args.bump} (use patch|minor|major)`)
  }
  return args
}

function die(msg) {
  console.error(`release: ${msg}`)
  process.exit(1)
}

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`)
  return execSync(cmd, {
    cwd: root,
    stdio: 'inherit',
    encoding: 'utf8',
    ...opts
  })
}

function runCapture(cmd) {
  return execSync(cmd, { cwd: root, encoding: 'utf8' }).trim()
}

function readPkg() {
  return JSON.parse(readFileSync(pkgPath, 'utf8'))
}

function writePkg(pkg) {
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
}

function bumpSemver(version, kind) {
  const m = String(version).match(/^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/)
  if (!m) die(`Invalid semver in package.json: ${version}`)
  let major = Number(m[1])
  let minor = Number(m[2])
  let patch = Number(m[3])
  if (kind === 'major') {
    major += 1
    minor = 0
    patch = 0
  } else if (kind === 'minor') {
    minor += 1
    patch = 0
  } else {
    patch += 1
  }
  return `${major}.${minor}.${patch}`
}

function ensureCleanGit() {
  const status = runCapture('git status --porcelain')
  if (status) {
    die(
      'Working tree is not clean. Commit or stash changes before releasing.\n' + status
    )
  }
}

function ensureGh() {
  const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' })
  if (r.status !== 0) {
    die('gh is not authenticated. Run: gh auth login')
  }
}

function collectArtifacts(version) {
  const dist = join(root, 'dist')
  if (!existsSync(dist)) return []
  const wanted = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) {
        // Skip unpacked .app bundles — we ship dmg/zip
        if (name.endsWith('.app')) continue
        walk(full)
        continue
      }
      if (/\.(dmg|zip|yml|yaml|blockmap)$/i.test(name)) {
        wanted.push(full)
      }
    }
  }
  walk(dist)
  // Prefer versioned filenames when present
  const versioned = wanted.filter((p) => p.includes(version))
  return (versioned.length ? versioned : wanted).filter((p) => !p.endsWith('builder-debug.yml'))
}

function notesFromGit(prevTag, version) {
  let range = ''
  try {
    if (prevTag) range = `${prevTag}..HEAD`
    else range = 'HEAD'
  } catch {
    range = 'HEAD'
  }
  let log = ''
  try {
    log = runCapture(`git log ${range} --pretty=format:"- %s (%h)"`)
  } catch {
    log = '- Initial release'
  }
  const lines = [
    `## Eris v${version}`,
    '',
    'macOS build (Apple Silicon). Download the `.dmg` or `.zip`, open, and move Eris to Applications.',
    '',
    '### Changes',
    log || '- See commit history',
    ''
  ]
  return lines.join('\n')
}

function prependChangelog(version, body) {
  const date = new Date().toISOString().slice(0, 10)
  const entry = `## ${version} — ${date}\n\n${body.replace(/^## Eris v[\d.]+\n\n/, '')}\n`
  const prev = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '# Changelog\n\n'
  const next = prev.startsWith('# Changelog')
    ? prev.replace('# Changelog\n\n', `# Changelog\n\n${entry}`)
    : `# Changelog\n\n${entry}${prev}`
  writeFileSync(changelogPath, next, 'utf8')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  ensureGh()

  const pkg = readPkg()
  const prevVersion = pkg.version
  let nextVersion = prevVersion
  if (args.version) {
    if (!/^\d+\.\d+\.\d+/.test(args.version)) die(`Invalid --version ${args.version}`)
    nextVersion = args.version.replace(/^v/, '')
  } else if (!args.noBump) {
    nextVersion = bumpSemver(prevVersion, args.bump)
  }

  const tag = `v${nextVersion}`
  let prevTag = ''
  try {
    prevTag = execSync('git describe --tags --abbrev=0', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    prevTag = ''
  }

  console.log(`Eris release plan`)
  console.log(`  current: ${prevVersion}`)
  console.log(`  next:    ${nextVersion} (${tag})`)
  console.log(`  bump:    ${args.noBump || args.version ? 'none' : args.bump}`)
  console.log(`  build:   ${args.skipBuild ? 'skip' : 'dist:release'}`)
  console.log(`  dry-run: ${args.dryRun}`)

  if (args.dryRun) {
    console.log('Dry run — no changes made.')
    return
  }

  if (!args.noBump || args.version) {
    ensureCleanGit()
    if (pkg.version !== nextVersion) {
      pkg.version = nextVersion
      writePkg(pkg)
      // Keep lockfile version field in sync when present
      const lockPath = join(root, 'package-lock.json')
      if (existsSync(lockPath)) {
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
        lock.version = nextVersion
        if (lock.packages?.['']) lock.packages[''].version = nextVersion
        writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
      }
    }
  }

  const notes = notesFromGit(prevTag && prevTag !== tag ? prevTag : '', nextVersion)
  prependChangelog(nextVersion, notes)

  if (!args.skipBuild) {
    run('npm run dist:release')
  }

  const artifacts = collectArtifacts(nextVersion)
  if (artifacts.length === 0) {
    die('No release artifacts found in dist/ (expected .dmg / .zip). Run without --skip-build.')
  }
  console.log('Artifacts:')
  for (const a of artifacts) console.log(`  ${a}`)

  // Commit version bump + changelog when we changed files
  const dirty = runCapture('git status --porcelain')
  if (dirty) {
    run('git add package.json package-lock.json CHANGELOG.md')
    run(`git commit -m "Release ${tag}"`)
  }

  // Tag + push
  const existingTag = spawnSync('git', ['rev-parse', tag], { cwd: root, encoding: 'utf8' })
  if (existingTag.status === 0) {
    die(`Tag ${tag} already exists. Bump version or delete the tag first.`)
  }
  run(`git tag -a ${tag} -m "Eris ${tag}"`)
  run('git push origin HEAD')
  run(`git push origin ${tag}`)

  const ghArgs = [
    'release',
    'create',
    tag,
    ...artifacts,
    '--title',
    `Eris ${tag}`,
    '--notes',
    notes
  ]
  if (args.draft) ghArgs.push('--draft')
  if (args.prerelease) ghArgs.push('--prerelease')

  console.log(`$ gh ${ghArgs.map((a) => (a.includes('\n') ? '[notes]' : a)).join(' ')}`)
  const gh = spawnSync('gh', ghArgs, { cwd: root, stdio: 'inherit', encoding: 'utf8' })
  if (gh.status !== 0) die('gh release create failed')

  console.log(`\nPublished ${tag}`)
  try {
    const url = runCapture(`gh release view ${tag} --json url -q .url`)
    console.log(url)
  } catch {
    // ignore
  }
}

main()
