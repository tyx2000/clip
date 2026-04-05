import { app, shell, BrowserWindow, ipcMain, safeStorage, Notification } from 'electron'
import { randomBytes, createHash } from 'crypto'
import { readFileSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { createServer } from 'http'
import { dirname, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import icon from '../../resources/icon.png?asset'

const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || ''
const AUTH_SCOPE = 'openid profile email'
const AUTH_TIMEOUT_MS = 3 * 60 * 1000
const AUTH_INACTIVE_EXPIRE_MS = 30 * 24 * 60 * 60 * 1000
const AUTH_PERSIST_INTERVAL_MS = 5 * 60 * 1000

const defaultSharedState = {
  count: 0,
  message: 'Hello from main process'
}

const defaultAppSettings = {
  general: {
    language: 'zh-CN',
    theme: 'light',
    launchOnStartup: false,
    autoUpdate: true,
    compactSidebar: false
  },
  account: {
    displayName: 'Pixel User',
    statusText: 'Ready to build',
    syncProfile: true
  },
  notifications: {
    desktopNotice: true,
    soundNotice: true,
    digestFrequency: 'daily'
  },
  privacy: {
    analyticsEnabled: false,
    crashReportEnabled: true,
    personalizedAds: false
  },
  advanced: {
    defaultOpenDevtools: false,
    hardwareAcceleration: true,
    cacheSizeMb: 512,
    animationLevel: 'full'
  }
}

const sharedState = {
  ...defaultSharedState
}

const appSettings = JSON.parse(JSON.stringify(defaultAppSettings))
let startupAppSettings = JSON.parse(JSON.stringify(defaultAppSettings))

const authSession = {
  user: null,
  tokens: null,
  lastActiveAt: 0
}

let lastAuthPersistAt = 0
let updaterListenersBound = false
let settingsWindowRef = null
const supportedThemes = new Set(['light', 'dark', 'blue'])

const updateState = {
  status: 'idle',
  message: '',
  currentVersion: app.getVersion(),
  availableVersion: '',
  progressPercent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  bytesPerSecond: 0,
  lastCheckedAt: 0,
  lastCheckedAtLabel: '',
  errorCode: '',
  errorDetail: '',
  canDownload: false,
  canInstall: false
}

const flashTimerByWindow = new WeakMap()

function flashTaskbarIcon(window, durationMs = 8000) {
  if (!window || window.isDestroyed()) {
    return
  }

  const previousTimer = flashTimerByWindow.get(window)
  if (previousTimer) {
    clearTimeout(previousTimer)
  }

  window.flashFrame(true)

  const stopFlash = () => {
    if (!window.isDestroyed()) {
      window.flashFrame(false)
      window.removeListener('focus', stopFlash)
    }
    const timer = flashTimerByWindow.get(window)
    if (timer) {
      clearTimeout(timer)
      flashTimerByWindow.delete(window)
    }
  }

  const timer = setTimeout(stopFlash, durationMs)
  flashTimerByWindow.set(window, timer)
  window.once('focus', stopFlash)
}

function readStartupAppSettings() {
  try {
    const filePath = join(app.getPath('userData'), 'app-settings.json')
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    startupAppSettings = normalizeAppSettings(parsed)
  } catch {
    startupAppSettings = JSON.parse(JSON.stringify(defaultAppSettings))
  }
}

function setUpdateState(patch) {
  Object.assign(updateState, patch)
}

function broadcastUpdateState() {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('app-update:status', updateState)
    }
  }
}

function reportUpdateState(patch) {
  setUpdateState(patch)
  broadcastUpdateState()
}

function getCurrentTheme() {
  return appSettings.general.theme
}

function broadcastTheme() {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('theme:updated', getCurrentTheme())
    }
  }
}

function formatTimeLabel(timestamp) {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleString()
}

function getSharedStateFilePath() {
  return join(app.getPath('userData'), 'shared-state.json')
}

function getAuthSessionFilePath() {
  return join(app.getPath('userData'), 'auth-session.json')
}

