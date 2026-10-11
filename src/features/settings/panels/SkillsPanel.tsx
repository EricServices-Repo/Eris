import { useMemo, useState } from 'react'
import type { SkillRecord, SkillScope } from '@/shared/settings-schema'

export function useSkillsPanelState(hasWorkspace: boolean) {
  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [skillDraft, setSkillDraft] = useState<{
    name: string
    description: string
    body: string
    scope: SkillScope
  } | null>(null)
  const [skillCreating, setSkillCreating] = useState(false)
  const [skillDirty, setSkillDirty] = useState(false)
  const [skillError, setSkillError] = useState<string | null>(null)
  const [skillSaving, setSkillSaving] = useState(false)

  const beginCreateSkill = (nextScope: SkillScope = hasWorkspace ? 'workspace' : 'user') => {
    setSkillCreating(true)
    setSelectedSkillId(null)
    setSkillDraft({
      name: '',
      description: 'Brief description of what this skill does and when to use it',
      body: '# New skill\n\n## Instructions\n\nTell the agent how to perform this task.\n',
      scope: nextScope
    })
    setSkillDirty(true)
    setSkillError(null)
  }

  const loadSkills = async (preferId?: string | null, preferCreate?: boolean) => {
    try {
      const list = await window.ide.listSkills()
      setSkills(list)
      setSkillError(null)
      if (preferCreate) {
        beginCreateSkill(hasWorkspace ? 'workspace' : 'user')
        return
      }
      const pick =
        (preferId && list.find((s) => s.id === preferId)) ||
        (selectedSkillId && list.find((s) => s.id === selectedSkillId)) ||
        list[0] ||
        null
      if (pick) {
        setSelectedSkillId(pick.id)
        setSkillCreating(false)
        setSkillDraft({
          name: pick.name,
          description: pick.description,
          body: pick.body,
          scope: pick.scope
        })
        setSkillDirty(false)
      } else {
        setSelectedSkillId(null)
        setSkillDraft(null)
        setSkillCreating(false)
        setSkillDirty(false)
      }
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : 'Failed to load skills')
    }
  }

  const selectedSkill = useMemo(
    () => skills.find((s) => s.id === selectedSkillId) ?? null,
    [skills, selectedSkillId]
  )

  const saveSkill = async () => {
    if (!skillDraft) return
    const name = skillDraft.name.trim()
    if (!name) {
      setSkillError('Name is required')
      return
    }
    if (skillDraft.scope === 'workspace' && !hasWorkspace) {
      setSkillError('Open a workspace to save a project skill')
      return
    }
    setSkillSaving(true)
    setSkillError(null)
    try {
      if (skillCreating) {
        const created = await window.ide.createSkill({
          name,
          description: skillDraft.description,
          body: skillDraft.body,
          scope: skillDraft.scope
        })
        setSkillCreating(false)
        setSelectedSkillId(created.id)
        await loadSkills(created.id)
      } else if (selectedSkill) {
        const updated = await window.ide.updateSkill(selectedSkill.id, selectedSkill.scope, {
          name,
          description: skillDraft.description,
          body: skillDraft.body
        })
        setSelectedSkillId(updated.id)
        await loadSkills(updated.id)
      }
      setSkillDirty(false)
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : 'Failed to save skill')
    } finally {
      setSkillSaving(false)
    }
  }

  const removeSkill = async () => {
    if (!selectedSkill || skillCreating) return
    const ok = window.confirm(`Delete skill “${selectedSkill.name}”? This cannot be undone.`)
    if (!ok) return
    try {
      await window.ide.deleteSkill(selectedSkill.id, selectedSkill.scope)
      setSelectedSkillId(null)
      setSkillDraft(null)
      await loadSkills(null)
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : 'Failed to delete skill')
    }
  }

  return {
    skills,
    selectedSkillId,
    setSelectedSkillId,
    skillDraft,
    setSkillDraft,
    skillCreating,
    setSkillCreating,
    skillDirty,
    setSkillDirty,
    skillError,
    setSkillError,
    skillSaving,
    selectedSkill,
    beginCreateSkill,
    loadSkills,
    saveSkill,
    removeSkill
  }
}

export type SkillsPanelState = ReturnType<typeof useSkillsPanelState>

