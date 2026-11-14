import type { ModelConnection, ReasoningLevel } from '@/shared/settings-schema'

type Reasoning = NonNullable<ModelConnection['reasoning']>

const LEVELS: Array<{ value: ReasoningLevel; label: string }> = [
  { value: 'default', label: 'Model default' },
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

/** Per-connection reasoning controls (#573). */
export function ReasoningFields({
  value,
  onChange
}: {
  value: ModelConnection['reasoning']
  onChange: (next: Reasoning) => void
}) {
  const current: Reasoning = { level: value?.level ?? 'default', show: value?.show ?? true }
  return (
    <>
      <label className="field">
        <span>Reasoning</span>
        <select
          value={current.level}
          onChange={(event) =>
            onChange({ ...current, level: event.target.value as ReasoningLevel })
          }
        >
          {LEVELS.map((level) => (
            <option key={level.value} value={level.value}>
              {level.label}
            </option>
          ))}
        </select>
      </label>
      <label className="providers-enable-row">
        <input
          type="checkbox"
          checked={current.show}
          onChange={(event) => onChange({ ...current, show: event.target.checked })}
        />
        <span>Show model reasoning under Thinking</span>
      </label>
    </>
  )
}
