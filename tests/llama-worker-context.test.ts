import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/** Drives the real worker entry over its message port with a scripted native runtime. */
const h = vi.hoisted(() => ({
  sizes: [] as number[],
  posted: [] as Array<Record<string, unknown>>,
  prompts: [] as string[],
  sequencesLeft: 1,
  send: null as null | ((msg: unknown) => void)
}))

vi.mock('node-llama-cpp', () => {
  class LlamaChatSession {
    disposed = false
    setChatHistory() {}
    async prompt(text: string) {
      h.prompts.push(text)
      return 'ok'
    }
    dispose() {
      this.disposed = true
    }
  }
  const createContext = async () => ({
    contextSize: h.sizes.shift() ?? 512,
    get sequencesLeft() {
      return h.sequencesLeft
    },
    getSequence: () => ({ dispose() {} }),
    dispose: async () => {}
  })
  const model = {
    tokenize: (text: string) => new Array(Math.ceil(text.length / 4)),
    trainContextSize: 131072,
    gpuLayers: 0,
    createContext,
    dispose: async () => {}
  }
  return {
    LlamaChatSession,
    getLlama: async () => ({ gpu: false, loadModel: async () => model })
  }
})

const posted = (type: string) => h.posted.filter((msg) => msg.type === type)
const until = async (ready: () => unknown) => {
  await vi.waitFor(() => expect(ready()).toBeTruthy(), { timeout: 2000, interval: 5 })
}

beforeAll(async () => {
  const process_ = process as unknown as { parentPort?: unknown }
  process_.parentPort = {
    postMessage: (msg: Record<string, unknown>) => h.posted.push(msg),
    on: (_event: string, handler: (event: { data: unknown }) => void) => {
      h.send = (data) => handler({ data })
    }
  }
  await import('../electron/main/llama-worker')
  h.sizes = [2048]
  h.send!({
    type: 'load',
    modelPath: '/m.gguf',
    contextSize: 8192,
    contextMin: 2048,
    requestId: 'r'
  })
  await until(() => posted('loaded').length)
})
afterAll(() => {
  delete (process as unknown as { parentPort?: unknown }).parentPort
})
beforeEach(() => {
  h.prompts.length = 0
  h.sequencesLeft = 1
})

const chat = (id: string, content: string) =>
  h.send!({
    type: 'chat',
    id,
    messages: [{ role: 'user', content }],
    temperature: 0,
    maxTokens: 512
  })

describe('llama worker context checks', () => {
  it('reports the allocation it loaded with', () => {
    expect(posted('loaded')[0]).toMatchObject({ contextSize: 2048 })
  })

  it('generates a prompt that fits', async () => {
    chat('fits', 'x'.repeat(4000))
    await until(() => h.posted.some((msg) => msg.id === 'fits' && msg.type === 'done'))
    expect(h.prompts).toHaveLength(1)
  })

  it('rejects an oversized prompt before generating anything', async () => {
    chat('big', 'x'.repeat(9000))
    await until(() => h.posted.some((msg) => msg.id === 'big' && msg.type === 'error'))
    expect(h.prompts).toHaveLength(0)
    expect(h.posted.find((msg) => msg.id === 'big')?.error).toMatch(
      /exceeds the 2,048-token context/
    )
  })

  it('reports a rebuilt context, and judges the request against its new size', async () => {
    h.sequencesLeft = 0
    h.sizes = [1024]
    chat('rebuilt', 'x'.repeat(6000)) // Fits 2,048. Does not fit the rebuilt 1,024.
    await until(() => h.posted.some((msg) => msg.id === 'rebuilt' && msg.type === 'error'))
    expect(posted('context-allocated').at(-1)).toMatchObject({ contextSize: 1024 })
    expect(h.prompts).toHaveLength(0)
  })
})
