import { BrowserWindow, desktopCapturer, shell, systemPreferences } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

const meetingWindows = new Map()
const DARWIN_TITLE_BAR_HEIGHT = 28
const WINDOWS_TITLE_BAR_HEIGHT = 32
const DEFAULT_TITLE_BAR_HEIGHT = 34

function getWindowChromeOptions() {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hidden',
      trafficLightPosition: {
        x: 14,
        y: Math.round((DARWIN_TITLE_BAR_HEIGHT - 14) / 2)
      },
      backgroundColor: '#ffffff',
      titleBarHeight: DARWIN_TITLE_BAR_HEIGHT
    }
  }

  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#ffffff',
        symbolColor: '#0f172a',
        height: WINDOWS_TITLE_BAR_HEIGHT
      },
      backgroundColor: '#ffffff',
      titleBarHeight: WINDOWS_TITLE_BAR_HEIGHT
    }
  }

  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#0f172a',
      height: DEFAULT_TITLE_BAR_HEIGHT
    },
    backgroundColor: '#ffffff',
    titleBarHeight: DEFAULT_TITLE_BAR_HEIGHT
  }
}

function mapCaptureSourceItem(source) {
  return {
    id: source.id,
    name: source.name,
    type: source.id.startsWith('screen:') ? 'screen' : 'window',
    displayId: source.display_id || '',
    thumbnailDataUrl: source.thumbnail?.isEmpty?.() ? '' : source.thumbnail.toDataURL()
  }
}

export async function listCaptureSources() {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 480, height: 270 }
  })

  const mapped = sources.map(mapCaptureSourceItem)
  mapped.sort((a, b) => {
    if (a.type === b.type) {
      return a.name.localeCompare(b.name)
    }
    return a.type === 'screen' ? -1 : 1
  })
  return mapped
}

export function getScreenCapturePermissionDetails() {
  let status = 'unknown'

  if (process.platform === 'darwin' || process.platform === 'win32') {
    try {
      status = systemPreferences.getMediaAccessStatus('screen')
    } catch {
      status = 'unknown'
    }
  }

  const canOpenSettings = process.platform === 'darwin'
  const needsSettings =
    process.platform === 'darwin' &&
    status !== 'granted' &&
    status !== 'not-determined' &&
    status !== 'unknown'

  return {
    platform: process.platform,
    status,
    canOpenSettings,
    needsSettings
  }
}

export async function openScreenCaptureSettings() {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      message: 'This platform does not support deep-linking to screen capture settings.'
    }
  }

  try {
    const target = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    await shell.openExternal(target)
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Failed to open system privacy settings.'
    }
  }

  return { ok: true }
}

export function createMainWindow({ iconPath, baseDir }) {
  const chromeOptions = getWindowChromeOptions()
  const query = new URLSearchParams()
  query.set('platform', process.platform)
  query.set('titleBarHeight', String(chromeOptions.titleBarHeight))
  const window = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: '会议',
    titleBarStyle: chromeOptions.titleBarStyle,
    ...(chromeOptions.titleBarOverlay ? { titleBarOverlay: chromeOptions.titleBarOverlay } : {}),
    ...(chromeOptions.trafficLightPosition
      ? { trafficLightPosition: chromeOptions.trafficLightPosition }
      : {}),
    backgroundColor: chromeOptions.backgroundColor,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(baseDir, '../preload/index.js'),
      sandbox: false
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${query.toString()}`)
  } else {
    window.loadFile(join(baseDir, '../renderer/index.html'), {
      query: Object.fromEntries(query.entries())
    })
  }

  return window
}

export function createMeetingWindow({ baseDir, roomId = '', sessionPayload = null }) {
  const existingWindow = roomId ? meetingWindows.get(roomId) : null
  if (existingWindow && !existingWindow.isDestroyed()) {
    if (existingWindow.isMinimized()) {
      existingWindow.restore()
    }
    existingWindow.focus()
    return existingWindow
  }

  const chromeOptions = getWindowChromeOptions()
  const meetingWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 820,
    minHeight: 620,
    autoHideMenuBar: true,
    title: '会议',
    titleBarStyle: chromeOptions.titleBarStyle,
    ...(chromeOptions.titleBarOverlay ? { titleBarOverlay: chromeOptions.titleBarOverlay } : {}),
    ...(chromeOptions.trafficLightPosition
      ? { trafficLightPosition: chromeOptions.trafficLightPosition }
      : {}),
    backgroundColor: '#eef3f8',
    webPreferences: {
      preload: join(baseDir, '../preload/index.js'),
      sandbox: false
    }
  })

  const query = new URLSearchParams({ meeting: '1' })
  query.set('platform', process.platform)
  query.set('titleBarHeight', String(chromeOptions.titleBarHeight))
  if (roomId) {
    query.set('roomId', roomId)
  }
  if (sessionPayload) {
    query.set('session', encodeURIComponent(JSON.stringify(sessionPayload)))
  }

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL']
    meetingWindow.loadURL(`${base}?${query.toString()}`)
  } else {
    meetingWindow.loadFile(join(baseDir, '../renderer/index.html'), {
      query: Object.fromEntries(query.entries())
    })
  }

  if (roomId) {
    meetingWindows.set(roomId, meetingWindow)
    meetingWindow.on('closed', () => {
      if (meetingWindows.get(roomId) === meetingWindow) {
        meetingWindows.delete(roomId)
      }
    })
  }

  return meetingWindow
}
