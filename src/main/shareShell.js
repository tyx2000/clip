import { BrowserWindow, desktopCapturer, shell, systemPreferences } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

const meetingWindows = new Map()

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
  const window = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: '会议',
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
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(baseDir, '../renderer/index.html'))
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

  const meetingWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 820,
    minHeight: 620,
    autoHideMenuBar: true,
    title: '会议',
    webPreferences: {
      preload: join(baseDir, '../preload/index.js'),
      sandbox: false
    }
  })

  const query = new URLSearchParams({ meeting: '1' })
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
