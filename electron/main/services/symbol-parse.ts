import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'
import type { SymbolHit } from './code-index'

type ParserCtor = {
  init(opts?: { locateFile?: (name: string) => string }): Promise<void>
  new (): {
    setLanguage(lang: unknown): void
    parse(src: string): { rootNode: TsNode }
  }
  Language: { load(path: string): Promise<unknown> }
}

type TsNode = {
  type: string
  text: string
  startPosition: { row: number }
  namedChildren: TsNode[]
  childForFieldName?(name: string): TsNode | null
}

const GRAMMARS: Array<{ ext: RegExp; file: string }> = [
  { ext: /\.tsx$/i, file: 'tree-sitter-tsx.wasm' },
  { ext: /\.ts$/i, file: 'tree-sitter-typescript.wasm' },
  { ext: /\.(jsx|js|mjs|cjs)$/i, file: 'tree-sitter-javascript.wasm' },
  { ext: /\.(py|pyi)$/i, file: 'tree-sitter-python.wasm' },
  { ext: /\.go$/i, file: 'tree-sitter-go.wasm' },
  { ext: /\.rs$/i, file: 'tree-sitter-rust.wasm' }
]

const NAME_FIELDS = ['name', 'declarator']
const DEF_TYPES = new Set([
  'function_declaration',
  'function_definition',
  'method_definition',
  'method_declaration',
  'class_declaration',
  'class_definition',
  'type_alias_declaration',
  'interface_declaration',
  'lexical_declaration',
  'variable_declaration',
  'public_field_definition',
  'impl_item',
  'struct_item',
  'enum_item',
  'fn_item',
  'function_item'
])

let Parser: ParserCtor | null = null
let initPromise: Promise<boolean> | null = null
const languages = new Map<string, unknown>()

function grammarCandidates(fileName: string): string[] {
  const out: string[] = []
  if (typeof process.resourcesPath === 'string') {
    out.push(join(process.resourcesPath, 'resources', 'grammars', fileName))
    out.push(join(process.resourcesPath, 'grammars', fileName))
  }
  try {
    out.push(join(app.getAppPath(), 'resources', 'grammars', fileName))
  } catch {
    // ignore
  }
  out.push(join(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out', fileName))
  out.push(join(__dirname, '../../../node_modules/tree-sitter-wasms/out', fileName))
  return out
}

function wasmRuntimeCandidates(): string[] {
  const name = 'tree-sitter.wasm'
  const out: string[] = []
  try {
    out.push(join(dirname(require.resolve('web-tree-sitter')), name))
  } catch {
    // ignore
  }
  if (typeof process.resourcesPath === 'string') {
    out.push(join(process.resourcesPath, 'resources', 'grammars', name))
  }
  out.push(join(process.cwd(), 'node_modules', 'web-tree-sitter', name))
  return out
}

function firstExisting(paths: string[]): string | null {
  return paths.find((p) => existsSync(p)) ?? null
}

async function ensureParser(): Promise<boolean> {
  if (Parser) return true
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      const mod = (await import('web-tree-sitter')) as unknown as { default?: ParserCtor } & ParserCtor
      Parser = (mod.default ?? mod) as ParserCtor
      const wasm = firstExisting(wasmRuntimeCandidates())
      if (wasm) await Parser.init({ locateFile: () => wasm })
      else await Parser.init()
      return true
    } catch {
      Parser = null
      return false
    }
  })()
  return initPromise
}

async function languageFor(filePath: string): Promise<unknown | null> {
  const spec = GRAMMARS.find((g) => g.ext.test(filePath))
  if (!spec || !Parser) return null
  if (languages.has(spec.file)) return languages.get(spec.file)
  const wasm = firstExisting(grammarCandidates(spec.file))
  if (!wasm) return null
  try {
    const lang = await Parser.Language.load(wasm)
    languages.set(spec.file, lang)
    return lang
  } catch {
    return null
  }
}

function nodeName(node: TsNode): string | null {
  for (const field of NAME_FIELDS) {
    const child = node.childForFieldName?.(field)
    if (child?.text) {
      const ident = child.text.match(/[A-Za-z_][\w]*/)?.[0]
      if (ident) return ident
    }
  }
  const ident = node.namedChildren.find((c) => c.type === 'identifier' || c.type === 'type_identifier')
  return ident?.text ?? null
}

function kindOf(type: string): string {
  if (/class|struct|enum|impl/.test(type)) return 'class'
  if (/type|interface/.test(type)) return 'type'
  if (/function|method|fn_/.test(type)) return 'function'
  return 'const'
}

export function treeSitterSupported(filePath: string): boolean {
  return GRAMMARS.some((g) => g.ext.test(filePath))
}

export async function parseSymbolsAndRefs(
  filePath: string,
  rel: string,
  content: string
): Promise<{ symbols: SymbolHit[]; refs: Array<{ name: string; path: string; line: number }> }> {
  const empty = { symbols: [] as SymbolHit[], refs: [] as Array<{ name: string; path: string; line: number }> }
  if (!(await ensureParser()) || !Parser) return empty
  const lang = await languageFor(filePath)
  if (!lang) return empty
  const parser = new Parser()
  parser.setLanguage(lang)
  let root: TsNode
  try {
    root = parser.parse(content).rootNode
  } catch {
    return empty
  }
  const symbols: SymbolHit[] = []
  const refs: Array<{ name: string; path: string; line: number }> = []
  const walk = (node: TsNode) => {
    if (DEF_TYPES.has(node.type)) {
      const name = nodeName(node)
      if (name) symbols.push({ name, kind: kindOf(node.type), path: rel, line: node.startPosition.row + 1 })
    }
    if (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'property_identifier') {
      if (node.text && /^[A-Za-z_][\w]*$/.test(node.text) && node.text.length > 1) {
        refs.push({ name: node.text, path: rel, line: node.startPosition.row + 1 })
      }
    }
    for (const child of node.namedChildren) walk(child)
  }
  walk(root)
  return { symbols, refs }
}
