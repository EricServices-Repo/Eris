export type LanguageEditInput = {
  path: string
  text: string
  kind: 'formatting' | 'rename' | 'codeActions'
  params: Record<string, unknown>
}
export type LanguageEditPreview = {
  id?: string
  title: string
  path?: string
  before?: string
  after?: string
  reason?: string
}
