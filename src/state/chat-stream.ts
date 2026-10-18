import { createStore } from './store'
import type { ToolActivityItem } from '@/hooks/useChatSession'
import type { SetStateAction } from 'react'

type StreamState = {
  thinkingBuffer: string
  answerBuffer: string
  agentStatus: string | null
  toolActivity: ToolActivityItem[]
}
export const chatStream = createStore<StreamState>({
  thinkingBuffer: '',
  answerBuffer: '',
  agentStatus: null,
  toolActivity: []
})
function setter<K extends keyof StreamState>(key: K) {
  return (next: SetStateAction<StreamState[K]>) =>
    chatStream.set((previous) => {
      const value =
        typeof next === 'function'
          ? (next as (value: StreamState[K]) => StreamState[K])(previous[key])
          : next
      return Object.is(value, previous[key]) ? previous : { ...previous, [key]: value }
    })
}
export const setThinkingBuffer = setter('thinkingBuffer')
export const setAnswerBuffer = setter('answerBuffer')
export const setAgentStatus = setter('agentStatus')
export const setToolActivity = setter('toolActivity')