function getAppSettingsFilePath() {
  return join(app.getPath('userData'), 'app-settings.json')
}

function normalizeSharedState(state) {
  return {
    count: Number.isFinite(state?.count) ? Math.trunc(state.count) : defaultSharedState.count,
    message: typeof state?.message === 'string' ? state.message : defaultSharedState.message
  }
}

function normalizeAppSettings(settings) {
  const source = settings && typeof settings === 'object' ? settings : {}

  return {
    general: {
      language:
        typeof source?.general?.language === 'string'
          ? source.general.language
          : defaultAppSettings.general.language,
      theme:
        typeof source?.general?.theme === 'string' && supportedThemes.has(source.general.theme)
          ? source.general.theme
          : defaultAppSettings.general.theme,
      launchOnStartup:
        typeof source?.general?.launchOnStartup === 'boolean'
          ? source.general.launchOnStartup
          : defaultAppSettings.general.launchOnStartup,
      autoUpdate:
        typeof source?.general?.autoUpdate === 'boolean'
          ? source.general.autoUpdate
          : defaultAppSettings.general.autoUpdate,
      compactSidebar:
        typeof source?.general?.compactSidebar === 'boolean'
          ? source.general.compactSidebar
          : defaultAppSettings.general.compactSidebar
    },
    account: {
      displayName:
        typeof source?.account?.displayName === 'string'
          ? source.account.displayName
          : defaultAppSettings.account.displayName,
      statusText:
        typeof source?.account?.statusText === 'string'
          ? source.account.statusText
          : defaultAppSettings.account.statusText,
      syncProfile:
        typeof source?.account?.syncProfile === 'boolean'
          ? source.account.syncProfile
          : defaultAppSettings.account.syncProfile
    },
    notifications: {
      desktopNotice:
        typeof source?.notifications?.desktopNotice === 'boolean'
          ? source.notifications.desktopNotice
          : defaultAppSettings.notifications.desktopNotice,
      soundNotice:
        typeof source?.notifications?.soundNotice === 'boolean'
          ? source.notifications.soundNotice
          : defaultAppSettings.notifications.soundNotice,
      digestFrequency:
        typeof source?.notifications?.digestFrequency === 'string'
          ? source.notifications.digestFrequency
          : defaultAppSettings.notifications.digestFrequency
    },
    privacy: {
      analyticsEnabled:
        typeof source?.privacy?.analyticsEnabled === 'boolean'
          ? source.privacy.analyticsEnabled
          : defaultAppSettings.privacy.analyticsEnabled,
      crashReportEnabled:
        typeof source?.privacy?.crashReportEnabled === 'boolean'
          ? source.privacy.crashReportEnabled
          : defaultAppSettings.privacy.crashReportEnabled,
      personalizedAds:
        typeof source?.privacy?.personalizedAds === 'boolean'
          ? source.privacy.personalizedAds
          : defaultAppSettings.privacy.personalizedAds
    },
    advanced: {
      defaultOpenDevtools:
        typeof source?.advanced?.defaultOpenDevtools === 'boolean'
          ? source.advanced.defaultOpenDevtools
          : defaultAppSettings.advanced.defaultOpenDevtools,
      hardwareAcceleration:
        typeof source?.advanced?.hardwareAcceleration === 'boolean'
          ? source.advanced.hardwareAcceleration
          : defaultAppSettings.advanced.hardwareAcceleration,
      cacheSizeMb: Number.isFinite(source?.advanced?.cacheSizeMb)
        ? Math.max(128, Math.min(4096, Math.trunc(source.advanced.cacheSizeMb)))
        : defaultAppSettings.advanced.cacheSizeMb,
      animationLevel:
        typeof source?.advanced?.animationLevel === 'string'
          ? source.advanced.animationLevel
          : defaultAppSettings.advanced.animationLevel
    }
  }
}

