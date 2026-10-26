import { createInterface } from 'readline'
import { z } from 'zod'
import { productionQualityAdapter } from './quality-adapter'
export async function qualityStdio(): Promise<void> {
  const lines = createInterface({ input: process.stdin })
  let bytes = 0
  for await (const line of lines) {
    bytes += Buffer.byteLength(line)
    if (bytes > 1_000_000) throw new Error('Quality input exceeds 1 MB')
    const history = z
      .array(
        z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(128000) }).strict()
      )
      .max(100)
    const input = z
      .object({
        live: z.literal(true),
        context: z.number().int().min(512).max(128000),
        model: z.string().min(1).max(2048),
        repeat: z.number().int().min(0).max(9),
        maxCalls: z.number().int().min(1).max(16),
        maxOutputTokens: z.number().int().min(128).max(65536),
        test: z
          .object({
            id: z.string().max(256),
            stratum: z.string().max(128),
            prompt: z.string().max(128000),
            project: z.record(z.string(), z.string()).nullable(),
            history: history.optional(),
            fault: z.string().max(128).optional(),
            oracle: z.string().max(64),
            expected: z.unknown().optional(),
            obligations: z.array(z.string().max(4096)).max(100)
          })
          .strict()
      })
      .strict()
      .parse(JSON.parse(line))
    const controller = new AbortController()
    const result = await productionQualityAdapter(input.context).run({
      ...input,
      signal: controller.signal
    })
    await new Promise<void>((resolve, reject) =>
      process.stdout.write('ERIS_QUALITY_RESULT ' + JSON.stringify(result) + '\n', (error) =>
        error ? reject(error) : resolve()
      )
    )
    lines.close()
    return
  }
  throw new Error('Quality input missing')
}
