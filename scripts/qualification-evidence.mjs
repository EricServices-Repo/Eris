import { relative, resolve } from 'node:path'

/** A profile passes only when its named files and every executed assertion passed. */
export function qualifyResults(root, files, results, exitCode) {
  const expected = new Set(files)
  const executed = new Set((results?.testResults ?? []).map(file =>
    relative(root, resolve(file.name)).replaceAll('\\', '/')
  ))
  const assertions = (results?.testResults ?? []).flatMap(file => file.assertionResults ?? [])
  const missing = [...expected].filter(file => !executed.has(file))
  const unexpected = [...executed].filter(file => !expected.has(file))
  const skipped = assertions.filter(test => test.status !== 'passed' && test.status !== 'failed').length
  const failures = []
  if (exitCode !== 0 || results?.success !== true) failures.push('Test runner failed or produced no successful report')
  if (!assertions.length) failures.push('No assertions were executed')
  if (missing.length) failures.push('Profile files were not executed: ' + missing.join(', '))
  if (unexpected.length) failures.push('Unexpected files were executed: ' + unexpected.join(', '))
  if (skipped) failures.push(`${skipped} assertions were skipped or left todo`)
  if (assertions.some(test => test.status === 'failed')) failures.push('Assertions failed')
  return {
    pass: failures.length === 0,
    failures,
    counts: { files: executed.size, tests: assertions.length,
      passed: assertions.filter(test => test.status === 'passed').length,
      failed: assertions.filter(test => test.status === 'failed').length, skipped }
  }
}