function normalizeAuthUser(user) {
  if (!user || typeof user !== 'object') return null

  const name = typeof user.name === 'string' ? user.name.trim() : ''
  const email = typeof user.email === 'string' ? user.email.trim() : ''
  const picture = typeof user.picture === 'string' ? user.picture : ''
  const sub = typeof user.sub === 'string' ? user.sub : ''

  if (!name) return null

  return { name, email, picture, sub }
}

readStartupAppSettings()
if (!startupAppSettings.advanced.hardwareAcceleration) {
  app.disableHardwareAcceleration()
}

function toBase64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function createPkcePair() {
  const verifier = toBase64Url(randomBytes(48))
  const challenge = toBase64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function encodeTokens(tokens) {
  if (!tokens) {
    return null
  }

  const raw = JSON.stringify(tokens)

  if (safeStorage.isEncryptionAvailable()) {
    return {
      mode: 'encrypted',
      value: safeStorage.encryptString(raw).toString('base64')
    }
  }

  return {
    mode: 'plain',
    value: raw
  }
}

function decodeTokens(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.value !== 'string') {
    return null
  }

  try {
    if (payload.mode === 'encrypted' && safeStorage.isEncryptionAvailable()) {
      const buffer = Buffer.from(payload.value, 'base64')
      const raw = safeStorage.decryptString(buffer)
      return JSON.parse(raw)
    }

    if (payload.mode === 'plain') {
      return JSON.parse(payload.value)
    }
  } catch {
    return null
  }

  return null
}

function clearAuthSessionState() {
  authSession.user = null
  authSession.tokens = null
  authSession.lastActiveAt = 0
}

function isAuthSessionExpired() {
  if (!authSession.user || !authSession.lastActiveAt) {
    return true
  }

  return Date.now() - authSession.lastActiveAt > AUTH_INACTIVE_EXPIRE_MS
}

async function loadSharedState() {
  try {
    const filePath = getSharedStateFilePath()
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    Object.assign(sharedState, normalizeSharedState(parsed))
  } catch {
    Object.assign(sharedState, defaultSharedState)
  }
}

async function persistSharedState() {
  const filePath = getSharedStateFilePath()
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(sharedState, null, 2), 'utf-8')
}

async function loadAppSettings() {
  try {
    const filePath = getAppSettingsFilePath()
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    Object.assign(appSettings, normalizeAppSettings(parsed))
  } catch {
    Object.assign(appSettings, JSON.parse(JSON.stringify(defaultAppSettings)))
  }
}

async function persistAppSettings() {
  const filePath = getAppSettingsFilePath()
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(appSettings, null, 2), 'utf-8')
}

function applySystemSetting(section, key, value) {
  if (section === 'general' && key === 'launchOnStartup') {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: Boolean(value) })
    }
    return
  }
}

function updateAppSetting(section, key, value) {
  const result = {
    settings: appSettings,
    restartRequired: false,
    updated: false,
    message: ''
  }

  if (
    !Object.prototype.hasOwnProperty.call(appSettings, section) ||
    typeof appSettings[section] !== 'object'
  ) {
    return result
  }

  if (!Object.prototype.hasOwnProperty.call(appSettings[section], key)) {
    return result
  }

  const previousValue = appSettings[section][key]

  const nextSettings = normalizeAppSettings({
    ...appSettings,
    [section]: {
      ...appSettings[section],
      [key]: value
    }
  })

  Object.assign(appSettings, nextSettings)
  applySystemSetting(section, key, appSettings[section][key])
  if (section === 'general' && key === 'theme') {
    broadcastTheme()
  }

  result.settings = appSettings
  result.updated = previousValue !== appSettings[section][key]

  if (
    section === 'advanced' &&
    key === 'hardwareAcceleration' &&
    previousValue !== appSettings.advanced.hardwareAcceleration
  ) {
    result.restartRequired = true
    result.message = 'Hardware acceleration change requires app restart to take effect.'
  }

  return result
}

