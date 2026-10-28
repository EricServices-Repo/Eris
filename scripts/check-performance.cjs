const { app, BrowserWindow } = require('electron')
const { createHash } = require('node:crypto')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eris-perf-'))
app.setPath('userData', profile)
app.setPath('appData', profile)
app.commandLine.appendSwitch('password-store', 'basic')
app.commandLine.appendSwitch('enable-precise-memory-info')
const arg = (flag) => {
  const index = process.argv.indexOf(flag)
  return index < 0 ? null : process.argv[index + 1]
}
const timer = setTimeout(() => {
  console.error('Performance fixture timed out')
  app.exit(1)
}, 120000)
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 1000,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false }
  })
  try {
    await window.loadFile(path.resolve('.eris/cache/client-check/performance.html'))
    const metrics = await window.webContents.executeJavaScript(
      `window.runPerformance(${process.argv.includes('--baseline')})`
    )
    let gitSha = 'unknown'
    try {
      gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    } catch {
      /* Metadata/cleanup is best effort; measurements and exit status remain authoritative. */
    }
    const report = {
      version: 1,
      createdAt: new Date().toISOString(),
      gitSha,
      sourceDigests: Object.fromEntries(
        [
          'package-lock.json',
          'src/components/VirtualList.tsx',
          'src/features/chat/ChatPanel.tsx',
          'src/features/chat/MarkdownMessage.tsx',
          'checks/performance-renderer.tsx',
          'checks/workspace-performance.ts',
          'checks/performance/budgets.json',
          'scripts/check-performance.cjs'
        ].map((file) => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')])
      ),
      baseline: process.argv.includes('--baseline'),
      hardware: {
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length,
        totalMemoryBytes: os.totalmem()
      },
      runtime: { electron: process.versions.electron, chrome: process.versions.chrome },
      metrics
    }
    const { runWorkspacePerformance, evaluatePerformanceBudget } = require(
      path.resolve('.eris/cache/performance/workspace-performance.cjs')
    )
    const profiles = JSON.parse(
      fs.readFileSync(path.resolve('checks/performance/budgets.json'), 'utf8')
    )
    report.budget = evaluatePerformanceBudget(report.hardware, metrics, profiles.profiles)
    if (!process.argv.includes('--skip-workspace')) {
      report.workspace = await runWorkspacePerformance()
      report.workspaceBudget = evaluatePerformanceBudget(
        report.hardware,
        report.workspace,
        profiles.workspaceProfiles
      )
    }
    const screenshot = arg('--screenshot')
    if (screenshot) fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG())
    const output = arg('--output') ?? path.resolve('out/qualification/ui-performance.json')
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    console.log('UI performance report: ' + output)
    console.log(JSON.stringify(metrics))
    if (
      process.argv.includes('--gate') &&
      (['over-budget', 'incomplete'].includes(report.budget.state) ||
        ['over-budget', 'incomplete'].includes(report.workspaceBudget?.state))
    )
      throw new Error('Hardware-matched performance budget exceeded; see saved report')
    clearTimeout(timer)
    window.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(timer)
    window.destroy()
    app.exit(1)
  }
})
app.on('quit', () => {
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    /* Metadata/cleanup is best effort; measurements and exit status remain authoritative. */
  }
})
