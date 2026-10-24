import { useEffect, useState } from 'react'
import type { AppSettings } from '@/shared/settings-schema'
import type { ApplySetting } from '../fields'
import { SettingsPage, SettingsSection } from '../SettingsSection'

export function GeneralPanel({
  resolved,
  apply,
  onClose,
  onRerunSetup
}: {
  resolved: AppSettings
  apply: ApplySetting
  onClose: () => void
  onRerunSetup?: () => void
}) {
  const [credentialPolicy, setCredentialPolicy] = useState<'local' | 'vault'>('local')
  const [credentialNotice, setCredentialNotice] = useState<string | null>(null)
  const [credentialError, setCredentialError] = useState<string | null>(null)
  useEffect(() => {
    void window.ide
      .getCredentialStatus()
      .then((status) => {
        setCredentialPolicy(status.policy)
        setCredentialNotice(
          status.legacyPending
            ? 'Legacy credentials need explicit migration. Choose the OS vault to unlock an encrypted legacy store.'
            : status.plaintextRemaining
              ? 'Legacy plaintext cleanup did not finish. Select the vault again to retry cleanup.'
              : null
        )
      })
      .catch((error) => setCredentialError(String(error)))
  }, [])
  const selectPolicy = async (policy: 'local' | 'vault') => {
    try {
      const status = await window.ide.setCredentialPolicy(policy)
      setCredentialPolicy(status.policy)
      setCredentialError(null)
      setCredentialNotice(
        status.plaintextRemaining ? 'Legacy plaintext cleanup is still pending.' : null
      )
    } catch (error) {
      setCredentialError(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <SettingsPage>
      <SettingsSection
        title="Credential storage"
        description="Choose how provider and account credentials are stored on this computer. Selecting the OS vault may show a system unlock prompt."
      >
        <select
          aria-label="Credential storage"
          value={credentialPolicy}
          onChange={(event) => void selectPolicy(event.target.value as 'local' | 'vault')}
        >
          <option value="local">Local file with account permissions</option>
          <option value="vault">Encrypt with OS credential vault</option>
        </select>
        {credentialNotice && <p role="status">{credentialNotice}</p>}
        {credentialError && <p role="alert">{credentialError}</p>}
      </SettingsSection>
      <SettingsSection
        title="Updates"
        description="Checks GitHub Releases on EricServices-Repo/Eris. No GitHub token needed. Unsigned Mac builds can’t install in place — use Open releases."
      >
        <label className="settings-check">
          <input
            type="checkbox"
            checked={resolved.general.updates?.autoCheck !== false}
            onChange={(e) => void apply(['general', 'updates', 'autoCheck'], e.target.checked)}
          />
          <span>
            <strong>Check for updates automatically</strong>
            <em>Look for a new version after launch</em>
          </span>
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={resolved.general.updates?.autoDownload !== false}
            onChange={(e) => void apply(['general', 'updates', 'autoDownload'], e.target.checked)}
          />
          <span>
            <strong>Download updates in the background</strong>
            <em>Fetch installers when an update is available</em>
          </span>
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={resolved.general.updates?.channel === 'beta'}
            onChange={(e) =>
              void apply(['general', 'updates', 'channel'], e.target.checked ? 'beta' : 'stable')
            }
          />
          <span>
            <strong>Join the beta channel</strong>
            <em>Get prerelease builds early — may be less stable</em>
          </span>
        </label>
        <div className="settings-inline-actions" style={{ marginTop: 4 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void window.ide.checkForAppUpdates(false)}
          >
            Check for updates
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void window.ide.openAppReleasesPage()}
          >
            Open releases
          </button>
        </div>
      </SettingsSection>

      {onRerunSetup && (
        <SettingsSection
          title="Setup wizard"
          description="Re-run the first-time guide to download Composer models and open a workspace."
        >
          <button
            type="button"
            className="btn"
            onClick={() => {
              onClose()
              onRerunSetup()
            }}
          >
            Run setup wizard again
          </button>
        </SettingsSection>
      )}
    </SettingsPage>
  )
}