function replaceAppSettings(nextSettings) {
  const previousHardwareAcceleration = appSettings.advanced.hardwareAcceleration

  Object.assign(appSettings, normalizeAppSettings(nextSettings))
  applySystemSetting('general', 'launchOnStartup', appSettings.general.launchOnStartup)
  broadcastTheme()

  return {
    settings: appSettings,
    restartRequired: previousHardwareAcceleration !== appSettings.advanced.hardwareAcceleration,
    message:
      previousHardwareAcceleration !== appSettings.advanced.hardwareAcceleration
        ? 'Hardware acceleration change requires app restart to take effect.'
        : ''
  }
}

function setupAutoUpdaterListeners() {
  if (updaterListenersBound) {
    return
  }

  updaterListenersBound = true
  autoUpdater.autoDownload = false

  autoUpdater.on('checking-for-update', () => {
    reportUpdateState({
      status: 'checking',
      message: 'Checking for updates...',
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      errorCode: '',
      errorDetail: '',
      canDownload: false,
      canInstall: false
    })
  })

  autoUpdater.on('update-available', (info) => {
    reportUpdateState({
      status: 'available',
      message: `Update available: ${info?.version || 'new version'}`,
      availableVersion: info?.version || '',
      progressPercent: 0,
      canDownload: true,
      canInstall: false
    })

    if (appSettings.general.autoUpdate) {
      autoUpdater.downloadUpdate().catch((error) => {
        reportUpdateState({
          status: 'error',
          message: `Failed to start update download: ${error.message}`,
          canDownload: true
        })
      })
    }
  })

  autoUpdater.on('update-not-available', () => {
    reportUpdateState({
      status: 'up-to-date',
      message: 'You already have the latest version.',
      availableVersion: '',
      progressPercent: 0,
      canDownload: false,
      canInstall: false,
      errorCode: '',
      errorDetail: ''
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    reportUpdateState({
      status: 'downloading',
      message: `Downloading update: ${Math.round(progress.percent || 0)}%`,
      progressPercent: Number(progress.percent || 0),
      downloadedBytes: Number(progress.transferred || 0),
      totalBytes: Number(progress.total || 0),
      bytesPerSecond: Number(progress.bytesPerSecond || 0),
      canDownload: false,
      canInstall: false
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    reportUpdateState({
      status: 'downloaded',
      message: `Update ready to install: ${info?.version || 'new version'}`,
      availableVersion: info?.version || updateState.availableVersion,
      progressPercent: 100,
      canDownload: false,
      canInstall: true
    })
  })

  autoUpdater.on('error', (error) => {
    reportUpdateState({
      status: 'error',
      message: `Update error: ${error.message}`,
      errorCode: error.code || 'UNKNOWN',
      errorDetail: error.stack || error.message,
      canDownload: true,
      canInstall: false
    })
  })
}

async function triggerUpdateCheck() {
  try {
    const now = Date.now()
    reportUpdateState({
      status: 'checking',
      message: 'Checking for updates...',
      lastCheckedAt: now,
      lastCheckedAtLabel: formatTimeLabel(now),
      canDownload: false,
      canInstall: false,
      errorCode: '',
      errorDetail: ''
    })
    await autoUpdater.checkForUpdates()
  } catch (error) {
    const now = Date.now()
    reportUpdateState({
      status: 'error',
      message: `Update check failed: ${error.message}`,
      lastCheckedAt: now,
      lastCheckedAtLabel: formatTimeLabel(now),
      errorCode: error.code || 'CHECK_FAILED',
      errorDetail: error.stack || error.message,
      canDownload: false,
      canInstall: false
    })
  }
}

async function loadAuthSession() {
  try {
    const filePath = getAuthSessionFilePath()
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)

    authSession.user = normalizeAuthUser(parsed.user)
    authSession.tokens = decodeTokens(parsed.tokens)
    authSession.lastActiveAt = Number.isFinite(parsed.lastActiveAt) ? parsed.lastActiveAt : 0

    if (isAuthSessionExpired()) {
      clearAuthSessionState()
    }
  } catch {
    clearAuthSessionState()
  }
}

async function persistAuthSession() {
  const filePath = getAuthSessionFilePath()
  await mkdir(dirname(filePath), { recursive: true })

  const payload = {
    user: authSession.user,
    tokens: encodeTokens(authSession.tokens),
    lastActiveAt: authSession.lastActiveAt,
    updatedAt: Date.now()
  }

  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')
  lastAuthPersistAt = Date.now()
}

function broadcastSharedState() {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('shared-state:updated', sharedState)
    }
  }
}

function broadcastAuthUser() {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('auth-user:updated', authSession.user)
    }
  }
}

