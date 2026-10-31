/** Pre-1.0 publishing is scripted-qualified; certified/1.x releases require measured evidence. */
function contextReleasePolicy({ version, evidenceRunId = '', requireCertification = false }) {
  const match = /^(\d+)\.\d+\.\d+(?:-[\w.-]+)?$/.exec(version)
  if (!match) throw new Error('Invalid release version')
  if (evidenceRunId && !/^\d+$/.test(evidenceRunId))
    throw new Error('Invalid evidence workflow run ID')
  const strict = Number(match[1]) >= 1 || requireCertification || Boolean(evidenceRunId)
  return {
    strict,
    qualification: strict ? 'certified-context-required' : 'development-scripted-only',
    reason: strict
      ? 'Packaged hardware and paired-model evidence must pass before publication.'
      : 'Pre-1.0 development release: deterministic context gates and packaged smoke required; hardware/live-model certification is not claimed.'
  }
}
module.exports = { contextReleasePolicy }
if (require.main === module) {
  const fs = require('node:fs')
  const requirement = (process.env.REQUIRE_CONTEXT_CERTIFICATION ?? '').toLowerCase()
  if (!['', 'true', 'false'].includes(requirement))
    throw new Error('Invalid certification policy setting')
  const policy = contextReleasePolicy({
    version: process.env.RELEASE_VERSION,
    evidenceRunId: process.env.CONTEXT_EVIDENCE_RUN_ID,
    requireCertification: requirement === 'true'
  })
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `strict=${policy.strict}\n`)
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${policy.reason}\n`)
  if (!policy.strict) {
    fs.mkdirSync('out/qualification', { recursive: true })
    fs.writeFileSync(
      'out/qualification/context-release-verification.json',
      JSON.stringify(
        {
          ...policy,
          certified: false,
          version: process.env.RELEASE_VERSION,
          sourceSha: process.env.RELEASE_SOURCE_SHA
        },
        null,
        2
      )
    )
  }
  console.log(policy.reason)
}
