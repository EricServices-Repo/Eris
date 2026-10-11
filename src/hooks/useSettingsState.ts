import { useCallback, useRef, useState } from 'react'
import type { AppSettings } from '@/shared/settings-schema'

export type SettingsCategory =
  | 'general'
  | 'models'
  | 'usage'
  | 'agent'
  | 'subagents'
  | 'skills'
  | 'rules'
  | 'context'
  | 'mcp'
  | 'github'
  | 'editor'
  | 'workspace'
  | undefined

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

  const openSettings = useCallback(
    (category?: SettingsCategory, createSkill = false) => {
      setSettingsCategory(category)
      setStartCreateSkill(createSkill)
      setSettingsOpen(true)
    },
    []
  )

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
