import { publishWorkspaceText, prepareMutationPlan, type MutationPlan } from './file-mutations'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolveInWorkspace, toWorkspaceRelative, WorkspaceFsError } from './workspace-fs'

type NotebookCell = {
  id?: string
  cell_type: string
  source: string | string[]
  outputs?: Array<Record<string, unknown>>
  execution_count?: number | null
  [key: string]: unknown
}

type NotebookDocument = {
  cells: NotebookCell[]
  [key: string]: unknown
}

const MAX_NOTEBOOK_SOURCE_CHARS = 1_600
const MAX_NOTEBOOK_OUTPUT_CHARS = 500
const MAX_NOTEBOOK_RESULT_CHARS = 28_000
const MAX_NOTEBOOK_FILE_BYTES = 2_000_000

function readNotebookDocument(
  workspacePath: string,
  userPath: string
): {
  path: string
  absPath: string
  raw: string
  notebook: NotebookDocument
} {
  if (!userPath.toLowerCase().endsWith('.ipynb')) {
    throw new WorkspaceFsError('Notebook tools only support .ipynb files')
  }
  const absPath = resolveInWorkspace(workspacePath, userPath)
  if (!existsSync(absPath)) throw new WorkspaceFsError(`Not found: ${userPath}`)
  if (!statSync(absPath).isFile()) throw new WorkspaceFsError(`Not a file: ${userPath}`)
  if (statSync(absPath).size > MAX_NOTEBOOK_FILE_BYTES) {
    throw new WorkspaceFsError(
      `Notebook exceeds the ${MAX_NOTEBOOK_FILE_BYTES}-byte tool limit: ${userPath}`
    )
  }
  const raw = readFileSync(absPath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new WorkspaceFsError(`Invalid notebook JSON: ${userPath}`)
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as NotebookDocument).cells)) {
    throw new WorkspaceFsError(`Notebook has no cells array: ${userPath}`)
  }
  if ((parsed as NotebookDocument).cells.some((cell) => !cell || typeof cell !== 'object')) {
    throw new WorkspaceFsError(`Notebook contains an invalid cell: ${userPath}`)
  }
  return {
    path: toWorkspaceRelative(workspacePath, absPath),
    absPath,
    raw,
    notebook: parsed as NotebookDocument
  }
}

function cellSource(source: NotebookCell['source']): string {
  return Array.isArray(source) ? source.join('') : typeof source === 'string' ? source : ''
}

function outputText(output: Record<string, unknown>): string {
  if (typeof output.ename === 'string' || typeof output.evalue === 'string') {
    const traceback = Array.isArray(output.traceback)
      ? output.traceback.filter((line): line is string => typeof line === 'string').join('\n')
      : ''
    return [
      [output.ename, output.evalue].filter((part) => typeof part === 'string').join(': '),
      traceback
    ]
      .filter(Boolean)
      .join('\n')
  }
  const data = output.data
  if (
    data &&
    typeof data === 'object' &&
    typeof (data as Record<string, unknown>)['text/plain'] === 'string'
  ) {
    return (data as Record<string, string>)['text/plain']!
  }
  return Array.isArray(output.text)
    ? output.text.filter((part): part is string => typeof part === 'string').join('')
    : typeof output.text === 'string'
      ? output.text
      : ''
}

/** Read notebook cells as compact text so execution metadata does not swamp context. */
export function readNotebook(
  workspacePath: string,
  userPath: string,
  selectedCell?: number
): {
  path: string
  detail: string
} {
  const { path, notebook } = readNotebookDocument(workspacePath, userPath)
  if (selectedCell != null && (!Number.isInteger(selectedCell) || !notebook.cells[selectedCell])) {
    throw new WorkspaceFsError(`Cell ${selectedCell} does not exist in ${path}`)
  }
  const parts = [`Notebook: ${path} · ${notebook.cells.length} cells`]
  const cells =
    selectedCell == null
      ? notebook.cells.map((cell, index) => ({ cell, index }))
      : [{ cell: notebook.cells[selectedCell]!, index: selectedCell }]
  cells.forEach(({ cell, index }) => {
    const type = ['code', 'markdown', 'raw'].includes(cell.cell_type) ? cell.cell_type : 'unknown'
    const source = cellSource(cell.source)
    parts.push(
      `\n## Cell ${index} (${type})\n${source.slice(0, MAX_NOTEBOOK_SOURCE_CHARS) || '(empty)'}`
    )
    if (source.length > MAX_NOTEBOOK_SOURCE_CHARS) parts.push('[cell source shortened]')
    if (type === 'code' && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
      const outputs = cell.outputs.map(outputText).filter(Boolean)
      if (outputs.length > 0) {
        const joinedOutput = outputs.join('\n…\n')
        const text = joinedOutput.slice(0, MAX_NOTEBOOK_OUTPUT_CHARS)
        parts.push(
          `Output:\n${text}${joinedOutput.length > MAX_NOTEBOOK_OUTPUT_CHARS ? '\n[output shortened]' : ''}`
        )
      }
    }
  })
  let detail = parts.join('\n')
  if (detail.length > MAX_NOTEBOOK_RESULT_CHARS) {
    detail = `${detail.slice(0, MAX_NOTEBOOK_RESULT_CHARS)}\n\n[Notebook view shortened; request individual cells for more detail.]`
  }
  return { path, detail }
}

