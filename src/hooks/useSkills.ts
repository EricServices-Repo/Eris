import { useCallback, useState } from 'react'
import type { SkillRecord } from '@/shared/settings-schema'
import type { ActiveSkillRef } from '@/features/chat/ChatPanel'

export function useSkills() {
  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [activeSkills, setActiveSkills] = useState<ActiveSkillRef[]>([])

  const refreshSkills = useCallback(async () => {
    try {
      const list = await window.ide.listSkills()
      setSkills(list)
    } catch {
      setSkills([])
    }
  }, [])

  return { skills, refreshSkills, activeSkills, setActiveSkills }
}