async function ensureAuthSessionValid() {
  if (!authSession.user) {
    return null
  }

  if (!isAuthSessionExpired()) {
    return authSession.user
  }

  clearAuthSessionState()
  await persistAuthSession()
  broadcastAuthUser()
  return null
}

async function createAuthCallbackServer(expectedState) {
  let resolveCode
  let rejectCode

  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', `http://127.0.0.1`)

    if (requestUrl.pathname !== '/oauth2callback') {
      res.writeHead(404)
      res.end('Not Found')
      return
    }

    const state = requestUrl.searchParams.get('state') || ''
    const code = requestUrl.searchParams.get('code') || ''
    const error = requestUrl.searchParams.get('error') || ''

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<h2>Google sign-in failed.</h2><p>You can close this window.</p>')
      rejectCode(new Error(`Google OAuth error: ${error}`))
      return
    }

    if (!code || state !== expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<h2>Invalid sign-in response.</h2><p>You can close this window.</p>')
      rejectCode(new Error('Invalid OAuth callback state or code.'))
      return
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<h2>Sign-in complete.</h2><p>You can return to the app.</p>')
    resolveCode(code)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Failed to start local OAuth callback server.')
  }

  const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`

  const timeout = setTimeout(() => {
    rejectCode(new Error('Google sign-in timed out.'))
  }, AUTH_TIMEOUT_MS)

  const waitForCode = async () => {
    try {
      return await codePromise
    } finally {
      clearTimeout(timeout)
      server.close()
    }
  }

  return {
    redirectUri,
    waitForCode
  }
}

async function exchangeCodeForToken({ code, codeVerifier, redirectUri }) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier
  })

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Token exchange failed: ${errorText}`)
  }

  return response.json()
}

