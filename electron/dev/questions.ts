/** TXT: one question per line. JSON: strings or {question/text} records. JSONL: one record per line. */
export function parseQuestions(text: string, extension: string): string[] {
  if (Buffer.byteLength(text, 'utf8') > 20 * 1024 * 1024)
    throw new Error('Question files must be 20 MB or smaller.')
  const source = text.replace(/^\uFEFF/, '')
  const records: unknown =
    extension === '.json'
      ? JSON.parse(source)
      : extension === '.jsonl'
        ? source
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line))
        : source.split(/\r?\n/).filter((line) => line.trim())
  if (!Array.isArray(records) || !records.length || records.length > 10000)
    throw new Error('Provide an array or file containing 1–10,000 questions.')
  return records.map((record, index) => {
    const value = typeof record === 'string' ? record : (record?.question ?? record?.text)
    if (typeof value !== 'string' || !value.trim() || value.length > 32000)
      throw new Error(`Question ${index + 1} must be nonempty text of at most 32,000 characters.`)
    return value.trim()
  })
}
