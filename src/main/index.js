import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  session,
  shell,
  systemPreferences
} from 'electron'
import { mkdir, readdir, stat, unlink, writeFile } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

const VIDEO_FILE_EXTENSIONS = new Set(['webm', 'mp4', 'ogv'])
const RECORDING_FILE_PREFIX = 'screen-recording-'
let preferredDisplaySourceId = ''

function getRecordingsDirectoryPath() {
  return app.getPath('downloads')
}

function createRecordingFileName(extension = 'webm') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${RECORDING_FILE_PREFIX}${stamp}.${extension}`
}

function getVideoExtensionFromMimeType(mimeType = '') {
  const mime = typeof mimeType === 'string' ? mimeType.toLowerCase() : ''
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('ogg')) return 'ogv'
  return 'webm'
}

function parseDataUrl(dataUrl = '') {
  if (typeof dataUrl !== 'string') return null

  const matched = dataUrl.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/)
  if (!matched) return null

  const [, mimeType, encoded] = matched

  try {
    return {
      mimeType: mimeType || '',
      buffer: Buffer.from(encoded, 'base64')
    }
  } catch {
    return null
  }
}

function isRecordingFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return false
  }

  const recordingsRoot = `${resolve(getRecordingsDirectoryPath())}${sep}`
  const targetPath = resolve(filePath)
  return `${targetPath}${sep}`.startsWith(recordingsRoot)
}

function getPosterPathByVideoPath(filePath) {
  const normalized = typeof filePath === 'string' ? filePath : ''
  const marker = normalized.lastIndexOf('.')
  if (marker <= 0) {
    return `${normalized}.jpg`
  }
  return `${normalized.slice(0, marker)}.jpg`
}

async function buildRecordingItem(filePath, fileStat) {
  const createdAt = Number(fileStat.birthtimeMs || fileStat.mtimeMs || Date.now())
  const posterPath = getPosterPathByVideoPath(filePath)
  let posterUrl = ''

  try {
    const posterStat = await stat(posterPath)
    if (posterStat.isFile()) {
      posterUrl = pathToFileURL(posterPath).toString()
    }
  } catch {
    posterUrl = ''
  }

  return {
    name: filePath.split(sep).pop() || '',
    path: filePath,
    fileUrl: pathToFileURL(filePath).toString(),
    posterUrl,
    bytes: Number(fileStat.size || 0),
    createdAt
  }
}

async function listRecordingItems() {
  const recordingsDir = getRecordingsDirectoryPath()
  await mkdir(recordingsDir, { recursive: true })

  const fileNames = await readdir(recordingsDir)
  const items = []

  for (const fileName of fileNames) {
    if (!fileName.startsWith(RECORDING_FILE_PREFIX)) {
      continue
    }

    const extension = fileName.split('.').pop()?.toLowerCase() || ''
    if (!VIDEO_FILE_EXTENSIONS.has(extension)) {
      continue
    }

    const filePath = join(recordingsDir, fileName)

    try {
      const fileStat = await stat(filePath)
      if (!fileStat.isFile()) {
        continue
      }
      items.push(await buildRecordingItem(filePath, fileStat))
    } catch {
      continue
    }
  }

  items.sort((a, b) => b.createdAt - a.createdAt)
  return items
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

async function listCaptureSources() {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 480, height: 270 }
  })

  const mapped = sources.map(mapCaptureSourceItem)
  mapped.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name)
    return a.type === 'screen' ? -1 : 1
  })
  return mapped
}

function getScreenCapturePermissionDetails() {
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

async function openScreenCaptureSettings() {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      message: 'This platform does not support deep-linking to screen recording settings.'
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

function createWindow() {
  const window = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'Clip Recorder',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
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
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function registerRecordingHandlers() {
  ipcMain.handle('screen-recording:save', async (_, payload = {}) => {
    const parsed = parseDataUrl(payload?.dataUrl || '')
    const parsedPoster = parseDataUrl(payload?.posterDataUrl || '')

    if (!parsed || !parsed.buffer?.length) {
      return { ok: false, message: 'Invalid recording payload.' }
    }

    const detectedMime = parsed.mimeType || payload?.mimeType || 'video/webm'
    const ext = getVideoExtensionFromMimeType(detectedMime)
    const filePath = join(getRecordingsDirectoryPath(), createRecordingFileName(ext))

    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, parsed.buffer)
    if (parsedPoster?.buffer?.length) {
      const posterPath = getPosterPathByVideoPath(filePath)
      await writeFile(posterPath, parsedPoster.buffer)
    }
    const fileStat = await stat(filePath)

    return {
      ok: true,
      item: await buildRecordingItem(filePath, fileStat)
    }
  })

  ipcMain.handle('screen-recording:list', async () => {
    try {
      const items = await listRecordingItems()
      return { ok: true, items }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to load recordings.'
      }
    }
  })

  ipcMain.handle('screen-recording:permission-status', () => {
    return {
      ok: true,
      ...getScreenCapturePermissionDetails()
    }
  })

  ipcMain.handle('screen-recording:open-permission-settings', async () => {
    return openScreenCaptureSettings()
  })

  ipcMain.handle('screen-recording:get-sources', async () => {
    try {
      const sources = await listCaptureSources()
      return { ok: true, sources }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to load capture sources.'
      }
    }
  })

  ipcMain.handle('screen-recording:set-source', (_, payload = {}) => {
    const sourceId = typeof payload?.sourceId === 'string' ? payload.sourceId : ''
    preferredDisplaySourceId = sourceId
    return { ok: true, sourceId: preferredDisplaySourceId }
  })

  ipcMain.handle('screen-recording:open', async (_, payload = {}) => {
    const filePath = typeof payload?.path === 'string' ? payload.path : ''
    if (!isRecordingFilePath(filePath)) {
      return { ok: false, message: 'Invalid recording path.' }
    }

    const openError = await shell.openPath(filePath)
    if (openError) {
      return { ok: false, message: openError }
    }

    return { ok: true }
  })

  ipcMain.handle('screen-recording:reveal', (_, payload = {}) => {
    const filePath = typeof payload?.path === 'string' ? payload.path : ''
    if (!isRecordingFilePath(filePath)) {
      return { ok: false, message: 'Invalid recording path.' }
    }

    shell.showItemInFolder(filePath)
    return { ok: true }
  })

  ipcMain.handle('screen-recording:delete', async (_, payload = {}) => {
    const filePath = typeof payload?.path === 'string' ? payload.path : ''
    if (!isRecordingFilePath(filePath)) {
      return { ok: false, message: 'Invalid recording path.' }
    }

    try {
      const fileStat = await stat(filePath)
      if (!fileStat.isFile()) {
        return { ok: false, message: 'Recording file not found.' }
      }
      await unlink(filePath)
      try {
        const posterPath = getPosterPathByVideoPath(filePath)
        await unlink(posterPath)
      } catch {
        // Ignore missing poster files.
      }
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to delete recording.'
      }
    }
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron.clip-recorder')

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 }
      })

      if (!sources.length) {
        callback({})
        return
      }

      const preferredSource =
        sources.find((source) => source.id === preferredDisplaySourceId) ||
        sources.find((source) => source.id.startsWith('screen:')) ||
        sources[0]

      callback({
        video: preferredSource,
        audio: request.audioRequested && process.platform !== 'darwin' ? 'loopback' : undefined
      })
    } catch {
      callback({})
    }
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerRecordingHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
