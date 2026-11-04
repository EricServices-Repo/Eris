const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
function resolveSource(tagInput, readGit = git) {
  const tag = tagInput.startsWith('v') ? tagInput : `v${tagInput}`
  if (!/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag)) throw new Error('Invalid release tag')
  const source = readGit('rev-parse', `refs/tags/${tag}^{commit}`)
  if (!/^[a-f0-9]{40,64}$/.test(source)) throw new Error('Invalid release source SHA')
  readGit('merge-base', '--is-ancestor', source, 'origin/main')
  const pkg = JSON.parse(readGit('show', `${source}:package.json`))
  const lockText = readGit('show', `${source}:package-lock.json`) + '\n'
  const lock = JSON.parse(lockText)
  if (
    pkg.version !== tag.slice(1) ||
    lock.version !== pkg.version ||
    lock.packages[''].version !== pkg.version
  )
    throw new Error('Release tag and committed package versions must match')
  return {
    tag,
    version: pkg.version,
    build_ref: source,
    source_sha: source,
    tag_sha: source,
    lock_sha: hash(lockText)
  }
}
/**
 * The exact assets one platform job may publish for a version. A nonzero file count is
 * not a contract: one stray or stale file would satisfy it while the installer or the
 * updater feed is missing. Blockmaps are allowed only beside the asset they describe.
 */
function releaseAssetContract(platform, version) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(String(version)))
    throw new Error('Invalid release version')
  if (platform === 'mac')
    return {
      required: [
        `Eris-${version}-mac-arm64.dmg`,
        `Eris-${version}-mac-arm64.zip`,
        'latest-mac.yml',
        'context-qualification-mac.json'
      ],
      blockmapped: [`Eris-${version}-mac-arm64.dmg`, `Eris-${version}-mac-arm64.zip`],
      feed: 'latest-mac.yml'
    }
  if (platform === 'win')
    return {
      required: [
        `Eris-${version}-win-x64-setup.exe`,
        `Eris-Dev-${version}-win-x64-setup.exe`,
        'latest.yml',
        'context-qualification-win.json'
      ],
      blockmapped: [`Eris-${version}-win-x64-setup.exe`, `Eris-Dev-${version}-win-x64-setup.exe`],
      feed: 'latest.yml'
    }
  throw new Error('Invalid release platform')
}

/** Throws naming every missing and unexpected asset; the feed must name this version. */
function verifyReleaseAssets(names, platform, version, readFeed = () => '') {
  const contract = releaseAssetContract(platform, version)
  const present = new Set(names.filter((name) => !name.startsWith('release-provenance-')))
  const allowed = new Set([
    ...contract.required,
    ...contract.blockmapped.map((name) => `${name}.blockmap`)
  ])
  const missing = contract.required.filter((name) => !present.has(name))
  const unexpected = [...present].filter((name) => !allowed.has(name)).sort()
  const problems = []
  if (missing.length) problems.push(`missing ${missing.join(', ')}`)
  if (unexpected.length) problems.push(`unexpected ${unexpected.join(', ')}`)
  if (!missing.includes(contract.feed)) {
    const feed = readFeed(contract.feed)
    const declared = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(feed)?.[1]
    if (declared !== version)
      problems.push(
        `${contract.feed} declares version ${declared ?? '(none)'}, expected ${version}`
      )
  }
  if (problems.length)
    throw new Error(
      `Release assets for ${platform} ${version} do not match the contract: ${problems.join('; ')}`
    )
}

async function manifest(dir) {
  const platform = process.env.RELEASE_PLATFORM
  if (!['mac', 'win'].includes(platform)) throw new Error('Invalid release platform')
  const version = String(process.env.RELEASE_TAG || '').replace(/^v/, '')
  verifyReleaseAssets(fs.readdirSync(dir), platform, version, (name) =>
    fs.readFileSync(path.join(dir, name), 'utf8')
  )
  const source = git('rev-parse', 'HEAD')
  if (source !== process.env.RELEASE_SOURCE_SHA || source !== process.env.RELEASE_TAG_SHA)
    throw new Error('Build source must match the resolved tag SHA')
  const lockSha = hash(fs.readFileSync('package-lock.json', 'utf8').replace(/\r\n/g, '\n'))
  if (lockSha !== process.env.RELEASE_LOCK_SHA)
    throw new Error('Build lockfile differs from resolved source')
  const assets = []
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('release-provenance-')) continue
    const file = path.join(dir, name)
    if (!fs.statSync(file).isFile()) continue
    const digest = crypto.createHash('sha256')
    for await (const chunk of fs.createReadStream(file)) digest.update(chunk)
    assets.push({ name, bytes: fs.statSync(file).size, sha256: digest.digest('hex') })
  }
  if (!assets.length) throw new Error('No release assets')
  let signing = 'unverified'
  if (platform === 'mac') {
    const result = spawnSync('codesign', ['-dv', '--verbose=4', 'dist/mac-arm64/Eris.app'], {
      encoding: 'utf8'
    })
    const detail = (result.stdout || '') + (result.stderr || '')
    if (result.status === 0) signing = /Signature=adhoc/.test(detail) ? 'ad-hoc' : 'signed'
    else if (/not signed/.test(detail)) signing = 'unsigned'
  } else {
    const installer = assets.find((item) => /^Eris-\d.+setup\.exe$/.test(item.name))
    if (installer) {
      const result = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-AuthenticodeSignature -LiteralPath $env:ERIS_SIGNING_FILE).Status.ToString()'
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, ERIS_SIGNING_FILE: path.resolve(dir, installer.name) }
        }
      )
      if (result.status === 0)
        signing =
          result.stdout.trim() === 'Valid'
            ? 'signed'
            : result.stdout.trim() === 'NotSigned'
              ? 'unsigned'
              : 'invalid'
    }
  }
  fs.writeFileSync(
    path.join(dir, `release-provenance-${platform}.json`),
    JSON.stringify(
      {
        schema: 1,
        tag: process.env.RELEASE_TAG,
        sourceSha: source,
        tagSha: process.env.RELEASE_TAG_SHA,
        lockSha256: lockSha,
        platform,
        signing,
        workflowRun: process.env.GITHUB_RUN_ID,
        workflowAttempt: process.env.GITHUB_RUN_ATTEMPT,
        assets
      },
      null,
      2
    ) + '\n'
  )
}
module.exports = { resolveSource, manifest, releaseAssetContract, verifyReleaseAssets }
if (require.main === module) {
  if (process.argv[2] === 'manifest')
    manifest(process.argv[3]).catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
  else {
    const tag =
      process.env.RELEASE_TAG_INPUT ||
      (process.env.GITHUB_REF_TYPE === 'tag'
        ? process.env.GITHUB_REF_NAME
        : JSON.parse(fs.readFileSync('package.json', 'utf8')).version)
    const result = resolveSource(tag)
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(result)
        .map(([key, value]) => `${key}=${value}\n`)
        .join('')
    )
  }
}
