#!/usr/bin/env node
/**
 * Version Eris, tag, and push — CI builds macOS + Windows into dist/ and
 * uploads them to the GitHub Release for that tag.
 *
 * Usage:
 *   node scripts/release.mjs --no-bump        # tag the integrated version already in package.json
 *   node scripts/release.mjs --local-build    # also build installers on this machine into dist/
 *   node scripts/release.mjs --dry-run
 *
 * Version control: single semver in package.json / package-lock.json / git tag vX.Y.Z.
 * Artifacts are named per platform (…-mac-… / …-win-…).
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
    localBuild: false,
    draft: false,
    prerelease: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--no-bump') args.noBump = true
    else if (a === '--local-build') args.localBuild = true
    else if (a === '--skip-build') args.localBuild = false // legacy alias: CI-only
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
      'Release source must be clean. Prepare changes on a release branch and integrate them by PR first.\n' + status
    )
  }
}

function ensureGh() {
  const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' })
  if (r.status !== 0) {
    die('gh is not authenticated. Run: gh auth login')
  }
}

function ensureReleaseSource(version, noBump) {
  if (!noBump) {
    die(
      'Prepare and commit the version/changelog on a release branch, then integrate it by pull request before tagging. Run this script with --no-bump from the integrated release source.'
    )
  }
  const branch = runCapture('git branch --show-current')
  const required = 'main'
  if (branch !== required) {
    die(`v${version} must be tagged from integrated ${required}; current branch is ${branch || '(detached HEAD)'}.`)
  }
  ensureCleanGit()
  const head = runCapture('git rev-parse HEAD')
  const remote = runCapture(`git rev-parse refs/remotes/origin/${required}`)
  if (head !== remote) {
    die(`Release HEAD must equal origin/${required}; use the integrated GitHub branch tip before tagging.`)
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
        if (name.endsWith('.app') || name === 'win-unpacked' || name === 'mac' || name.startsWith('mac-')) {
          continue
        }
        walk(full)
        continue
      }
      if (/\.(dmg|zip|exe|yml|yaml|blockmap)$/i.test(name)) {
        wanted.push(full)
      }
    }
  }
  walk(dist)
  const versioned = wanted.filter((p) => p.includes(version))
  return (versioned.length ? versioned : wanted).filter((p) => !p.endsWith('builder-debug.yml'))
}

function notesFromGit(prevTag, version) {
  let range = prevTag ? `${prevTag}..HEAD` : 'HEAD'
  let log = ''
  try {
    log = runCapture(`git log ${range} --pretty=format:"- %s (%h)"`)
  } catch {
    log = '- Initial release'
  }
  return [
    `## Eris v${version}`,
    '',
    'Cross-platform desktop builds (macOS + Windows) from the same version tag.',
    '',
    '| Platform | Download |',
    '|----------|----------|',
    `| macOS | \`Eris-${version}-mac-*.dmg\` / \`.zip\` |`,
    `| Windows | \`Eris-${version}-win-*-setup.exe\` |`,
    '',
    'CI builds both platforms on tag push (`.github/workflows/release.yml`).',
    '',
    '### Changes',
    log || '- See commit history',
    ''
  ].join('\n')
}

function prependChangelog(version, body) {
  const date = new Date().toISOString().slice(0, 10)
  const entry = `## ${version} — ${date}\n\n${body.replace(/^## Eris v[\d.]+\n\n/, '')}\n`
  const prev = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '# Changelog\n\n'
  if (new RegExp(`^## ${version.replace(/\./g, '\\.')}(?:\\s|$)`, 'm').test(prev)) {
    return
  }
  const next = prev.startsWith('# Changelog')
    ? prev.replace('# Changelog\n\n', `# Changelog\n\n${entry}`)
    : `# Changelog\n\n${entry}${prev}`
  writeFileSync(changelogPath, next, 'utf8')
}

function localDistScript() {
  const plat = process.platform
  if (plat === 'darwin') return 'dist:release:mac'
  if (plat === 'win32') return 'dist:release:win'
  die(`--local-build is only supported on macOS or Windows (got ${plat}). Use tag + CI for both platforms.`)
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
  console.log(`  current:     ${prevVersion}`)
  console.log(`  next:        ${nextVersion} (${tag})`)
  console.log(`  bump:        ${args.noBump || args.version ? 'none' : args.bump}`)
  console.log(`  local-build: ${args.localBuild ? localDistScript() : 'no (CI builds mac + win)'}`)
  console.log(`  dry-run:     ${args.dryRun}`)

  if (args.dryRun) {
    console.log('Dry run — no changes made.')
    return
  }

  ensureReleaseSource(nextVersion, args.noBump)

  if (!args.noBump || args.version) {
    ensureCleanGit()
    if (pkg.version !== nextVersion) {
      pkg.version = nextVersion
      writePkg(pkg)
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
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : ''
  if (!new RegExp(`^## ${nextVersion.replace(/\./g, '\\.')}(?:\\s|$)`, 'm').test(changelog)) {
    die(`CHANGELOG.md must already contain v${nextVersion}; prepare it on a release branch and integrate it by PR before tagging.`)
  }
  prependChangelog(nextVersion, notes)

  if (args.localBuild) {
    run(`npm run ${localDistScript()}`)
    const artifacts = collectArtifacts(nextVersion)
    if (artifacts.length === 0) {
      die('No local release artifacts found in dist/.')
    }
    console.log('Local dist/ artifacts:')
    for (const a of artifacts) console.log(`  ${a}`)
  }

  const dirty = runCapture('git status --porcelain')
  if (dirty) die('Release preparation changed files. Integrate the version/changelog by pull request, then rerun from the release source.')

  const existingTag = spawnSync('git', ['rev-parse', tag], { cwd: root, encoding: 'utf8' })
  if (existingTag.status === 0) {
    die(`Tag ${tag} already exists. Bump version or delete the tag first.`)
  }
  run(`git tag -a ${tag} -m "Eris ${tag}"`)
  run(`git push origin ${tag}`)

  // Create/update the GitHub Release shell; CI attaches mac + win assets.
  const view = spawnSync('gh', ['release', 'view', tag], {
    cwd: root,
    encoding: 'utf8'
  })
  if (view.status !== 0) {
    const ghArgs = [
      'release',
      'create',
      tag,
      '--title',
      `Eris ${tag}`,
      '--notes',
      notes
    ]
    if (args.draft) ghArgs.push('--draft')
    if (args.prerelease) ghArgs.push('--prerelease')
    console.log(`$ gh release create ${tag} …`)
    const gh = spawnSync('gh', ghArgs, { cwd: root, stdio: 'inherit', encoding: 'utf8' })
    if (gh.status !== 0) die('gh release create failed')
  }

  if (args.localBuild) {
    const artifacts = collectArtifacts(nextVersion)
    if (artifacts.length) {
      const upload = spawnSync(
        'gh',
        ['release', 'upload', tag, ...artifacts, '--clobber'],
        { cwd: root, stdio: 'inherit', encoding: 'utf8' }
      )
      if (upload.status !== 0) {
        console.warn('release: local artifact upload failed (CI may still attach builds)')
      }
    }
  }

  console.log(`\nTagged ${tag}. CI Release workflow builds macOS + Windows into dist/ and uploads them.`)
  try {
    const url = runCapture(`gh release view ${tag} --json url -q .url`)
    console.log(url)
    console.log(`Workflow: https://github.com/EricServices-Repo/Eris/actions`)
  } catch {
    // ignore
  }
}

main()
