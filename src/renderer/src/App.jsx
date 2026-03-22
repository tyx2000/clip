import { useEffect, useMemo, useState } from 'react'
import { HashRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom'
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
    <div className={isSettingsWindow ? 'app-shell app-shell-settings' : 'app-shell'}>
      {isSettingsWindow ? null : (
        <aside className="sidebar">
          <div className="brand-card">
            <h1>{text.appTitle}</h1>
            <p>
              {text.window}: {windowRole}
            </p>
          </div>

          <nav className="nav-list">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              >
                {text.nav[item.key]}
              </NavLink>
            ))}
          </nav>

          <div className="sidebar-bottom">
            <button className="side-action" onClick={handleUserClick} disabled={authLoading}>
              {userButtonLabel}
            </button>
            {authError ? <p className="auth-error">{authError}</p> : null}
            <button className="side-action" onClick={openSettingsWindow}>
              {text.settings}
            </button>
            {/* Legacy modal button preserved per request:
            <button className="side-action" onClick={() => setSettingsOpen(true)}>
              Settings
            </button>
            */}
          </div>
        </aside>
      )}

      <main className={isSettingsWindow ? 'content-area settings-content-area' : 'content-area'}>
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
          <div className="versions-wrap">
            <Versions />
          </div>
        )}
      </main>

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
    </div>
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