async function fetchGoogleUserInfo(accessToken) {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to fetch Google user profile: ${errorText}`)
  }

  const profile = await response.json()
  const normalized = normalizeAuthUser({
    name: profile.name || profile.given_name || profile.email || '',
    email: profile.email || '',
    picture: profile.picture || '',
    sub: profile.sub || ''
  })

  if (!normalized) {
    throw new Error('Google profile is missing required name.')
  }

  return normalized
}

async function loginWithGoogleOAuth() {
  if (!GOOGLE_OAUTH_CLIENT_ID) {
    throw new Error('Missing GOOGLE_OAUTH_CLIENT_ID in environment.')
  }

  const state = toBase64Url(randomBytes(24))
  const pkce = createPkcePair()
  const callbackServer = await createAuthCallbackServer(state)

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.searchParams.set('client_id', GOOGLE_OAUTH_CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', callbackServer.redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', AUTH_SCOPE)
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('code_challenge', pkce.challenge)
  authUrl.searchParams.set('state', state)

  await shell.openExternal(authUrl.toString())

  const code = await callbackServer.waitForCode()
  const tokenPayload = await exchangeCodeForToken({
    code,
    codeVerifier: pkce.verifier,
    redirectUri: callbackServer.redirectUri
  })

  const user = await fetchGoogleUserInfo(tokenPayload.access_token)

  authSession.user = user
  authSession.tokens = {
    accessToken: tokenPayload.access_token,
    refreshToken: tokenPayload.refresh_token || authSession.tokens?.refreshToken || '',
    idToken: tokenPayload.id_token || '',
    expiresAt: tokenPayload.expires_in ? Date.now() + Number(tokenPayload.expires_in) * 1000 : 0
  }
  authSession.lastActiveAt = Date.now()

  await persistAuthSession()
  broadcastAuthUser()

  return authSession.user
}

async function touchAuthActivity({ forcePersist = false } = {}) {
  const validUser = await ensureAuthSessionValid()
  if (!validUser) {
    return null
  }

  authSession.lastActiveAt = Date.now()
  if (forcePersist || Date.now() - lastAuthPersistAt > AUTH_PERSIST_INTERVAL_MS) {
    await persistAuthSession()
  }

  return authSession.user
}

async function logoutAuthSession() {
  clearAuthSessionState()
  await persistAuthSession()
  broadcastAuthUser()
  return null
}

function createWindow(windowRole = 'main', hashRoute = '') {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'Pixel Hub',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  if (windowRole === 'settings') {
    settingsWindowRef = window
    window.on('closed', () => {
      settingsWindowRef = null
    })
  }

  if (appSettings.advanced.defaultOpenDevtools) {
    window.webContents.openDevTools({ mode: 'detach' })
  }

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  window.webContents.on('did-finish-load', () => {
    window.webContents.send('shared-state:updated', sharedState)
    window.webContents.send('auth-user:updated', authSession.user)
    window.webContents.send('app-update:status', updateState)
    window.webContents.send('theme:updated', getCurrentTheme())
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const devUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    devUrl.searchParams.set('windowRole', windowRole)
    if (hashRoute) {
      devUrl.hash = hashRoute
    }
    window.loadURL(devUrl.toString())
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { windowRole },
      hash: hashRoute || undefined
    })
  }

  return window
}

function createSettingsWindow(parentWindow) {
  if (settingsWindowRef && !settingsWindowRef.isDestroyed()) {
    if (settingsWindowRef.isMinimized()) {
      settingsWindowRef.restore()
    }
    settingsWindowRef.focus()
    return settingsWindowRef
  }

  const parentBounds = parentWindow?.getBounds?.()
  const width = Math.max(920, Math.min(1080, (parentBounds?.width || 1180) - 120))
  const height = Math.max(620, Math.min(760, (parentBounds?.height || 760) - 80))
  const x = parentBounds ? parentBounds.x + 50 : undefined
  const y = parentBounds ? parentBounds.y + 40 : undefined

  const window = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: 'Settings - Pixel Hub',
    autoHideMenuBar: true,
    parent: parentWindow || undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  settingsWindowRef = window
  window.on('closed', () => {
    settingsWindowRef = null
  })

  window.on('ready-to-show', () => {
    window.show()
    window.focus()
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  window.webContents.on('did-finish-load', () => {
    window.webContents.send('shared-state:updated', sharedState)
    window.webContents.send('auth-user:updated', authSession.user)
    window.webContents.send('app-update:status', updateState)
    window.webContents.send('theme:updated', getCurrentTheme())
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const devUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    devUrl.searchParams.set('windowRole', 'settings')
    devUrl.hash = '/settings'
    window.loadURL(devUrl.toString())
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { windowRole: 'settings' },
      hash: '/settings'
    })
  }

  return window
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.electron')
  setupAutoUpdaterListeners()

  await Promise.all([loadSharedState(), loadAuthSession(), loadAppSettings()])
  applySystemSetting('general', 'launchOnStartup', appSettings.general.launchOnStartup)
  if (appSettings.general.autoUpdate) {
    triggerUpdateCheck()
  }
  await ensureAuthSessionValid()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('window:create', () => {
    createWindow('child')
    return true
  })

  ipcMain.handle('window:create-settings', (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender)
    createSettingsWindow(parentWindow)
    return true
  })

  ipcMain.handle('window:set-title', (event, title = '') => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) {
      return false
    }
    const nextTitle = typeof title === 'string' && title.trim() ? title.trim() : 'Pixel Hub'
    win.setTitle(nextTitle)
    return true
  })

  ipcMain.handle('shared-state:get', () => sharedState)

  ipcMain.handle('shared-state:set', async (_, partialState = {}) => {
    if (typeof partialState !== 'object' || partialState === null) {
      return sharedState
    }

    if (Number.isFinite(partialState.count)) {
      sharedState.count = Math.trunc(partialState.count)
    }

    if (typeof partialState.message === 'string') {
      sharedState.message = partialState.message
    }

    await persistSharedState()
    broadcastSharedState()
    return sharedState
  })

  ipcMain.handle('shared-state:increment', async (_, delta = 1) => {
    const step = Number.isFinite(delta) ? delta : 1
    sharedState.count += step

    await persistSharedState()
    broadcastSharedState()
    return sharedState
  })

  ipcMain.handle('app-settings:get', () => appSettings)

  ipcMain.handle('app-settings:set', async (_, payload = {}) => {
    const section = typeof payload?.section === 'string' ? payload.section : ''
    const key = typeof payload?.key === 'string' ? payload.key : ''
    const value = payload?.value

    const result = updateAppSetting(section, key, value)
    if (result.updated) {
      await persistAppSettings()
    }

    if (section === 'general' && key === 'autoUpdate' && value === true) {
      triggerUpdateCheck()
    }

    return result
  })

  ipcMain.handle('app-settings:replace', async (_, nextSettings = {}) => {
    const result = replaceAppSettings(nextSettings)
    await persistAppSettings()

    if (appSettings.general.autoUpdate) {
      triggerUpdateCheck()
    }

    return result
  })

  ipcMain.handle('app:relaunch', () => {
    app.relaunch()
    app.quit()
    return true
  })

  ipcMain.handle('app-update:get-status', () => updateState)

  ipcMain.handle('app-update:check', async () => {
    await triggerUpdateCheck()
    return updateState
  })

  ipcMain.handle('app-update:download', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return updateState
    } catch (error) {
      reportUpdateState({
        status: 'error',
        message: `Download failed: ${error.message}`,
        errorCode: error.code || 'DOWNLOAD_FAILED',
        errorDetail: error.stack || error.message,
        canDownload: true,
        canInstall: false
      })
      return updateState
    }
  })

  ipcMain.handle('app-update:install', () => {
    autoUpdater.quitAndInstall()
    return true
  })

  ipcMain.handle('theme:get', () => getCurrentTheme())

  ipcMain.handle('theme:set', async (_, nextTheme) => {
    if (typeof nextTheme !== 'string' || !supportedThemes.has(nextTheme)) {
      return getCurrentTheme()
    }

    appSettings.general.theme = nextTheme
    await persistAppSettings()
    broadcastTheme()
    return getCurrentTheme()
  })

  ipcMain.handle('auth:get-user', async () => {
    return ensureAuthSessionValid()
  })

  ipcMain.handle('auth:touch-activity', async () => {
    return touchAuthActivity()
  })

  ipcMain.handle('auth:login-google', async () => {
    const existingUser = await ensureAuthSessionValid()
    if (existingUser) {
      return existingUser
    }

    return loginWithGoogleOAuth()
  })

  ipcMain.handle('auth:logout', async () => {
    return logoutAuthSession()
  })

  ipcMain.handle('ipc:ping', () => {
    return {
      message: 'pong',
      timestamp: new Date().toISOString()
    }
  })

  ipcMain.handle('notification:send', (event, payload = {}) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    flashTaskbarIcon(senderWindow)

    if (!Notification.isSupported()) {
      return {
        ok: false,
        message: 'System notification is not supported on this platform. Taskbar icon is flashing.'
      }
    }

    if (!appSettings.notifications.desktopNotice) {
      return {
        ok: false,
        message: 'Desktop notifications are disabled in settings. Taskbar icon is flashing.'
      }
    }

    const title =
      typeof payload?.title === 'string' && payload.title.trim()
        ? payload.title.trim()
        : 'Pixel Hub'
    const body =
      typeof payload?.body === 'string' && payload.body.trim()
        ? payload.body.trim()
        : 'This is a system notification from Home page.'

    const notification = new Notification({
      title,
      body,
      silent: !appSettings.notifications.soundNotice
    })

    notification.show()

    return { ok: true, message: 'Notification sent and taskbar icon is flashing.' }
  })

  createWindow('main')

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow('main')
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
