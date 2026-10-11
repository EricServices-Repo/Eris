import { useState } from 'react'

export function useRulesPanelState(hasWorkspace: boolean) {
  const [rules, setRules] = useState<Array<{ id: string; name: string; body: string }>>([])
  const [ruleDraft, setRuleDraft] = useState<{
    id?: string
    name: string
    body: string
  } | null>(null)
  const [ruleError, setRuleError] = useState<string | null>(null)
  const [ruleSaving, setRuleSaving] = useState(false)

  const loadRules = async () => {
    if (!hasWorkspace) {
      setRules([])
      return
    }
    try {
      setRules(await window.ide.listRules())
    } catch {
      setRules([])
    }
  }

  return {
    rules,
    ruleDraft,
    setRuleDraft,
    ruleError,
    setRuleError,
    ruleSaving,
    setRuleSaving,
    loadRules
  }
}

export type RulesPanelState = ReturnType<typeof useRulesPanelState>

export function RulesPanel({
  state,
  hasWorkspace
}: {
  state: RulesPanelState
  hasWorkspace: boolean
}) {
  const {
    rules,
    ruleDraft,
    setRuleDraft,
    ruleError,
    setRuleError,
    ruleSaving,
    setRuleSaving,
    loadRules
  } = state
  return (
    <div className="skills-panel">
      <p className="subtitle" style={{ marginTop: 0 }}>
        Workspace rules live in <code>.eris/rules/*.md</code> and are injected into every agent
        chat. {!hasWorkspace && 'Open a workspace to edit rules.'}
      </p>
      {!hasWorkspace ? (
        <div className="subtitle">No workspace open.</div>
      ) : (
        <div className="skills-layout">
          <div className="skills-list">
            <div className="skills-list-header">
              <span className="explorer-section-label" style={{ margin: 0 }}>
                Rules
              </span>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => {
                  setRuleDraft({ name: 'project', body: '# Project rules\n\n- \n' })
                  setRuleError(null)
                }}
              >
                New rule
              </button>
            </div>
            {rules.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`skill-list-item ${ruleDraft?.id === r.id ? 'active' : ''}`}
                onClick={() => {
                  setRuleDraft({ id: r.id, name: r.name, body: r.body })
                  setRuleError(null)
                }}
              >
                <strong>{r.name}</strong>
                <span className="badge">.md</span>
              </button>
            ))}
          </div>
          <div className="skills-editor">
            {ruleDraft ? (
              <>
                <label className="field">
                  <span>Name</span>
                  <input
                    value={ruleDraft.name}
                    onChange={(e) =>
                      setRuleDraft({ ...ruleDraft, name: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>Body</span>
                  <textarea
                    rows={16}
                    value={ruleDraft.body}
                    onChange={(e) =>
                      setRuleDraft({ ...ruleDraft, body: e.target.value })
                    }
                    spellCheck={false}
                  />
                </label>
                {ruleError && <div className="subtitle" style={{ color: 'var(--danger)' }}>{ruleError}</div>}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={ruleSaving}
                    onClick={() => {
                      void (async () => {
                        setRuleSaving(true)
                        setRuleError(null)
                        try {
                          const saved = await window.ide.saveRule(
                            ruleDraft.name,
                            ruleDraft.body,
                            ruleDraft.id
                          )
                          setRuleDraft({
                            id: saved.id,
                            name: saved.name,
                            body: saved.body
                          })
                          await loadRules()
                        } catch (err) {
                          setRuleError(
                            err instanceof Error ? err.message : 'Save failed'
                          )
                        } finally {
                          setRuleSaving(false)
                        }
                      })()
                    }}
                  >
                    Save
                  </button>
                  {ruleDraft.id && (
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        void (async () => {
                          await window.ide.deleteRule(ruleDraft.id!)
                          setRuleDraft(null)
                          await loadRules()
                        })()
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="subtitle">Select a rule or create a new one.</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
