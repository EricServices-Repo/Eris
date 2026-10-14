export type OllamaLibraryEntry = {
  name: string
  label: string
  size: string
  description: string
  family: string
}

export type OllamaPullProgress = {
  name: string
  status: string
  completed?: number
  total?: number
  percent?: number
  done: boolean
  error?: string
}
