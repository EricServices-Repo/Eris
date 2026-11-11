/**
 * Bounded structural checks for HTML and CSS written by the agent (#509).
 *
 * Not a validator: browsers repair a great deal, and many legal pages omit
 * optional end tags. These checks report only what a broken edit leaves behind:
 * a close tag with no matching open, an unclosed block-level element, a second
 * page landmark, or an unbalanced CSS brace. No dependencies, no code execution.
 */

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param',
  'source', 'track', 'wbr', 'keygen', 'command', 'basefont', 'frame', 'isindex'
])

/** Elements whose end tag HTML lets authors omit; never reported as unclosed. */
const OPTIONAL_END = new Set([
  'html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th',
  'thead', 'tbody', 'tfoot', 'colgroup', 'caption', 'rt', 'rp'
])

/** Block-level containers whose missing end tag is reported. */
const BLOCK = new Set([
  'div', 'section', 'article', 'aside', 'nav', 'header', 'footer', 'main', 'form', 'ul', 'ol',
  'table', 'figure', 'blockquote', 'pre', 'fieldset', 'details', 'dialog', 'template', 'select',
  'textarea', 'button', 'label', 'a', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'svg'
])

/** Raw-text elements: their content is not markup. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title'])

/** At most one per document. */
const SINGLETON = ['head', 'body', 'main', 'title']

const MAX_CHARS = 1_000_000

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length

/** Returns a short description of the first structural problem, or null. */
export function htmlProblem(text: string): string | null {
  if (text.length > MAX_CHARS) return null
  const stack: Array<{ name: string; line: number }> = []
  const counts = new Map<string, number>()
  let topLevelFooters = 0
  let topLevelHeaders = 0
  const tag = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<!(?:doctype)?[^>]*>|<\/?([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi
  let match: RegExpExecArray | null
  while ((match = tag.exec(text))) {
    const name = match[1]?.toLowerCase()
    if (!name) continue // comment, CDATA or doctype
    const closing = match[0].startsWith('</')
    const selfClosing = /\/\s*>$/.test(match[0])
    const line = lineAt(text, match.index)
    if (!closing) {
      counts.set(name, (counts.get(name) ?? 0) + 1)
      // Top level: directly in <body> (or in a fragment with no wrapper at all).
      const topLevel = stack.every((entry) => entry.name === 'html' || entry.name === 'body')
      if (topLevel && name === 'footer') topLevelFooters++
      if (topLevel && name === 'header') topLevelHeaders++
      if (VOID.has(name) || selfClosing) continue
      if (RAW_TEXT.has(name)) {
        // Skip to the matching end tag; "</div>" inside a script string is text.
        const end = new RegExp(`</${name}\\s*>`, 'ig')
        end.lastIndex = tag.lastIndex
        const found = end.exec(text)
        if (!found) return `unclosed <${name}> opened at line ${line}`
        tag.lastIndex = end.lastIndex
        continue
      }
      stack.push({ name, line })
      continue
    }
    if (VOID.has(name)) continue // </br> and friends are tolerated by browsers
    const openIndex = stack.map((entry) => entry.name).lastIndexOf(name)
    if (openIndex === -1) return `unbalanced </${name}> at line ${line} (no matching <${name}>)`
    // Elements left open between the match and the top must be ones whose end tag is optional.
    for (const skipped of stack.slice(openIndex + 1))
      if (!OPTIONAL_END.has(skipped.name))
        return `unclosed <${skipped.name}> opened at line ${skipped.line} (closed by </${name}> at line ${line})`
    stack.length = openIndex
  }
  const leftover = stack.find((entry) => BLOCK.has(entry.name) && !OPTIONAL_END.has(entry.name))
  if (leftover) return `unclosed <${leftover.name}> opened at line ${leftover.line}`
  for (const name of SINGLETON)
    if ((counts.get(name) ?? 0) > 1) return `more than one <${name}> element`
  if (topLevelFooters > 1) return 'more than one top-level <footer> in <body>'
  if (topLevelHeaders > 1) return 'more than one top-level <header> in <body>'
  return null
}

/** Balanced { } outside strings and comments. */
export function cssProblem(text: string): string | null {
  if (text.length > MAX_CHARS) return null
  const masked = text.replace(/\/\*[\s\S]*?(?:\*\/|$)|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) =>
    m.replace(/[^\n]/g, ' ')
  )
  let depth = 0
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth < 0) return `unbalanced } at line ${lineAt(masked, i)}`
    }
  }
  return depth > 0 ? `${depth} unclosed { block${depth === 1 ? '' : 's'}` : null
}
