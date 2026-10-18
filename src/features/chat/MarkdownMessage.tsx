import { Fragment, memo, type ReactNode } from 'react'

interface Props {
  content: string
  onOpenPath?: (path: string) => void
  /** Skip markdown parse while tokens stream (cheaper paint / lower TTFT). */
  plain?: boolean
}

function renderInline(text: string, onOpenPath?: (path: string) => void): ReactNode[] {
  const nodes: ReactNode[] = []
  // inline code, bold, italic, paths like `src/foo.ts` or bare path-ish tokens
  const re =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))|((?:[\w./@-]+\/)+[\w./@-]+\.\w+)/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) {
      nodes.push(
        <code key={key++} className="md-code">
          {tok.slice(1, -1)}
        </code>
      )
    } else if (tok.startsWith('**')) {
      nodes.push(<strong key={key++}>{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith('*')) {
      nodes.push(<em key={key++}>{tok.slice(1, -1)}</em>)
    } else if (tok.startsWith('[')) {
      const link = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (link) {
        const href = link[2]
        if (onOpenPath && !/^https?:\/\//i.test(href)) {
          nodes.push(
            <button
              key={key++}
              type="button"
              className="md-path"
              onClick={() => onOpenPath(href)}
            >
              {link[1]}
            </button>
          )
        } else {
          nodes.push(
            <a key={key++} href={href} target="_blank" rel="noreferrer">
              {link[1]}
            </a>
          )
        }
      }
    } else if (onOpenPath) {
      nodes.push(
        <button key={key++} type="button" className="md-path" onClick={() => onOpenPath(tok)}>
          {tok}
        </button>
      )
    } else {
      nodes.push(tok)
    }
    last = m.index + tok.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export const MarkdownMessage = memo(function MarkdownMessage({ content, onOpenPath, plain }: Props) {
  if (plain) {
    return (
      <div className="md-body md-plain">
        <pre className="md-plain-pre">{content}</pre>
      </div>
    )
  }
  const blocks = content.split(/(```[\s\S]*?```)/g)
  return (
    <div className="md-body">
      {blocks.map((block, i) => {
        if (block.startsWith('```')) {
          const inner = block.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')
          const lang = block.match(/^```(\w+)/)?.[1] || ''
          return (
            <div key={i} className="md-fence">
              <div className="md-fence-bar">
                <span>{lang || 'code'}</span>
                <button
                  type="button"
                  className="btn btn-ghost md-copy"
                  onClick={() => void navigator.clipboard.writeText(inner)}
                >
                  Copy
                </button>
              </div>
              <pre>
                <code>{inner}</code>
              </pre>
            </div>
          )
        }
        const lines = block.split('\n')
        const out: ReactNode[] = []
        let list: string[] = []
        const flushList = () => {
          if (!list.length) return
          out.push(
            <ul key={`ul-${out.length}`} className="md-list">
              {list.map((item, j) => (
                <li key={j}>{renderInline(item, onOpenPath)}</li>
              ))}
            </ul>
          )
          list = []
        }
        for (const line of lines) {
          if (/^\s*[-*]\s+/.test(line)) {
            list.push(line.replace(/^\s*[-*]\s+/, ''))
            continue
          }
          flushList()
          if (!line.trim()) {
            out.push(<div key={`sp-${out.length}`} className="md-spacer" />)
            continue
          }
          if (/^###\s+/.test(line)) {
            out.push(
              <h4 key={`h-${out.length}`}>{renderInline(line.replace(/^###\s+/, ''), onOpenPath)}</h4>
            )
          } else if (/^##\s+/.test(line)) {
            out.push(
              <h3 key={`h-${out.length}`}>{renderInline(line.replace(/^##\s+/, ''), onOpenPath)}</h3>
            )
          } else if (/^#\s+/.test(line)) {
            out.push(
              <h3 key={`h-${out.length}`}>{renderInline(line.replace(/^#\s+/, ''), onOpenPath)}</h3>
            )
          } else {
            out.push(
              <p key={`p-${out.length}`} className="md-p">
                {renderInline(line, onOpenPath)}
              </p>
            )
          }
        }
        flushList()
        return <Fragment key={i}>{out}</Fragment>
      })}
    </div>
  )
})
