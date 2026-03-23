import { useEffect, useMemo, useState } from 'react'
import { HashRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import styled from 'styled-components'
import SettingsModal from './components/SettingsModal'
import Versions from './components/Versions'
import HomePage from './pages/HomePage'
import LabPage from './pages/LabPage'
import PixelBoardPage from './pages/PixelBoardPage'
import ProfilePage from './pages/ProfilePage'
import QuestLogPage from './pages/QuestLogPage'
import useSettingsStore from './store/settingsStore'
import useSharedStore from './store/sharedStore'
import useThemeStore from './store/themeStore'

const AppShellLayout = styled.div`
  width: 100%;
  height: 100%;
  display: grid;
  grid-template-columns: ${({ $isSettingsWindow }) =>
    $isSettingsWindow ? 'minmax(0, 1fr)' : '250px minmax(0, 1fr)'};
  gap: 16px;
  padding: 16px;
  max-width: ${({ $isSettingsWindow }) => ($isSettingsWindow ? 'none' : '1480px')};
  margin: 0 auto;

  .compact-sidebar & {
    grid-template-columns: ${({ $isSettingsWindow }) =>
      $isSettingsWindow ? 'minmax(0, 1fr)' : '210px minmax(0, 1fr)'};
  }

  @media (max-width: 980px) {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
    padding: 12px;
  }
`

const Sidebar = styled.aside`
  background: var(--color-block-nav);
  border-radius: 14px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-soft);
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.04);

  @media (max-width: 980px) {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
  }
`

const BrandCard = styled.div`
  background: var(--color-block-brand);
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 12px;
  border: 1px solid var(--line-soft);
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.05);
`

const BrandTitle = styled.h1`
  margin: 0;
  font-size: 20px;
  font-weight: 700;
`

const BrandSub = styled.p`
  margin: 6px 0 0;
  color: var(--color-text-soft);
  font-size: 12px;
`

const NavList = styled.nav`
  display: grid;
  gap: 8px;
`

const NavItem = styled(NavLink)`
  border-radius: 10px;
  padding: 9px 12px;
  text-decoration: none;
  color: var(--color-text);
  font-weight: 600;
  background: var(--color-block-nav-item);
  border: 1px solid transparent;
  transition:
    transform 150ms ease,
    background-color 150ms ease,
    border-color 150ms ease,
    color 150ms ease;

  &:hover {
    transform: translateY(-1px);
    border-color: var(--line-soft);
  }

  &[aria-current='page'] {
    background: var(--color-block-nav-item-active);
    border-color: var(--line-soft);
    font-weight: 700;
  }
`

const SidebarBottom = styled.div`
  margin-top: auto;
  display: grid;
  gap: 10px;

  @media (max-width: 980px) {
    margin-top: 0;
  }
`

const SideAction = styled.button`
  width: 100%;
  border: none;
  border-radius: 10px;
  padding: 9px 12px;
  font-weight: 600;
  background: var(--color-block-action);
  color: var(--color-button-text);
  cursor: pointer;

  &:disabled {
    opacity: 0.7;
    cursor: not-allowed;
  }
`

const AuthError = styled.p`
  margin: 0;
  border-radius: 10px;
  background: #ffe6e6;
  color: #8f3e3e;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.4;
`

const ContentArea = styled.main`
  border-radius: 14px;
  background: var(--color-block-content);
  padding: ${({ $isSettingsWindow }) => ($isSettingsWindow ? '0' : '22px')};
  display: grid;
  grid-template-rows: ${({ $isSettingsWindow }) => ($isSettingsWindow ? '1fr' : '1fr auto')};
  overflow: ${({ $isSettingsWindow }) => ($isSettingsWindow ? 'hidden' : 'auto')};
  border: 1px solid var(--line-soft);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.05);

  &:has(section[data-page='home']) {
    overflow: hidden;
  }
`

const VersionsWrap = styled.div`
  margin-top: 14px;
`

const navItems = [
  { to: '/home', key: 'home' },
  { to: '/pixel-board', key: 'pixelBoard' },
  { to: '/quest-log', key: 'questLog' },
  { to: '/lab', key: 'lab' },
  { to: '/profile', key: 'profile' }
]

const ACTIVITY_REPORT_INTERVAL_MS = 60 * 1000

function AppShell() {
  const location = useLocation()
  const hydrate = useSharedStore((state) => state.hydrate)
  const syncFromMain = useSharedStore((state) => state.syncFromMain)
  const theme = useThemeStore((state) => state.theme)
  const hydrateTheme = useThemeStore((state) => state.hydrateFromMain)
  const subscribeTheme = useThemeStore((state) => state.subscribeTheme)

  const settings = useSettingsStore((state) => state.settings)
  const hydrateAppSettings = useSettingsStore((state) => state.hydrateFromMain)
  const hydrateUpdateStatus = useSettingsStore((state) => state.hydrateUpdateStatus)
  const subscribeUpdateStatus = useSettingsStore((state) => state.subscribeUpdateStatus)

  // Legacy modal state preserved per request:
  // const [settingsOpen, setSettingsOpen] = useState(false)
  const [authUser, setAuthUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState('')

  const windowRole = useMemo(() => {
    return new URLSearchParams(window.location.search).get('windowRole') || 'main'
  }, [])

  const locale = settings.general.language
  const text = useMemo(
    () =>
      ({
        'en-US': {
          appTitle: 'Pixel Hub',
          window: 'Window',
          settings: 'Settings',
          nav: {
            home: 'Home',
            pixelBoard: 'Pixel Board',
            questLog: 'Quest Log',
            lab: 'Lab',
            profile: 'Profile'
          },
          signIn: 'Sign in with Google',
          signingIn: 'Signing in...'
        },
        'zh-CN': {
          appTitle: '像素中心',
          window: '窗口',
          settings: '设置',
          nav: {
            home: '首页',
            pixelBoard: '像素看板',
            questLog: '任务日志',
            lab: '实验室',
            profile: '个人中心'
          },
          signIn: '使用 Google 登录',
          signingIn: '登录中...'
        },
        'ja-JP': {
          appTitle: 'ピクセルハブ',
          window: 'ウィンドウ',
          settings: '設定',
          nav: {
            home: 'ホーム',
            pixelBoard: 'ピクセルボード',
            questLog: 'クエストログ',
            lab: 'ラボ',
            profile: 'プロフィール'
          },
          signIn: 'Google でログイン',
          signingIn: 'ログイン中...'
        }
      })[locale] || {
        appTitle: 'Pixel Hub',
        window: 'Window',
        settings: 'Settings',
        nav: {
          home: 'Home',
          pixelBoard: 'Pixel Board',
          questLog: 'Quest Log',
          lab: 'Lab',
          profile: 'Profile'
        },
        signIn: 'Sign in with Google',
        signingIn: 'Signing in...'
      },
    [locale]
  )

  useEffect(() => {
    hydrateAppSettings()
  }, [hydrateAppSettings])

  useEffect(() => {
    hydrateTheme()
    const unsubscribe = subscribeTheme()
    return () => {
      unsubscribe()
    }
  }, [hydrateTheme, subscribeTheme])

  useEffect(() => {
    hydrateUpdateStatus()
    const unsubscribe = subscribeUpdateStatus()
    return () => {
      unsubscribe()
    }
  }, [hydrateUpdateStatus, subscribeUpdateStatus])

  useEffect(() => {
    let unsubscribe = () => {}

    const bootstrap = async () => {
      await hydrate()
      unsubscribe = window.api.onSharedStateUpdated(syncFromMain)
    }

    bootstrap()

    return () => {
      unsubscribe()
    }
  }, [hydrate, syncFromMain])

  useEffect(() => {
    let unsubscribe = () => {}

    const bootstrapUser = async () => {
      const user = await window.api.getAuthUser()
      setAuthUser(user)
      unsubscribe = window.api.onAuthUserUpdated((nextUser) => {
        setAuthUser(nextUser)
        setAuthLoading(false)
      })
    }

    bootstrapUser()

    return () => {
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!authUser?.name) {
      return
    }

    let lastSent = 0

    const reportActivity = async () => {
      const now = Date.now()
      if (now - lastSent < ACTIVITY_REPORT_INTERVAL_MS) {
        return
      }

      lastSent = now
      const nextUser = await window.api.touchAuthActivity()
      setAuthUser(nextUser)
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        reportActivity()
      }
    }

    const events = ['pointerdown', 'keydown', 'mousemove', 'wheel', 'touchstart']
    for (const eventName of events) {
      window.addEventListener(eventName, reportActivity, { passive: true })
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    reportActivity()

    return () => {
      for (const eventName of events) {
        window.removeEventListener(eventName, reportActivity)
      }
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [authUser?.name])

  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', theme)
    root.setAttribute('lang', locale)
    root.classList.add('theme-switching')

    const timer = window.setTimeout(() => {
      root.classList.remove('theme-switching')
    }, 420)

    return () => {
      window.clearTimeout(timer)
      root.classList.remove('theme-switching')
    }
  }, [theme, locale])

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('compact-sidebar', settings.general.compactSidebar)
  }, [settings.general.compactSidebar])

  const handleUserClick = async () => {
    if (authUser?.name || authLoading) {
      return
    }

    setAuthLoading(true)
    setAuthError('')

    try {
      const user = await window.api.loginWithGoogle()
      setAuthUser(user)
      if (!user) {
        setAuthError('Sign-in was cancelled or timed out. Please try again.')
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Google sign-in failed. Please check configuration.'
      setAuthError(message)
    } finally {
      setAuthLoading(false)
    }
  }

  const handleLogout = async () => {
    await window.api.logout()
    setAuthUser(null)
  }

  const handleRelaunch = async () => {
    await window.api.relaunchApp()
  }

  const userButtonLabel = authUser?.name
    ? `User: ${authUser.name}`
    : authLoading
      ? text.signingIn
      : text.signIn

  const isSettingsWindow = windowRole === 'settings'

  const openSettingsWindow = async () => {
    await window.api.createSettingsWindow()
  }

  const routeTitleMap = useMemo(() => {
    return {
      '/': text.nav.home,
      '/home': text.nav.home,
      '/pixel-board': text.nav.pixelBoard,
      '/quest-log': text.nav.questLog,
      '/lab': text.nav.lab,
      '/profile': text.nav.profile,
      '/settings': text.settings
    }
  }, [text])

  useEffect(() => {
    const routeTitle = routeTitleMap[location.pathname] || text.appTitle
    const fullTitle = `${routeTitle} - ${text.appTitle}`
    document.title = fullTitle
    window.api.setWindowTitle(fullTitle)
  }, [location.pathname, routeTitleMap, text.appTitle])

  return (
    <AppShellLayout $isSettingsWindow={isSettingsWindow}>
      {isSettingsWindow ? null : (
        <Sidebar>
          <BrandCard>
            <BrandTitle>{text.appTitle}</BrandTitle>
            <BrandSub>
              {text.window}: {windowRole}
            </BrandSub>
          </BrandCard>

          <NavList>
            {navItems.map((item) => (
              <NavItem key={item.to} to={item.to}>
                {text.nav[item.key]}
              </NavItem>
            ))}
          </NavList>

          <SidebarBottom>
            <SideAction onClick={handleUserClick} disabled={authLoading}>
              {userButtonLabel}
            </SideAction>
            {authError ? <AuthError>{authError}</AuthError> : null}
            <SideAction onClick={openSettingsWindow}>{text.settings}</SideAction>
            {/* Legacy modal button preserved per request:
            <SideAction onClick={() => setSettingsOpen(true)}>Settings</SideAction>
            */}
          </SidebarBottom>
        </Sidebar>
      )}

      <ContentArea $isSettingsWindow={isSettingsWindow}>
        <Routes>
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route path="/home" element={<HomePage />} />
          <Route path="/pixel-board" element={<PixelBoardPage />} />
          <Route path="/quest-log" element={<QuestLogPage />} />
          <Route path="/lab" element={<LabPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route
            path="/settings"
            element={
              <SettingsModal
                asWindow
                authUser={authUser}
                authLoading={authLoading}
                onClose={() => window.close()}
                onRequestLogin={handleUserClick}
                onRequestLogout={handleLogout}
                onRequestRelaunch={handleRelaunch}
              />
            }
          />
        </Routes>

        {isSettingsWindow ? null : (
          <VersionsWrap>
            <Versions />
          </VersionsWrap>
        )}
      </ContentArea>

      {/* Legacy modal render preserved per request:
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        authUser={authUser}
        authLoading={authLoading}
        onRequestLogin={handleUserClick}
        onRequestLogout={handleLogout}
        onRequestRelaunch={handleRelaunch}
      />
      */}
    </AppShellLayout>
  )
}

function App() {
  return (
    <HashRouter>
      <AppShell />
    </HashRouter>
  )
}

export default App
