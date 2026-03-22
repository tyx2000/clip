import PropTypes from 'prop-types'
import { useMemo, useState } from 'react'
import useSettingsStore from '../store/settingsStore'
import useThemeStore, { themeOptions } from '../store/themeStore'

const tabIds = ['general', 'account', 'notifications', 'privacy', 'advanced']

function SettingItem({ label, description, children }) {
  return (
    <div className="setting-item">
      <div>
        <p className="setting-label">{label}</p>
        <p className="setting-desc">{description}</p>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

SettingItem.propTypes = {
  label: PropTypes.string.isRequired,
  description: PropTypes.string.isRequired,
  children: PropTypes.node.isRequired
}

function SettingsModal({
  open,
  onClose,
  authUser,
  authLoading,
  onRequestLogin,
  onRequestLogout,
  onRequestRelaunch,
  asWindow
}) {
  const [activeTab, setActiveTab] = useState('general')

  const settings = useSettingsStore((state) => state.settings)
  const updateSetting = useSettingsStore((state) => state.updateSetting)
  const resetSettings = useSettingsStore((state) => state.resetSettings)
  const restartRequired = useSettingsStore((state) => state.restartRequired)
  const systemMessage = useSettingsStore((state) => state.systemMessage)
  const clearSystemMessage = useSettingsStore((state) => state.clearSystemMessage)
  const updateStatus = useSettingsStore((state) => state.updateStatus)
  const checkForUpdates = useSettingsStore((state) => state.checkForUpdates)
  const downloadUpdate = useSettingsStore((state) => state.downloadUpdate)
  const installUpdate = useSettingsStore((state) => state.installUpdate)

  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)

  const locale = settings.general.language
  const dict = useMemo(() => {
    return (
      {
        'en-US': {
          tabs: {
            general: 'General',
            account: 'Account',
            notifications: 'Notifications',
            privacy: 'Privacy',
            advanced: 'Advanced'
          },
          title: 'Settings',
          close: 'Close',
          closeWindow: 'Close Window',
          reset: 'Reset Local Settings',
          dismiss: 'Dismiss',
          restart: 'Restart App'
        },
        'zh-CN': {
          tabs: {
            general: '通用设置',
            account: '账号设置',
            notifications: '通知设置',
            privacy: '隐私设置',
            advanced: '高级设置'
          },
          title: '设置',
          close: '关闭',
          closeWindow: '关闭窗口',
          reset: '重置本地设置',
          dismiss: '知道了',
          restart: '重启应用'
        },
        'ja-JP': {
          tabs: {
            general: '一般設定',
            account: 'アカウント設定',
            notifications: '通知設定',
            privacy: 'プライバシー設定',
            advanced: '詳細設定'
          },
          title: '設定',
          close: '閉じる',
          closeWindow: 'ウィンドウを閉じる',
          reset: 'ローカル設定をリセット',
          dismiss: '了解',
          restart: 'アプリを再起動'
        }
      }[locale] || {
        tabs: {
          general: 'General',
          account: 'Account',
          notifications: 'Notifications',
          privacy: 'Privacy',
          advanced: 'Advanced'
        },
        title: 'Settings',
        close: 'Close',
        closeWindow: 'Close Window',
        reset: 'Reset Local Settings',
        dismiss: 'Dismiss',
        restart: 'Restart App'
      }
    )
  }, [locale])

  const panelTitle = useMemo(() => {
    return dict.tabs[activeTab] || dict.title
  }, [activeTab, dict])

  if (!open && !asWindow) {
    return null
  }

  const content = (
    <div className="settings-modal" onClick={(event) => event.stopPropagation()}>
      <aside className="settings-tabs">
        <h3>{dict.title}</h3>
        {tabIds.map((tabId) => (
          <button
            key={tabId}
            className={`settings-tab-btn${activeTab === tabId ? ' active' : ''}`}
            onClick={() => setActiveTab(tabId)}
          >
            {dict.tabs[tabId]}
          </button>
        ))}
        <button className="settings-reset" onClick={resetSettings}>
          {dict.reset}
        </button>
      </aside>

      <section className="settings-content">
        <div className="settings-head">
          <h2>{panelTitle}</h2>
          {asWindow ? null : (
            <button className="settings-close" onClick={onClose}>
              {dict.close}
            </button>
          )}
        </div>

        {systemMessage ? (
          <div className="settings-notice">
            <p>{systemMessage}</p>
            <div className="settings-notice-actions">
              {restartRequired ? (
                <button className="pixel-btn" onClick={onRequestRelaunch}>
                  {dict.restart}
                </button>
              ) : null}
              <button className="settings-close" onClick={clearSystemMessage}>
                {dict.dismiss}
              </button>
            </div>
          </div>
        ) : null}

        {activeTab === 'general' ? (
          <div className="settings-list">
            <SettingItem label="Theme" description="Switch the app theme.">
              <select value={theme} onChange={(event) => setTheme(event.target.value)}>
                {themeOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </SettingItem>

            <SettingItem label="Language" description="Set the UI display language.">
              <select
                value={settings.general.language}
                onChange={(event) => updateSetting('general', 'language', event.target.value)}
              >
                <option value="zh-CN">Chinese (Simplified)</option>
                <option value="en-US">English</option>
                <option value="ja-JP">Japanese</option>
              </select>
            </SettingItem>

            <SettingItem label="Launch on startup" description="Start app when system starts.">
              <input
                type="checkbox"
                checked={settings.general.launchOnStartup}
                onChange={(event) =>
                  updateSetting('general', 'launchOnStartup', event.target.checked)
                }
              />
            </SettingItem>

            <SettingItem label="Auto update" description="Automatically check for updates.">
              <input
                type="checkbox"
                checked={settings.general.autoUpdate}
                onChange={(event) => updateSetting('general', 'autoUpdate', event.target.checked)}
              />
            </SettingItem>

            <SettingItem label="App update" description="Check and install updates.">
              <div className="update-meta">
                <span className="pill">status: {updateStatus.status || 'idle'}</span>
                <span className="pill">current: {updateStatus.currentVersion || '-'}</span>
                <span className="pill">latest: {updateStatus.availableVersion || '-'}</span>
                <span className="pill">
                  progress: {Math.round(updateStatus.progressPercent || 0)}%
                </span>
                <span className="pill">checked: {updateStatus.lastCheckedAtLabel || 'never'}</span>
                {updateStatus.errorCode ? (
                  <span className="pill">error: {updateStatus.errorCode}</span>
                ) : null}
                <span className="pill">
                  bytes: {Math.round((updateStatus.downloadedBytes || 0) / 1024)}KB /{' '}
                  {Math.round((updateStatus.totalBytes || 0) / 1024)}KB
                </span>
                <span className="pill">
                  speed: {Math.round((updateStatus.bytesPerSecond || 0) / 1024)}KB/s
                </span>
              </div>
              {updateStatus.errorDetail ? (
                <p className="update-error-detail">{updateStatus.errorDetail}</p>
              ) : null}
              <div className="update-actions">
                <button className="pixel-btn" onClick={checkForUpdates}>
                  Check
                </button>
                <button
                  className="pixel-btn"
                  onClick={downloadUpdate}
                  disabled={!updateStatus.canDownload}
                >
                  Download
                </button>
                <button
                  className="pixel-btn"
                  onClick={installUpdate}
                  disabled={!updateStatus.canInstall}
                >
                  Install
                </button>
              </div>
            </SettingItem>

            <SettingItem label="Compact sidebar" description="Reduce sidebar spacing.">
              <input
                type="checkbox"
                checked={settings.general.compactSidebar}
                onChange={(event) =>
                  updateSetting('general', 'compactSidebar', event.target.checked)
                }
              />
            </SettingItem>
          </div>
        ) : null}

        {activeTab === 'account' ? (
          <div className="settings-list">
            <SettingItem
              label="Account status"
              description={authUser?.name ? 'Signed in with Google.' : 'Not signed in.'}
            >
              {authUser?.name ? (
                <span className="pill success">{authUser.name}</span>
              ) : (
                <span className="pill">Guest</span>
              )}
            </SettingItem>

            <SettingItem label="Google account" description="Manage sign-in state.">
              {authUser?.name ? (
                <button className="pixel-btn" onClick={onRequestLogout}>
                  Sign out
                </button>
              ) : (
                <button className="pixel-btn" onClick={onRequestLogin} disabled={authLoading}>
                  {authLoading ? 'Signing in...' : 'Sign in with Google'}
                </button>
              )}
            </SettingItem>

            <SettingItem label="Display name" description="Shown in profile and UI.">
              <input
                value={settings.account.displayName}
                onChange={(event) => updateSetting('account', 'displayName', event.target.value)}
              />
            </SettingItem>

            <SettingItem label="Status text" description="Short profile message.">
              <input
                value={settings.account.statusText}
                onChange={(event) => updateSetting('account', 'statusText', event.target.value)}
              />
            </SettingItem>

            <SettingItem label="Sync profile" description="Sync profile preference locally.">
              <input
                type="checkbox"
                checked={settings.account.syncProfile}
                onChange={(event) => updateSetting('account', 'syncProfile', event.target.checked)}
              />
            </SettingItem>
          </div>
        ) : null}

        {activeTab === 'notifications' ? (
          <div className="settings-list">
            <SettingItem label="Desktop notifications" description="Enable system notifications.">
              <input
                type="checkbox"
                checked={settings.notifications.desktopNotice}
                onChange={(event) =>
                  updateSetting('notifications', 'desktopNotice', event.target.checked)
                }
              />
            </SettingItem>

            <SettingItem label="Sound alerts" description="Play sound for notifications.">
              <input
                type="checkbox"
                checked={settings.notifications.soundNotice}
                onChange={(event) =>
                  updateSetting('notifications', 'soundNotice', event.target.checked)
                }
              />
            </SettingItem>

            <SettingItem label="Digest frequency" description="Notification summary frequency.">
              <select
                value={settings.notifications.digestFrequency}
                onChange={(event) =>
                  updateSetting('notifications', 'digestFrequency', event.target.value)
                }
              >
                <option value="realtime">Realtime</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </SettingItem>
          </div>
        ) : null}

        {activeTab === 'privacy' ? (
          <div className="settings-list">
            <SettingItem label="Usage analytics" description="Share anonymous usage analytics.">
              <input
                type="checkbox"
                checked={settings.privacy.analyticsEnabled}
                onChange={(event) =>
                  updateSetting('privacy', 'analyticsEnabled', event.target.checked)
                }
              />
            </SettingItem>

            <SettingItem
              label="Crash reports"
              description="Upload crash diagnostics automatically."
            >
              <input
                type="checkbox"
                checked={settings.privacy.crashReportEnabled}
                onChange={(event) =>
                  updateSetting('privacy', 'crashReportEnabled', event.target.checked)
                }
              />
            </SettingItem>

            <SettingItem
              label="Personalized suggestions"
              description="Use behavior for recommendations."
            >
              <input
                type="checkbox"
                checked={settings.privacy.personalizedAds}
                onChange={(event) =>
                  updateSetting('privacy', 'personalizedAds', event.target.checked)
                }
              />
            </SettingItem>
          </div>
        ) : null}

        {activeTab === 'advanced' ? (
          <div className="settings-list">
            <SettingItem
              label="Open DevTools by default"
              description="Open DevTools when creating a new app window."
            >
              <input
                type="checkbox"
                checked={settings.advanced.defaultOpenDevtools}
                onChange={(event) =>
                  updateSetting('advanced', 'defaultOpenDevtools', event.target.checked)
                }
              />
            </SettingItem>

            <SettingItem
              label="Hardware acceleration"
              description="Enable GPU acceleration for rendering."
            >
              <input
                type="checkbox"
                checked={settings.advanced.hardwareAcceleration}
                onChange={(event) =>
                  updateSetting('advanced', 'hardwareAcceleration', event.target.checked)
                }
              />
            </SettingItem>

            <SettingItem label="Cache limit (MB)" description="Limit local cache size.">
              <input
                type="number"
                min="128"
                max="4096"
                step="64"
                value={settings.advanced.cacheSizeMb}
                onChange={(event) =>
                  updateSetting('advanced', 'cacheSizeMb', Number(event.target.value || 0))
                }
              />
            </SettingItem>

            <SettingItem
              label="Animation level"
              description="Control UI transition animation intensity."
            >
              <select
                value={settings.advanced.animationLevel}
                onChange={(event) =>
                  updateSetting('advanced', 'animationLevel', event.target.value)
                }
              >
                <option value="full">Full</option>
                <option value="reduced">Reduced</option>
                <option value="off">Off</option>
              </select>
            </SettingItem>
          </div>
        ) : null}
      </section>
    </div>
  )

  if (asWindow) {
    return <div className="settings-window-shell">{content}</div>
  }

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      {content}
    </div>
  )
}

SettingsModal.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func,
  authUser: PropTypes.shape({
    name: PropTypes.string,
    email: PropTypes.string
  }),
  authLoading: PropTypes.bool.isRequired,
  onRequestLogin: PropTypes.func.isRequired,
  onRequestLogout: PropTypes.func.isRequired,
  onRequestRelaunch: PropTypes.func.isRequired,
  asWindow: PropTypes.bool
}

SettingsModal.defaultProps = {
  open: true,
  onClose: () => {},
  authUser: null,
  asWindow: false
}

export default SettingsModal
