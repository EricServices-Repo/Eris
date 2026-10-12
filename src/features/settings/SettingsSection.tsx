import type { ReactNode } from 'react'

export function SettingsSection({
  title,
  description,
  actions,
  children,
  className = ''
}: {
  title?: string
  description?: string
  actions?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const hasBody = children != null && children !== false
  return (
    <section className={`settings-section ${className}`.trim()}>
      {(title || description || actions) && (
        <header className={`settings-section-head${hasBody ? '' : ' is-solo'}`.trim()}>
          <div className="settings-section-copy">
            {title ? <h3>{title}</h3> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {actions ? <div className="settings-section-actions">{actions}</div> : null}
        </header>
      )}
      {hasBody ? <div className="settings-section-body">{children}</div> : null}
    </section>
  )
}

export function SettingsPage({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`settings-page ${className}`.trim()}>{children}</div>
}
