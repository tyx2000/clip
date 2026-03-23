import PropTypes from 'prop-types'
import { useMemo, useState } from 'react'
import styled from 'styled-components'
import { PixelButton } from '../styles/primitives'
import useSettingsStore from '../store/settingsStore'
import useThemeStore, { themeOptions } from '../store/themeStore'

const SettingsModalRoot = styled.div`
  width: min(980px, 92vw);
  height: min(640px, 88vh);
  border-radius: 14px;
  background: var(--color-block-content);
  display: grid;
  grid-template-columns: 220px 1fr;
  overflow: hidden;
  border: 1px solid var(--line-soft);
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.1);

  ${({ $asWindow }) =>
    $asWindow
      ? `
    width: 100%;
    height: 100vh;
    max-height: unset;
    border-radius: 0;
    border: 0;
    box-shadow: none;
  `
      : ''}

  @media (max-width: 820px) {
    grid-template-columns: 1fr;
    height: min(720px, 90vh);
  }
`

const SettingsTabs = styled.aside`
  border-right: 1px solid var(--line-soft);
  background: var(--color-block-nav);
  padding: 14px;
  display: grid;
  align-content: start;
  gap: 8px;

  @media (max-width: 820px) {
    border-right: 0;
    border-bottom: 1px solid var(--line-soft);
  }
`

const SettingsTabsTitle = styled.h3`
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 700;
`

const SecondaryButton = styled.button`
  border: none;
  border-radius: 9px;
  background: var(--color-block-nav-item);
  color: var(--color-text);
  padding: 8px 10px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
`

const TabButton = styled(SecondaryButton)`
  background: ${({ $active }) =>
    $active ? 'var(--color-block-nav-item-active)' : 'var(--color-block-nav-item)'};
`

const ResetButton = styled(SecondaryButton)`
  margin-top: 10px;
  color: #8a2c22;
`

const SettingsContent = styled.section`
  padding: 16px;
  overflow: auto;
  border-left: 1px solid var(--line-soft);
`

const SettingsHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
`

const PanelTitle = styled.h2`
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
`

const SettingsList = styled.div`
  display: grid;
  gap: 12px;
`

const SettingsNotice = styled.div`
  background: var(--color-block-card);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--line-soft);
`

const SettingsNoticeText = styled.p`
  margin: 0;
  font-size: 13px;
`

const SettingsNoticeActions = styled.div`
  margin-top: 8px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
`

const SettingItemWrap = styled.div`
  border-radius: 9px;
  padding: 12px;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12px;
  align-items: center;
  background: var(--color-block-card);
  border: 1px solid var(--line-soft);

  @media (max-width: 820px) {
    grid-template-columns: 1fr;
  }
`

const SettingLabel = styled.p`
  margin: 0;
  font-size: 15px;
  font-weight: 700;
`

const SettingDesc = styled.p`
  margin: 4px 0 0;
  color: var(--color-text-soft);
  font-size: 13px;
`

const SettingControl = styled.div`
  min-width: 180px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;

  @media (max-width: 820px) {
    justify-content: flex-start;
  }

  input,
  select,
  button {
    border: 1px solid var(--line-soft);
    border-radius: 7px;
    padding: 6px 9px;
    background: var(--color-block-input);
    color: var(--color-text);
  }
`

const UpdateMeta = styled.div`
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
`

const UpdateActions = styled.div`
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
`

const UpdateErrorDetail = styled.p`
  margin: 8px 0 0;
  max-width: 420px;
  font-size: 12px;
  line-height: 1.4;
  color: #7f3d3d;
  text-align: right;
`

const Pill = styled.span`
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  background: ${({ $success }) => ($success ? '#d8f2bc' : 'var(--color-block-chip)')};
  color: ${({ $success }) => ($success ? '#23441e' : 'inherit')};
`

const SettingsWindowShell = styled.div``

const SettingsOverlay = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(10, 10, 10, 0.28);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
`

const tabIds = ['general', 'account', 'notifications', 'privacy', 'advanced']

