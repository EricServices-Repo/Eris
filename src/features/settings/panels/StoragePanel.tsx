import { useEffect, useState } from 'react'
import { SettingsSection } from '../SettingsSection'
import type { StorageInventory } from '@/shared/storage'
export function StoragePanel() {
  const [root, setRoot] = useState<string | null>(null),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [inventory, setInventory] = useState<StorageInventory | null>(null),
    [automatic, setAutomatic] = useState(false)
  useEffect(() => {
    let cancelled = false
    void window.ide
      .getCurrentWorkspace()
      .then(async (value) => {
        const state = await window.ide.storagePolicy(value)
        if (!cancelled) {
          setRoot(value)
          setReady(true)
          setAutomatic(state.enabled)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [])
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
      setInventory(await window.ide.storageInspect(root))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsSection
      title="Private evidence storage"
      description="Tasks, ledgers, checkpoints, diagnostics and conversations can contain private source. Cleanup preserves active/unresolved work. Model weights and generated images require explicit removal in their settings."
    >
      <label>
        <input
          type="checkbox"
          disabled={!ready || busy}
          checked={automatic}
          onChange={(e) =>
            void run(async () =>
              setAutomatic((await window.ide.storagePolicy(root, e.target.checked)).enabled)
            )
          }
        />{' '}
        Automatically clean terminal evidence older than 30 days or above 200 records while idle
      </label>
      <div>
        <button className="btn" disabled={!ready || busy} onClick={() => void run(async () => {})}>
          Inspect storage
        </button>{' '}
        <button
          className="btn"
          disabled={!ready || busy}
          onClick={() =>
            void run(async () => {
              const result = await window.ide.storageCleanup(root)
              setNotice(
                `Removed ${result.removed}; retained ${result.retained}${result.truncated ? '; bounded scan incomplete' : ''}`
              )
            })
          }
        >
          Clean terminal evidence
        </button>{' '}
        <button
          className="btn"
          disabled={!ready || busy}
          onClick={() =>
            void run(async () => {
              const path = await window.ide.storageBackup(root)
              if (path) setNotice('Private backup saved: ' + path)
            })
          }
        >
          Back up evidence and chats
        </button>{' '}
        <button
          className="btn"
          disabled={!ready || busy}
          onClick={() =>
            void run(async () => {
              const result = await window.ide.storageRestore(root)
              if (result)
                setNotice(
                  `Restored ${result.restored}; preserved ${result.conflicts.length} existing conflicts`
                )
            })
          }
        >
          Restore without overwriting
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {inventory && (
        <>
          <p>
            {inventory.scanned} entries inspected
            {inventory.truncated ? ' · partial scan; totals are lower bounds' : ''}
            {inventory.busy ? ' · active evidence pinned' : ''}
          </p>
          <ul>
            {inventory.stores.map((store) => (
              <li key={store.id}>
                {store.id}: {store.entries} entries · {store.schema} · {store.retention}
              </li>
            ))}
          </ul>
          {inventory.failures.map((failure, index) => (
            <p role="alert" key={index}>
              Storage needs attention: {failure.path} — {failure.message}. Originals are retained
              when recovery is possible; back up before manual repair.
            </p>
          ))}
        </>
      )}
    </SettingsSection>
  )
}
