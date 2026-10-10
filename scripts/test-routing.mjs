/**
 * Smoke tests for chat routing heuristics (no Electron / models required).
 * Run: node scripts/test-routing.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

// Compile-free: re-implement the pure classifiers inline mirroring chat-router.ts
// so CI can run without electron-vite build. Keep in sync with classifyIntent /
// isErisCapabilityQuestion / effectiveToolPolicy / resolveModelRoles logic.

function isErisCapabilityQuestion(text) {
  const t = text.trim()
  if (!t) return false
  if (
    /\b(what|which|list|show|name)\b[\s\S]{0,48}\b(ai\s+)?models?\b/i.test(t) ||
    /\b(ai\s+)?models?\b[\s\S]{0,48}\b(access|available|have|installed|connected|ready|using|use)\b/i.test(
      t
    )
  ) {
    return true
  }
  return false
}

function classifyIntent(text, mode) {
  if (isErisCapabilityQuestion(text)) return 'capability'
  if (mode === 'ask') return 'answer'
  const t = text.trim()
  if (!t) return 'answer'
  if (
    /\b(code review|pull request|pr review|security review)\b/i.test(t) ||
    (/\breview\b/i.test(t) && /\b(pr|diff|patch|commit)\b/i.test(t))
  ) {
    return 'review'
  }
  if (/\b(npm test|run tests|execute build)\b/i.test(t)) return 'run'
  if (
    /\b(create|implement|refactor|scaffold|fix|build)\b/i.test(t) ||
    /\b(write|add)\b[\s\S]{0,20}\b(skill|skills)\b/i.test(t)
  ) {
    return 'edit'
  }
  if (/\b(where is|find|locate|search|explore|inspect)\b/i.test(t)) return 'explore'
  return 'answer'
}

const RANK = { none: 0, read: 1, edit: 2, full: 3 }
function minCeiling(a, b) {
  return RANK[a] <= RANK[b] ? a : b
}
function intentFloor(intent) {
  if (intent === 'answer' || intent === 'capability') return 'none'
  if (intent === 'explore' || intent === 'review') return 'read'
  if (intent === 'edit') return 'edit'
  return 'full'
}
function effectiveToolPolicy(agentTools, intent, mode) {
  if (mode === 'ask' || intent === 'answer' || intent === 'capability') return 'none'
  return minCeiling(agentTools, intentFloor(intent))
}

function resolveModelRoles({ selectedModel, toolPolicy, preferEscalate, fullReady }) {
  const needsTools = toolPolicy !== 'none'
  if (!selectedModel.startsWith('builtin:')) {
    return { chat: selectedModel, tools: selectedModel, escalateToFull: false }
  }
  const isLite = /lite/i.test(selectedModel)
  if (!needsTools || !preferEscalate || !isLite) {
    return { chat: selectedModel, tools: selectedModel, escalateToFull: false }
  }
  if (fullReady) {
    return { chat: selectedModel, tools: 'builtin:composer', escalateToFull: true }
  }
  return { chat: selectedModel, tools: selectedModel, escalateToFull: false }
}

// --- cases ---
assert.equal(classifyIntent('What models do you have access to?', 'agent'), 'capability')
assert.equal(classifyIntent('What models do you have access to?', 'ask'), 'capability')
assert.equal(classifyIntent('explain this function', 'ask'), 'answer')
assert.equal(classifyIntent('implement a login form', 'agent'), 'edit')
assert.equal(classifyIntent('where is AuthService defined?', 'agent'), 'explore')
assert.equal(classifyIntent('code review this PR', 'agent'), 'review')
assert.equal(classifyIntent('run npm test', 'agent'), 'run')
assert.equal(classifyIntent('how does the app work?', 'agent'), 'answer')

assert.equal(effectiveToolPolicy('full', 'capability', 'agent'), 'none')
assert.equal(effectiveToolPolicy('none', 'edit', 'agent'), 'none')
assert.equal(effectiveToolPolicy('read', 'edit', 'agent'), 'read')
assert.equal(effectiveToolPolicy('full', 'edit', 'agent'), 'edit')
assert.equal(effectiveToolPolicy('full', 'run', 'agent'), 'full')
assert.equal(effectiveToolPolicy('edit', 'explore', 'ask'), 'none')

{
  const r = resolveModelRoles({
    selectedModel: 'builtin:composer-lite',
    toolPolicy: 'edit',
    preferEscalate: true,
    fullReady: true
  })
  assert.equal(r.chat, 'builtin:composer-lite')
  assert.equal(r.tools, 'builtin:composer')
  assert.equal(r.escalateToFull, true)
}
{
  const r = resolveModelRoles({
    selectedModel: 'qwen3:0.6b',
    toolPolicy: 'edit',
    preferEscalate: true,
    fullReady: true
  })
  assert.equal(r.chat, 'qwen3:0.6b')
  assert.equal(r.tools, 'qwen3:0.6b')
  assert.equal(r.escalateToFull, false)
}
{
  const r = resolveModelRoles({
    selectedModel: 'builtin:composer-lite',
    toolPolicy: 'none',
    preferEscalate: true,
    fullReady: true
  })
  assert.equal(r.tools, 'builtin:composer-lite')
  assert.equal(r.escalateToFull, false)
}

console.log('routing smoke tests ok')
// silence unused
void createRequire
void pathToFileURL
void root