function SettingItem({ label, description, children }) {
  return (
    <SettingItemWrap>
      <div>
        <SettingLabel>{label}</SettingLabel>
        <SettingDesc>{description}</SettingDesc>
      </div>
      <SettingControl>{children}</SettingControl>
    </SettingItemWrap>
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
    <SettingsModalRoot $asWindow={asWindow} onClick={(event) => event.stopPropagation()}>
      <SettingsTabs>
        <SettingsTabsTitle>{dict.title}</SettingsTabsTitle>
        {tabIds.map((tabId) => (
          <TabButton key={tabId} $active={activeTab === tabId} onClick={() => setActiveTab(tabId)}>
            {dict.tabs[tabId]}
          </TabButton>
        ))}
        <ResetButton onClick={resetSettings}>{dict.reset}</ResetButton>
      </SettingsTabs>

      <SettingsContent>
        <SettingsHead>
          <PanelTitle>{panelTitle}</PanelTitle>
          {asWindow ? null : <SecondaryButton onClick={onClose}>{dict.close}</SecondaryButton>}
        </SettingsHead>

        {systemMessage ? (
          <SettingsNotice>
            <SettingsNoticeText>{systemMessage}</SettingsNoticeText>
            <SettingsNoticeActions>
              {restartRequired ? (
                <PixelButton onClick={onRequestRelaunch}>{dict.restart}</PixelButton>
              ) : null}
              <SecondaryButton onClick={clearSystemMessage}>{dict.dismiss}</SecondaryButton>
            </SettingsNoticeActions>
          </SettingsNotice>
        ) : null}

        {activeTab === 'general' ? (
          <SettingsList>
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
              <div>
                <UpdateMeta>
                  <Pill>status: {updateStatus.status || 'idle'}</Pill>
                  <Pill>current: {updateStatus.currentVersion || '-'}</Pill>
                  <Pill>latest: {updateStatus.availableVersion || '-'}</Pill>
                  <Pill>progress: {Math.round(updateStatus.progressPercent || 0)}%</Pill>
                  <Pill>checked: {updateStatus.lastCheckedAtLabel || 'never'}</Pill>
                  {updateStatus.errorCode ? <Pill>error: {updateStatus.errorCode}</Pill> : null}
                  <Pill>
                    bytes: {Math.round((updateStatus.downloadedBytes || 0) / 1024)}KB /{' '}
                    {Math.round((updateStatus.totalBytes || 0) / 1024)}KB
                  </Pill>
                  <Pill>speed: {Math.round((updateStatus.bytesPerSecond || 0) / 1024)}KB/s</Pill>
                </UpdateMeta>
                {updateStatus.errorDetail ? (
                  <UpdateErrorDetail>{updateStatus.errorDetail}</UpdateErrorDetail>
                ) : null}
                <UpdateActions>
                  <PixelButton onClick={checkForUpdates}>Check</PixelButton>
                  <PixelButton onClick={downloadUpdate} disabled={!updateStatus.canDownload}>
                    Download
                  </PixelButton>
                  <PixelButton onClick={installUpdate} disabled={!updateStatus.canInstall}>
                    Install
                  </PixelButton>
                </UpdateActions>
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
          </SettingsList>
        ) : null}

        {activeTab === 'account' ? (
          <SettingsList>
            <SettingItem
              label="Account status"
              description={authUser?.name ? 'Signed in with Google.' : 'Not signed in.'}
            >
              {authUser?.name ? <Pill $success>{authUser.name}</Pill> : <Pill>Guest</Pill>}
            </SettingItem>

            <SettingItem label="Google account" description="Manage sign-in state.">
              {authUser?.name ? (
                <PixelButton onClick={onRequestLogout}>Sign out</PixelButton>
              ) : (
                <PixelButton onClick={onRequestLogin} disabled={authLoading}>
                  {authLoading ? 'Signing in...' : 'Sign in with Google'}
                </PixelButton>
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
          </SettingsList>
        ) : null}

        {activeTab === 'notifications' ? (
          <SettingsList>
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
          </SettingsList>
        ) : null}

        {activeTab === 'privacy' ? (
          <SettingsList>
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
          </SettingsList>
        ) : null}

        {activeTab === 'advanced' ? (
          <SettingsList>
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
          </SettingsList>
        ) : null}
      </SettingsContent>
    </SettingsModalRoot>
  )

  if (asWindow) {
    return <SettingsWindowShell>{content}</SettingsWindowShell>
  }

  return <SettingsOverlay onClick={onClose}>{content}</SettingsOverlay>
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
