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
  return (
    <SettingsPage>
      <SettingsSection
        title="Updates"
        description="Checks the public EricServices-Repo/Eris-updates feed. No GitHub token needed. Unsigned Mac builds can’t install in place — use Open releases."
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
