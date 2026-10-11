import { useCallback, useEffect, useState } from 'react'

export type Breakpoint = { id: string; path: string; line: number; enabled: boolean }

export function useBreakpoints(workspacePath: string | null) {
  const [breakpoints, setBreakpoints] = useState<Breakpoint[]>([])

  const refreshBreakpoints = useCallback(async () => {
    if (!workspacePath) {
      setBreakpoints([])
      return
    }
    setBreakpoints(await window.ide.debugListBreakpoints())
  }, [workspacePath])

  useEffect(() => {
    void refreshBreakpoints()
  }, [refreshBreakpoints])

  return { breakpoints, setBreakpoints }
}
