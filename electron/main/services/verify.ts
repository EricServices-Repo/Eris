import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runWorkspaceCommand } from './shell-run'

export type VerifyResult = {
  ok: boolean
  command: string
  detail: string
  skipped?: boolean
}

type PkgJson = {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function readPackageJson(workspacePath: string): PkgJson | null {
  const pkgPath = join(workspacePath, 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')) as PkgJson
  } catch {
    return null
  }
}

function allDeps(pkg: PkgJson): Record<string, string> {
  return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
}

/** True when local npm tooling looks incomplete (missing .bin or empty install). */
export function workspaceDepsNeedInstall(workspacePath: string): boolean {
  const pkg = readPackageJson(workspacePath)
  if (!pkg) return false
  const hasDeps = Object.keys(allDeps(pkg)).length > 0
  if (!hasDeps) return false

  const modules = join(workspacePath, 'node_modules')
  const bin = join(modules, '.bin')
  if (!existsSync(modules) || !existsSync(bin)) return true

  try {
    const pkgPath = join(workspacePath, 'package.json')
    if (statSync(pkgPath).mtimeMs > statSync(modules).mtimeMs + 1000) return true
  } catch {
    return true
  }
  return false
}

function looksLikeMissingLocalBin(output: string): boolean {
  return (
    /sh:\s+\S+:\s+command not found/i.test(output) ||
    /'\S+'\s+is not recognized/i.test(output) ||
    /ENOENT.*node_modules[/\\]\.bin/i.test(output) ||
    /Cannot find module/i.test(output)
  )
}

/** CRA exits 1 when the suite is empty — not a product bug. */
function looksLikeNoTestsFound(output: string): boolean {
  return /No tests found, exiting with code 1/i.test(output) || /No tests found/i.test(output)
}

/** Tests import @testing-library/* but packages were never added to package.json. */
function missingTestingLibraryPackages(output: string): string[] {
  const pkgs = new Set<string>()
  const re = /Cannot find module ['"](@testing-library\/[a-z0-9-]+)['"]/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(output)) !== null) {
    pkgs.add(m[1]!)
  }
  return [...pkgs]
}

/** CRA + bare `jest` creates conflicting runners (jest-circus Validation Error). */
function looksLikeJestRunnerConflict(output: string): boolean {
  return (
    /testRunner option was not found/i.test(output) ||
    /jest-circus\/runner/i.test(output)
  )
}

function craTestCommand(viaNpmScript: boolean): string {
  // --passWithNoTests: empty projects must not fail Eris verify
  const flags = '--watchAll=false --passWithNoTests'
  return viaNpmScript
    ? `CI=true npm test -- ${flags}`
    : `CI=true npx react-scripts test ${flags}`
}

function isBareJestScript(script: string | undefined): boolean {
  if (!script) return false
  const s = script.trim()
  return /^jest(\s|$)/.test(s) || /^npx\s+jest(\s|$)/.test(s)
}

export type VerifyOptions = {
  /** Prefer typecheck/lint over full test suite (mid-loop). */
  preferTypecheck?: boolean
  /** When false, never run npm install during verify. */
  allowInstall?: boolean
  /** Asked before each install; resolve false to skip it. */
  approveInstall?: (command: string) => Promise<boolean>
}

/**
 * Pick a verify command from package.json.
 * Prefer Create React App's runner over bare jest (avoids jest-circus conflicts).
 */
export function detectVerifyCommand(
  workspacePath: string,
  opts?: Pick<VerifyOptions, 'preferTypecheck'>
): string | null {
  const pkg = readPackageJson(workspacePath)
  if (!pkg) {
    if (
      existsSync(join(workspacePath, 'pyproject.toml')) ||
      existsSync(join(workspacePath, 'requirements.txt'))
    ) {
      return null
    }
    return null
  }

  const scripts = pkg.scripts || {}
  const deps = allDeps(pkg)
  const hasReactScripts = Boolean(deps['react-scripts'])
  const hasTsconfig =
    existsSync(join(workspacePath, 'tsconfig.json')) ||
    existsSync(join(workspacePath, 'tsconfig.web.json'))

  // Mid-loop: cheap checks only
  if (opts?.preferTypecheck) {
    for (const name of ['typecheck', 'type-check', 'tsc', 'lint']) {
      if (scripts[name]) return `npm run ${name}`
    }
    if (hasTsconfig) return 'npx tsc --noEmit'
    // Fall through to test only when nothing cheaper exists
  }

  // CRA projects: never invoke bare jest — react-scripts owns the Jest version.
  if (hasReactScripts) {
    const testScript = scripts.test
    if (testScript && /react-scripts/.test(testScript)) {
      return craTestCommand(true)
    }
    if (!testScript || isBareJestScript(testScript)) {
      return craTestCommand(false)
    }
  }

  for (const name of ['typecheck', 'type-check', 'tsc', 'test', 'lint']) {
    if (!scripts[name]) continue
    if (name === 'test') {
      if (/react-scripts/.test(scripts[name])) {
        return craTestCommand(true)
      }
      if (isBareJestScript(scripts[name])) {
        return craTestCommand(true)
      }
      return `npm run ${name}`
    }
    return `npm run ${name}`
  }

  if (hasTsconfig) return 'npx tsc --noEmit'
  return null
}

function remediationForVerifyFailure(workspacePath: string, output: string): string {
  const pkg = readPackageJson(workspacePath)
  const deps = pkg ? allDeps(pkg) : {}
  const missingTl = missingTestingLibraryPackages(output)
  if (missingTl.length > 0) {
    return (
      `\n\nHint: Install test helpers into this workspace:\n` +
      `  npm install -D ${missingTl.join(' ')} @testing-library/jest-dom\n` +
      `Add src/setupTests.ts with: import '@testing-library/jest-dom'`
    )
  }
  if (looksLikeNoTestsFound(output)) {
    return '\n\nHint: No test files matched yet — add src/**/*.test.tsx (or use --passWithNoTests).'
  }
  if (looksLikeJestRunnerConflict(output) || (deps['react-scripts'] && /jest-circus/i.test(output))) {
    return (
      '\n\nHint: Create React App must use `react-scripts test`, not bare `jest`. ' +
      'Fix package.json: set `"test": "react-scripts test"`, remove a top-level `jest` dependency, ' +
      'then run `npm install` and re-test.'
    )
  }
  if (looksLikeMissingLocalBin(output)) {
    return '\n\nHint: Run `npm install` in this workspace so node_modules/.bin tools exist.'
  }
  return ''
}

async function ensureNpmInstall(
  workspacePath: string,
  signal?: AbortSignal,
  approveInstall?: (command: string) => Promise<boolean>
): Promise<{ ran: boolean; ok: boolean; detail: string }> {
  if (!workspaceDepsNeedInstall(workspacePath)) {
    return { ran: false, ok: true, detail: '' }
  }
  if (approveInstall && !(await approveInstall('npm install'))) {
    return { ran: true, ok: false, detail: 'npm install was denied by the user.' }
  }
  const install = await runWorkspaceCommand(workspacePath, 'npm install', {
    signal,
    timeoutMs: 300_000
  })
  const out = [install.stdout, install.stderr].filter(Boolean).join('\n').trim()
  return {
    ran: true,
    ok: install.ok && !install.timedOut,
    detail: install.timedOut
      ? `npm install timed out\n${out}`
      : `npm install exit ${install.code ?? '?'}\n${out || '(no output)'}`
  }
}

export async function runVerify(
  workspacePath: string,
  signal?: AbortSignal,
  opts?: VerifyOptions
): Promise<VerifyResult> {
  const allowInstall = opts?.allowInstall !== false
  const approve = async (cmd: string) => !opts?.approveInstall || opts.approveInstall(cmd)
  const command = detectVerifyCommand(workspacePath, {
    preferTypecheck: opts?.preferTypecheck
  })
  if (!command) {
    return {
      ok: true,
      command: '',
      detail: 'No typecheck/test/lint script found — skipped verify.',
      skipped: true
    }
  }

  let installNote = ''
  let ensured = { ran: false, ok: true, detail: '' }
  if (allowInstall) {
    ensured = await ensureNpmInstall(workspacePath, signal, opts?.approveInstall)
    if (ensured.ran) {
      installNote = `Ensured workspace deps:\n${ensured.detail}\n\n`
      if (!ensured.ok) {
        return {
          ok: false,
          command: 'npm install',
          detail: `${installNote}Verify aborted — install dependencies in this workspace first.`
        }
      }
    }
  }

  let ran = await runWorkspaceCommand(workspacePath, command, {
    signal,
    timeoutMs: 120_000
  })
  let out = [ran.stdout, ran.stderr].filter(Boolean).join('\n').trim()
  let usedCommand = command

  // Empty CRA suite — treat as pass (product code may ship before tests exist).
  if (!ran.ok && looksLikeNoTestsFound(out)) {
    return {
      ok: true,
      command: usedCommand,
      detail: `${installNote}Verify skipped tests: no test files found yet.\n${out}`,
      skipped: true
    }
  }

  // If we still hit a jest-circus conflict via npm test, retry CRA runner explicitly.
  if (!ran.ok && looksLikeJestRunnerConflict(out) && !opts?.preferTypecheck) {
    const pkg = readPackageJson(workspacePath)
    if (pkg && allDeps(pkg)['react-scripts']) {
      const fallback = craTestCommand(false)
      if (fallback !== command) {
        const retry = await runWorkspaceCommand(workspacePath, fallback, {
          signal,
          timeoutMs: 120_000
        })
        const retryOut = [retry.stdout, retry.stderr].filter(Boolean).join('\n').trim()
        installNote += `Retried with Create React App test runner:\n$ ${fallback}\n`
        ran = retry
        out = retryOut
        usedCommand = fallback
        if (!ran.ok && looksLikeNoTestsFound(out)) {
          return {
            ok: true,
            command: usedCommand,
            detail: `${installNote}Verify skipped tests: no test files found yet.\n${out}`,
            skipped: true
          }
        }
      }
    }
  }

  // Tests import @testing-library/* that aren't installed — add them once, then retry.
  const missingTl = missingTestingLibraryPackages(out)
  const toInstall = [...new Set([...missingTl, '@testing-library/jest-dom'])]
  const installCmd = `npm install -D ${toInstall.join(' ')}`
  if (allowInstall && !ran.ok && missingTl.length > 0 && (await approve(installCmd))) {
    const tlInstall = await runWorkspaceCommand(workspacePath, installCmd, {
      signal,
      timeoutMs: 300_000
    })
    const tlOut = [tlInstall.stdout, tlInstall.stderr].filter(Boolean).join('\n').trim()
    installNote += `Missing test libraries — ran:\n$ ${installCmd}\n${tlOut}\n\n`
      if (tlInstall.ok && !tlInstall.timedOut) {
      // Ensure CRA jest-dom matchers are wired
      const setupTs = join(workspacePath, 'src', 'setupTests.ts')
      const setupJs = join(workspacePath, 'src', 'setupTests.js')
      if (!existsSync(setupTs) && !existsSync(setupJs)) {
        try {
          mkdirSync(join(workspacePath, 'src'), { recursive: true })
          writeFileSync(setupTs, "import '@testing-library/jest-dom'\n", 'utf8')
          installNote += 'Created src/setupTests.ts\n\n'
        } catch {
          // ignore
        }
      }
      ran = await runWorkspaceCommand(workspacePath, usedCommand, {
        signal,
        timeoutMs: 120_000
      })
      out = [ran.stdout, ran.stderr].filter(Boolean).join('\n').trim()
      if (!ran.ok && looksLikeNoTestsFound(out)) {
        return {
          ok: true,
          command: usedCommand,
          detail: `${installNote}Verify skipped tests: no test files found yet.\n${out}`,
          skipped: true
        }
      }
    }
  }

  // Script binary / missing module — reinstall once (only when installs allowed).
  if (
    allowInstall &&
    !ran.ok &&
    looksLikeMissingLocalBin(out) &&
    missingTestingLibraryPackages(out).length === 0 &&
    existsSync(join(workspacePath, 'package.json')) &&
    !ensured.ran &&
    (await approve('npm install'))
  ) {
    const retryInstall = await runWorkspaceCommand(workspacePath, 'npm install', {
      signal,
      timeoutMs: 300_000
    })
    const installOut = [retryInstall.stdout, retryInstall.stderr]
      .filter(Boolean)
      .join('\n')
      .trim()
    installNote += `Missing local tool — ran npm install:\n${installOut}\n\n`
    if (retryInstall.ok && !retryInstall.timedOut) {
      ran = await runWorkspaceCommand(workspacePath, usedCommand, {
        signal,
        timeoutMs: 120_000
      })
      out = [ran.stdout, ran.stderr].filter(Boolean).join('\n').trim()
      if (!ran.ok && looksLikeNoTestsFound(out)) {
        return {
          ok: true,
          command: usedCommand,
          detail: `${installNote}Verify skipped tests: no test files found yet.\n${out}`,
          skipped: true
        }
      }
    } else {
      return {
        ok: false,
        command: 'npm install',
        detail: `${installNote}Verify aborted — npm install failed.`
      }
    }
  }

  const hint = !ran.ok ? remediationForVerifyFailure(workspacePath, out) : ''

  return {
    ok: ran.ok && !ran.timedOut,
    command: usedCommand,
    detail: ran.timedOut
      ? `${installNote}Verify timed out: ${usedCommand}\n${out}`
      : `${installNote}Verify ${ran.ok ? 'passed' : 'failed'}: ${usedCommand}\nexit ${ran.code ?? '?'}\n${out || '(no output)'}${hint}`
  }
}
