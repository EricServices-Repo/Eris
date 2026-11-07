import { relative, resolve } from 'node:path'

/** A profile passes only when its named files and every executed assertion passed. */
export function qualifyResults(root, files, results, exitCode, platformExclusions = []) {
  const expected = new Set(files)
  const executed = new Set((results?.testResults ?? []).map(file =>
    relative(root, resolve(file.name)).replaceAll('\\', '/')
  ))
  const assertions = (results?.testResults ?? []).flatMap(file => file.assertionResults ?? [])
  const missing = [...expected].filter(file => !executed.has(file))
  const unexpected = [...executed].filter(file => !expected.has(file))
  const exclusions = []
  const skipped = (results?.testResults ?? []).flatMap(file => {
    const path = relative(root, resolve(file.name)).replaceAll('\\', '/')
    return (file.assertionResults ?? []).filter(test => {
      if (test.status === 'passed' || test.status === 'failed') return false
      const exemption = platformExclusions.find(entry => entry.file === path &&
        entry.fullName === test.fullName && entry.reason?.trim() &&
        ['pending', 'skipped'].includes(test.status))
      if (exemption) exclusions.push(exemption)
      return !exemption
    })
  }).length
  const failures = []
  if (exitCode !== 0 || results?.success !== true) failures.push('Test runner failed or produced no successful report')
  if (!assertions.some(test => test.status === 'passed')) failures.push('No assertions passed')
  if (missing.length) failures.push('Profile files were not executed: ' + missing.join(', '))
  if (unexpected.length) failures.push('Unexpected files were executed: ' + unexpected.join(', '))
  if (skipped) failures.push(`${skipped} assertions were skipped or left todo`)
  if (assertions.some(test => test.status === 'failed')) failures.push('Assertions failed')
  return {
    pass: failures.length === 0,
    failures,
    exclusions,
    counts: { files: executed.size, tests: assertions.length,
      passed: assertions.filter(test => test.status === 'passed').length,
      failed: assertions.filter(test => test.status === 'failed').length,
      skipped: skipped + exclusions.length, platformExcluded: exclusions.length }
  }
}