export function SkillsPanel({
  state,
  hasWorkspace
}: {
  state: SkillsPanelState
  hasWorkspace: boolean
}) {
  const {
    skills,
    selectedSkillId,
    setSelectedSkillId,
    skillDraft,
    setSkillDraft,
    skillCreating,
    setSkillCreating,
    skillDirty,
    setSkillDirty,
    skillError,
    setSkillError,
    skillSaving,
    selectedSkill,
    beginCreateSkill,
    saveSkill,
    removeSkill
  } = state
  return (
    <div className="skills-panel">
      <p className="subtitle" style={{ marginTop: 0 }}>
        User skills (default from chat):{' '}
        <code>~/Library/Application Support/Eris/skills</code> — outside every project.
        Project skills: <code>.eris/skills/*/SKILL.md</code>. In chat, say “create a skill…”
        or type <code>/create-skill</code>; the agent uses <code>write_skill</code> (no npm
        install).
      </p>
      <div className="skills-layout">
        <div className="skills-list">
          <div className="skills-list-header">
            <span className="explorer-section-label" style={{ margin: 0 }}>
              Skills
            </span>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => beginCreateSkill('user')}
            >
              New skill
            </button>
          </div>
          {skills.length === 0 && !skillCreating && (
            <div className="subtitle" style={{ padding: '8px 0' }}>
              No skills yet. Create one to guide the agent.
            </div>
          )}
          {skillCreating && (
            <button className="skill-list-item active" type="button">
              <strong>New skill</strong>
              <span className="badge">draft</span>
            </button>
          )}
          {skills.map((skill) => (
            <button
              key={`${skill.scope}:${skill.id}`}
              type="button"
              className={`skill-list-item ${
                !skillCreating && selectedSkillId === skill.id ? 'active' : ''
              }`}
              onClick={() => {
                if (skillDirty && !window.confirm('Discard unsaved skill changes?')) return
                setSkillCreating(false)
                setSelectedSkillId(skill.id)
                setSkillDraft({
                  name: skill.name,
                  description: skill.description,
                  body: skill.body,
                  scope: skill.scope
                })
                setSkillDirty(false)
                setSkillError(null)
              }}
            >
              <span className="skill-list-main">
                <strong>{skill.name}</strong>
                <span className="hint">{skill.description || skill.id}</span>
              </span>
              <span className="badge">{skill.scope}</span>
            </button>
          ))}
        </div>
        <div className="skills-editor">
          {!skillDraft ? (
            <div className="subtitle">Select a skill or create a new one.</div>
          ) : (
            <>
              <div className="skills-editor-toolbar">
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={!skillDirty || skillSaving}
                  onClick={() => void saveSkill()}
                >
                  {skillSaving ? 'Saving…' : skillCreating ? 'Create skill' : 'Save'}
                </button>
                {!skillCreating && selectedSkill && (
                  <button className="btn" type="button" onClick={() => void removeSkill()}>
                    Delete
                  </button>
                )}
                {skillDirty && <span className="badge">unsaved</span>}
              </div>
              {skillError && (
                <div style={{ color: 'var(--danger)', marginBottom: 8 }}>{skillError}</div>
              )}
              {skillCreating && (
                <div className="setting-row" style={{ border: 'none', padding: '4px 0' }}>
                  <div>
                    <label>Scope</label>
                    <div className="hint">
                      User skills apply everywhere. Workspace skills live in the project.
                    </div>
                  </div>
                  <select
                    value={skillDraft.scope}
                    onChange={(e) => {
                      const next = e.target.value as SkillScope
                      if (next === 'workspace' && !hasWorkspace) return
                      setSkillDraft({ ...skillDraft, scope: next })
                      setSkillDirty(true)
                    }}
                  >
                    <option value="user">User</option>
                    <option value="workspace" disabled={!hasWorkspace}>
                      Workspace
                    </option>
                  </select>
                </div>
              )}
              {!skillCreating && selectedSkill && (
                <div className="subtitle" style={{ marginBottom: 8 }}>
                  <code>{selectedSkill.path}</code>
                </div>
              )}
              <div className="form-stack">
                <label>Name</label>
                <input
                  value={skillDraft.name}
                  placeholder="my-skill"
                  onChange={(e) => {
                    setSkillDraft({ ...skillDraft, name: e.target.value })
                    setSkillDirty(true)
                  }}
                />
                <label>Description</label>
                <textarea
                  rows={2}
                  value={skillDraft.description}
                  placeholder="When should the agent use this skill?"
                  onChange={(e) => {
                    setSkillDraft({ ...skillDraft, description: e.target.value })
                    setSkillDirty(true)
                  }}
                />
                <label>Instructions (SKILL.md body)</label>
                <textarea
                  className="skill-body-editor"
                  rows={14}
                  value={skillDraft.body}
                  onChange={(e) => {
                    setSkillDraft({ ...skillDraft, body: e.target.value })
                    setSkillDirty(true)
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