function sourceForCell(source: string, previous: NotebookCell['source']): string | string[] {
  if (!Array.isArray(previous)) return source
  if (!source) return []
  return source.match(/[^\n]*\n|[^\n]+$/g) || [source]
}

export function editNotebookCell(
  workspacePath: string,
  options: {
    path: string
    operation: 'replace_source' | 'insert_before' | 'insert_after' | 'delete'
    cellIndex: number
    source?: string
    cellType?: 'code' | 'markdown' | 'raw'
  },
  plan?: MutationPlan
): { path: string; before: string; after: string; detail: string } {
  plan = prepareMutationPlan(workspacePath, [options.path], plan)
  const { path, raw, notebook } = readNotebookDocument(workspacePath, options.path)
  if (!['replace_source', 'insert_before', 'insert_after', 'delete'].includes(options.operation)) {
    throw new WorkspaceFsError(`Unsupported notebook edit operation: ${options.operation}`)
  }
  if (!Number.isInteger(options.cellIndex) || options.cellIndex < 0) {
    throw new WorkspaceFsError('cell_index must be a non-negative integer (zero-based)')
  }
  const index = options.cellIndex
  const cells = notebook.cells
  const cellType = options.cellType || 'code'

  if (options.operation === 'replace_source') {
    const cell = cells[index]
    if (!cell) throw new WorkspaceFsError(`Cell ${index} does not exist in ${path}`)
    if (typeof options.source !== 'string') {
      throw new WorkspaceFsError('source is required for replace_source')
    }
    cell.source = sourceForCell(options.source, cell.source)
    if (cell.cell_type === 'code') {
      cell.outputs = []
      cell.execution_count = null
    }
  } else if (options.operation === 'delete') {
    if (!cells[index]) throw new WorkspaceFsError(`Cell ${index} does not exist in ${path}`)
    cells.splice(index, 1)
  } else {
    if (!['code', 'markdown', 'raw'].includes(cellType)) {
      throw new WorkspaceFsError('cell_type must be code, markdown, or raw')
    }
    if ((cells.length === 0 && index !== 0) || (cells.length > 0 && !cells[index])) {
      throw new WorkspaceFsError(`Cell ${index} is outside ${path}`)
    }
    const insertIndex =
      cells.length === 0 ? 0 : options.operation === 'insert_before' ? index : index + 1
    if (typeof options.source !== 'string') {
      throw new WorkspaceFsError('source is required to insert a cell')
    }
    const cell: NotebookCell = {
      id: randomUUID().slice(0, 8),
      cell_type: cellType,
      metadata: {},
      source: sourceForCell(options.source, []),
      ...(cellType === 'code' ? { execution_count: null, outputs: [] } : {})
    }
    cells.splice(insertIndex, 0, cell)
  }

  const indentMatch = raw.match(/^[ \t]+"(?:cells|metadata|nbformat)"/m)?.[0].match(/^[ \t]+/)?.[0]
  const indent = indentMatch?.includes('\t')
    ? '\t'
    : ' '.repeat(Math.min(8, indentMatch?.length || 2))
  const newline = raw.includes('\r\n') ? '\r\n' : '\n'
  const formatted = JSON.stringify(notebook, null, indent).replace(/\n/g, newline)
  const after = formatted + (raw.endsWith('\n') ? newline : '')
  publishWorkspaceText(workspacePath, options.path, after, plan)
  return {
    path,
    before: raw,
    after,
    detail: `${options.operation.replaceAll('_', ' ')} at cell ${index} in ${path}`
  }
}
