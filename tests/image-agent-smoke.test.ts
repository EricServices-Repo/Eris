import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const model = vi.hoisted(() => ({ replies: [] as string[] }))

vi.mock('../electron/main/services/chat-runtime', () => ({
  streamModelChat: async function* () {
    yield model.replies.shift() ?? 'DONE: No more simulated responses.'
  }
}))

vi.mock('../electron/main/services/verify', () => ({
  runVerify: async () => ({
    ok: true,
    skipped: true,
    command: '',
    detail: 'corpus verification skipped'
  })
}))

vi.mock('../electron/main/services/shell-run', () => ({
  runWorkspaceCommand: async () => ({
    ok: true,
    code: 0,
    stdout: '100 simulated checks passed',
    stderr: '',
    timedOut: false
  })
}))

vi.mock('../electron/main/services/mcp-runtime', () => ({
  syncMcpRuntime: async () => undefined,
  listMcpTools: () => [],
  isMcpToolName: () => false,
  callMcpTool: async () => ({ ok: false, detail: 'no mcp' }),
  formatLiveMcpToolsPrompt: () => ''
}))

vi.mock('../electron/main/services/workspace-search', () => ({
  retrieveContextAsync: async () => ({ ok: true, paths: [], detail: '' }),
  workspaceGlob: () => ({ ok: true, detail: '' }),
  workspaceGrep: async () => ({ ok: true, detail: '' })
}))

vi.mock('../electron/main/services/code-index', () => ({
  findReferences: () => ({ ok: true, detail: '' }),
  findSymbols: () => ({ ok: true, detail: '' }),
  relatedFiles: () => ({ ok: true, detail: '' }),
  formatIndexSummary: () => ''
}))

import { runAgentWithWorkspaceTools } from '../electron/main/services/agent/loop'
import { getDefaults } from '../electron/main/services/settings'
import { restoreCheckpoint } from '../electron/main/services/checkpoints'
import type { AgentRunnerEvent } from '../electron/main/services/agent/types'
import type { TurnPlan } from '../src/shared/settings-schema'
import { existsSync } from 'fs'

const workspace = mkdtempSync(join(tmpdir(), 'eris-image-agent-smoke-'))
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZLsAAAAASUVORK5CYII=',
  'base64'
)
afterAll(() => rmSync(workspace, { recursive: true, force: true }))

const plan: TurnPlan = {
  intent: 'edit',
  agentId: 'composer',
  agentName: 'Composer',
  mode: 'agent',
  toolPolicy: 'edit',
  requiresTools: true,
  escalateToFull: false,
  models: { chat: 'builtin:composer-lite', tools: 'builtin:composer-lite' },
  reason: 'Generate a project illustration',
  method: 'manual'
}

describe('image generation agent smoke', () => {
  it('generates a binary asset, wires it into project code, emits structured metadata, and supports undo', async () => {
    const settings = structuredClone(getDefaults())
    settings.images = {
      backend: 'api',
      enabled: true,
      connectionId: 'images',
      model: 'gpt-image-test',
      size: '1024x1024',
      quality: 'auto'
    }
    settings.models.connections.push({
      id: 'images',
      name: 'Images',
      type: 'openai-compatible',
      provider: 'openai',
      enabled: true,
      baseUrl: 'https://images.example/v1',
      apiKeyRef: 'image-key',
      models: []
    })
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
      )
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'README.md'), '# Project image generation smoke fixture')
    const content = [
      'export const generatedHeroImage = "/assets/generated/hero.png"',
      'export function createHeroImage(): HTMLImageElement {',
      '  const image = document.createElement("img")',
      '  image.src = generatedHeroImage',
      '  image.alt = "Blue mountain illustration"',
      '  image.width = 1024',
      '  image.height = 1024',
      '  return image',
      '}',
      ''
    ].join('\n')
    model.replies.splice(
      0,
      model.replies.length,
      JSON.stringify({
        name: 'generate_image',
        prompt: 'A blue mountain illustration',
        path: 'public/assets/generated/hero.png'
      }),
      JSON.stringify({ name: 'write_file', path: 'src/hero.ts', content }),
      'DONE: Created the hero illustration and connected its path in src/hero.ts.'
    )
    const events: AgentRunnerEvent[] = []
    for await (const event of runAgentWithWorkspaceTools({
      workspacePath: workspace,
      settings,
      model: 'builtin:composer-lite',
      messages: [{ role: 'user', content: 'Create an illustration and add it to the application' }],
      temperature: 0,
      getSecret: () => 'test-secret',
      mode: 'agent',
      turnPlan: plan,
      mcp: 'off'
    }))
      events.push(event)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(workspace, 'public/assets/generated/hero.png'))).toEqual(png)
    expect(readFileSync(join(workspace, 'src/hero.ts'), 'utf8')).toContain(
      '/assets/generated/hero.png'
    )
    const assetEvent = events.find((event) => event.type === 'asset')
    expect(assetEvent).toMatchObject({
      type: 'asset',
      asset: { path: 'public/assets/generated/hero.png', mimeType: 'image/png' }
    })
    expect(events.some((event) => event.type === 'diff' && event.diff.op === 'binary')).toBe(true)
    expect(events.some((event) => event.type === 'progress' && event.incomplete)).toBe(false)
    expect(model.replies).toHaveLength(0)
    const checkpoint = events.find((event) => event.type === 'checkpoint')
    if (!checkpoint || checkpoint.type !== 'checkpoint') throw new Error('Missing checkpoint')
    expect(restoreCheckpoint(workspace, checkpoint.checkpointId).restored).toBe(2)
    expect(existsSync(join(workspace, 'public/assets/generated/hero.png'))).toBe(false)
    expect(existsSync(join(workspace, 'src/hero.ts'))).toBe(false)
  })
})
