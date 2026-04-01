import { BrowserWindow, desktopCapturer, protocol, shell, systemPreferences } from 'electron'
import { createReadStream, existsSync } from 'fs'
import { stat } from 'fs/promises'
import { extname, join, sep } from 'path'
import { Readable } from 'node:stream'
import { is } from '@electron-toolkit/utils'
import { RECORDING_MEDIA_SCHEME } from './recordingPaths'

export function toRecordingMediaUrl(filePath) {
  return `${RECORDING_MEDIA_SCHEME}://media/${encodeURIComponent(filePath)}`
}

function parseRecordingMediaRequestUrl(urlText) {
  try {
    const parsed = new URL(urlText)
    if (parsed.protocol !== `${RECORDING_MEDIA_SCHEME}:` || parsed.hostname !== 'media') {
      return ''
    }

    const encodedPath = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname
    if (!encodedPath) {
      return ''
    }

    return decodeURIComponent(encodedPath)
  } catch {
    return ''
  }
}

function getMediaContentType(filePath) {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.ogv' || ext === '.ogg') return 'video/ogg'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  return 'application/octet-stream'
}

function parseRangeHeader(rangeValue, fileSize) {
  if (!rangeValue || typeof rangeValue !== 'string') {
    return null
  }

  const matched = rangeValue.match(/^bytes=(\d*)-(\d*)$/)
  if (!matched) {
    return null
  }

  const startRaw = matched[1]
  const endRaw = matched[2]

  let start = startRaw ? Number(startRaw) : 0
  let end = endRaw ? Number(endRaw) : fileSize - 1

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null
  }

  if (!startRaw && endRaw) {
    const suffixLength = Number(endRaw)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null
    }
    start = Math.max(fileSize - suffixLength, 0)
    end = fileSize - 1
  }

  if (start < 0 || end < 0 || start > end || start >= fileSize) {
    return null
  }

  end = Math.min(end, fileSize - 1)
  return { start, end }
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
    if (a.type === b.type) return a.name.localeCompare(b.name)
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

export function resolvePreferredDisplaySource(sources, preferredDisplaySourceId = '') {
  return (
    sources.find((source) => source.id === preferredDisplaySourceId) ||
    sources.find((source) => source.id.startsWith('screen:')) ||
    sources[0] ||
    null
  )
}

export function createMainWindow({ iconPath, baseDir }) {
  const window = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'Clip Recorder',
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

export function registerRecordingMediaProtocol({ isRecordingFilePath }) {
  protocol.handle(RECORDING_MEDIA_SCHEME, async (request) => {
    const filePath = parseRecordingMediaRequestUrl(request.url)
    if (!filePath || !isRecordingFilePath(filePath)) {
      return new Response('Forbidden', { status: 403 })
    }

    if (!existsSync(filePath)) {
      return new Response('Not Found', { status: 404 })
    }

    try {
      const fileStat = await stat(filePath)
      if (!fileStat.isFile()) {
        return new Response('Not Found', { status: 404 })
      }

      const fileSize = Number(fileStat.size || 0)
      const contentType = getMediaContentType(filePath)
      const rangeHeader = request.headers.get('range')
      const parsedRange = parseRangeHeader(rangeHeader, fileSize)

      if (rangeHeader && !parsedRange) {
        return new Response(null, {
          status: 416,
          headers: {
            'Content-Range': `bytes */${fileSize}`,
            'Accept-Ranges': 'bytes'
          }
        })
      }

      if (parsedRange) {
        const { start, end } = parsedRange
        const chunkSize = end - start + 1
        const stream = createReadStream(filePath, { start, end })

        return new Response(Readable.toWeb(stream), {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store'
          }
        })
      }

      const stream = createReadStream(filePath)
      return new Response(Readable.toWeb(stream), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(fileSize),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store'
        }
      })
    } catch (error) {
      console.warn(
        '[recording] media protocol failed:',
        error instanceof Error ? error.message : error
      )
      return new Response('Failed to load media', { status: 500 })
    }
  })
}

export function createRecordingPlayerWindow({ filePath, baseDir }) {
  const playerWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 720,
    minHeight: 460,
    autoHideMenuBar: true,
    title: `录制回放 - ${filePath.split(sep).pop() || ''}`,
    webPreferences: {
      preload: join(baseDir, '../preload/index.js'),
      sandbox: false
    }
  })

  const videoUrl = toRecordingMediaUrl(filePath)
  const displayName = filePath.split(sep).pop() || ''
  playerWindow.webContents.on('did-fail-load', (_, errorCode, errorDescription) => {
    console.warn('[recording] player window failed to load:', errorCode, errorDescription)
  })

  playerWindow.webContents.on('console-message', (_, level, message) => {
    if (level >= 2) {
      console.warn('[recording] player console:', message)
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL']
    const query = new URLSearchParams({
      player: videoUrl,
      name: displayName
    }).toString()
    playerWindow.loadURL(`${base}?${query}`)
  } else {
    playerWindow.loadFile(join(baseDir, '../renderer/index.html'), {
      query: {
        player: videoUrl,
        name: displayName
      }
    })
  }
  return playerWindow
}
