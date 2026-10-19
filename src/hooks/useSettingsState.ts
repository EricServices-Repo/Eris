import { useCallback, useRef, useState } from 'react'
import type { AppSettings } from '@/shared/settings-schema'

export type SettingsCategory =
  | 'general'
  | 'gpu'
  | 'composer'
  | 'textModels'
  | 'imageModels'
  /** @deprecated Use textModels. */
  | 'localModels'
  | 'providers'
  /** @deprecated Use composer. */
  | 'models'
  | 'usage'
  | 'account'
  | 'agent'
  | 'subagents'
  | 'skills'
  | 'rules'
  | 'context'
  | 'mcp'
  | 'github'
  | 'feedback'
  | 'logging'
  | 'editor'
  | 'workspace'
  | undefined

function normalizeCategory(category?: SettingsCategory): SettingsCategory {
  if (category === 'models') return 'composer'
  if (category === 'localModels') return 'textModels'
  return category
}

export function useSettingsState() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const settingsRef = useRef<AppSettings | null>(null)
  settingsRef.current = settings
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>(undefined)
  const [startCreateSkill, setStartCreateSkill] = useState(false)

  const refreshSettings = useCallback(async () => {
    const resolved = await window.ide.getResolvedSettings()
    setSettings(resolved)
    return resolved
  }, [])

  const openSettings = useCallback((category?: SettingsCategory, createSkill = false) => {
    setSettingsCategory(normalizeCategory(category))
    setStartCreateSkill(createSkill)
    setSettingsOpen(true)
  }, [])

  return {
    settings,
    setSettings,
    settingsRef,
    refreshSettings,
    settingsOpen,
    setSettingsOpen,
    settingsCategory,
    setSettingsCategory,
    startCreateSkill,
    setStartCreateSkill,
    openSettings
  }
}
