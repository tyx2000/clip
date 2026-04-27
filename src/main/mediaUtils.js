/** 文件作用：集中提供录屏相关的路径规则、主进程媒体能力、协议访问和底层工具。 */
import ffmpegPath from 'ffmpeg-static'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, desktopCapturer, protocol, shell, systemPreferences } from 'electron'
import { createReadStream, existsSync } from 'fs'
import { readFile, readdir, stat } from 'fs/promises'
import { is } from '@electron-toolkit/utils'
import { dirname, extname, join, resolve, sep } from 'path'
import { Readable } from 'node:stream'

/** 可被视为最终录屏输出文件的视频扩展名集合。 */
export const VIDEO_FILE_EXTENSIONS = new Set(['webm', 'mp4', 'ogv'])
/** 所有本地最终录屏文件统一使用的文件名前缀。 */
export const RECORDING_FILE_PREFIX = 'sr-'
/** 录屏封面图使用的图片扩展名。 */
export const POSTER_FILE_EXTENSION = 'jpg'
/** 录屏元数据 SQLite 数据库文件名。 */
export const RECORDING_METADATA_DB_FILE_NAME = 'recordings.sqlite3'
/** 用于向渲染进程安全暴露本地媒体文件的自定义协议名。 */
export const RECORDING_MEDIA_SCHEME = 'recording'
/** 用于保存录制中会话临时文件的目录名。 */
export const RECORDING_SESSIONS_DIR_NAME = 'sessions'
/** 本地分段录制默认使用的切片时长。 */
export const DEFAULT_SEGMENT_DURATION_MS = 5 * 1000
/** 渲染进程允许传入的最小时长下限。 */
export const MIN_SEGMENT_DURATION_MS = 1 * 1000
/** 单个上传分片允许增长到的最大体积。 */
export const DEFAULT_CLOUD_SYNC_PART_SIZE_BYTES = 2 * 1024 * 1024
/** 磁盘空间低于该阈值时，界面会展示容量告警。 */
export const LOW_DISK_SPACE_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024
/** 内置云同步服务的默认开发地址。 */
export const DEFAULT_CLOUD_SYNC_SERVER_URL = 'http://127.0.0.1:8787'
/** 云同步上传与重试流程使用的退避时间表。 */
export const CLOUD_SYNC_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000]

const MAIN_ENTRY_DIR = dirname(fileURLToPath(import.meta.url))
const PRELOAD_ENTRY_PATH = join(MAIN_ENTRY_DIR, '../preload/index.js')
const RENDERER_ENTRY_PATH = join(MAIN_ENTRY_DIR, '../renderer/index.html')

/** 返回录屏输出根目录。 */
export function getRecordingsDirectoryPath() {
  return join(app.getPath('downloads'), 'Recording')
}

/** 判断一个路径是否位于录屏输出目录内。 */
export function isRecordingFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return false
  }

  const recordingsRoot = `${resolve(getRecordingsDirectoryPath())}${sep}`
  const targetPath = resolve(filePath)
  return `${targetPath}${sep}`.startsWith(recordingsRoot)
}

/** 将时间戳格式化为适合文件命名的稳定文本。 */
export function formatTimestampForFileName(value = Date.now()) {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}${month}${day}-${hours}${minutes}${seconds}`
}

/** 生成最终录屏文件名。 */
export function createRecordingFileName(extension = 'webm') {
  const stamp = formatTimestampForFileName()
  return `${RECORDING_FILE_PREFIX}${stamp}.${extension}`
}

/** 生成新的录屏会话 id。 */
export function createRecordingSessionId() {
  const stamp = formatTimestampForFileName()
  const randomSuffix = Math.random().toString(36).slice(2, 8)
  return `session-${stamp}-${randomSuffix}`
}

/** 返回所有录屏会话临时目录的父目录。 */
export function getRecordingSessionsDirectoryPath() {
  return join(getRecordingsDirectoryPath(), RECORDING_SESSIONS_DIR_NAME)
}

/** 生成本地分段文件名。 */
export function createRecordingSegmentFileName(index, extension = 'webm') {
  const indexLabel = String(index).padStart(4, '0')
  return `segment-${indexLabel}.${extension}`
}

/** 生成云同步分片文件名。 */
export function createCloudSyncPartFileName(index) {
  const indexLabel = String(index).padStart(4, '0')
  return `part-${indexLabel}.bin`
}

/** 生成连续录制临时文件名。 */
export function createRecordingCaptureTempFileName(extension = 'webm') {
  return `capture.${extension}.part`
}

/** 根据 mime type 推断视频扩展名。 */
export function getVideoExtensionFromMimeType(mimeType = '') {
  const mime = typeof mimeType === 'string' ? mimeType.toLowerCase() : ''
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('ogg')) return 'ogv'
  return 'webm'
}

/** 根据扩展名反推 mime type。 */
export function getMimeTypeByExtension(extension = '') {
  const normalized = String(extension || '').toLowerCase()
  if (normalized === 'mp4') return 'video/mp4'
  if (normalized === 'ogv' || normalized === 'ogg') return 'video/ogg'
  return 'video/webm'
}

/** 根据视频路径推导对应的封面图路径。 */
export function getPosterPathByVideoPath(filePath) {
  const marker = filePath.lastIndexOf('.')
  if (marker <= 0) {
    return `${filePath}.${POSTER_FILE_EXTENSION}`
  }
  return `${filePath.slice(0, marker)}.${POSTER_FILE_EXTENSION}`
}

/** 将本地媒体路径转换为 renderer 可访问的 recording:// URL。 */
export function toRecordingMediaUrl(filePath) {
  return `${RECORDING_MEDIA_SCHEME}://media/${encodeURIComponent(filePath)}`
}

/** 解析 recording:// 请求地址并还原成真实文件路径。 */
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

/** 根据文件扩展名返回协议响应所需的 Content-Type。 */
function getMediaContentType(filePath) {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.ogv' || ext === '.ogg') return 'video/ogg'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  return 'application/octet-stream'
}

/** 解析 HTTP Range 头，支持播放器按字节范围读取。 */
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

/** 将 Electron 的桌面源对象映射成 renderer 友好的结构。 */
function mapCaptureSourceItem(source) {
  return {
    id: source.id,
    name: source.name,
    type: source.id.startsWith('screen:') ? 'screen' : 'window',
    displayId: source.display_id || '',
    thumbnailDataUrl: source.thumbnail?.isEmpty?.() ? '' : source.thumbnail.toDataURL()
  }
}

/** 获取当前可供录制的屏幕和窗口源列表。 */
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

/** 读取系统层面的屏幕采集权限状态。 */
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

/** 打开系统隐私设置中的屏幕录制授权页。 */
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

/** 根据偏好 id 从桌面源列表中选出最终录制源。 */
export function resolvePreferredDisplaySource(sources, preferredDisplaySourceId = '') {
  return (
    sources.find((source) => source.id === preferredDisplaySourceId) ||
    sources.find((source) => source.id.startsWith('screen:')) ||
    sources[0] ||
    null
  )
}

/** 创建主应用窗口。 */
export function createMainWindow({ iconPath } = {}) {
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
      preload: PRELOAD_ENTRY_PATH,
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
    window.loadFile(RENDERER_ENTRY_PATH)
  }

  return window
}

/** 注册 recording:// 媒体协议，用于安全暴露本地录屏文件。 */
export function registerRecordingMediaProtocol() {
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

/** 创建独立的录屏播放窗口。 */
export function createRecordingPlayerWindow({ filePath }) {
  const playerWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 720,
    minHeight: 460,
    autoHideMenuBar: true,
    title: `录制回放 - ${filePath.split(sep).pop() || ''}`,
    webPreferences: {
      preload: PRELOAD_ENTRY_PATH,
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
    playerWindow.loadFile(RENDERER_ENTRY_PATH, {
      query: {
        player: videoUrl,
        name: displayName
      }
    })
  }
  return playerWindow
}

/** 创建独立的录屏剪辑窗口。 */
export function createRecordingEditorWindow({ filePath }) {
  const editorWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    autoHideMenuBar: true,
    title: `视频剪辑 - ${filePath.split(sep).pop() || ''}`,
    backgroundColor: '#0a0d14',
    webPreferences: {
      preload: PRELOAD_ENTRY_PATH,
      sandbox: false
    }
  })

  const videoUrl = toRecordingMediaUrl(filePath)
  const displayName = filePath.split(sep).pop() || ''

  editorWindow.webContents.on('did-fail-load', (_, errorCode, errorDescription) => {
    console.warn('[recording] editor window failed to load:', errorCode, errorDescription)
  })

  editorWindow.webContents.on('console-message', (_, level, message) => {
    if (level >= 2) {
      console.warn('[recording] editor console:', message)
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL']
    const query = new URLSearchParams({
      editor: videoUrl,
      name: displayName
    }).toString()
    editorWindow.loadURL(`${base}?${query}`)
  } else {
    editorWindow.loadFile(RENDERER_ENTRY_PATH, {
      query: {
        editor: videoUrl,
        name: displayName
      }
    })
  }

  return editorWindow
}

/** 执行一次 ffmpeg 命令，并在失败时抛出带上下文的错误。 */
export async function runFfmpeg(args) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg binary is not available.')
  }

  await new Promise((resolveCallback, rejectCallback) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    })

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', (error) => {
      rejectCallback(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolveCallback()
        return
      }

      const tail = stderr.trim().split('\n').slice(-5).join('\n')
      rejectCallback(new Error(tail || `ffmpeg exited with code ${code}`))
    })
  })
}

/** 读取视频时长，无法探测时返回 null。 */
export async function probeVideoDurationSec(filePath) {
  if (!ffmpegPath || !filePath || !existsSync(filePath)) {
    return null
  }

  return await new Promise((resolveCallback) => {
    const child = spawn(ffmpegPath, ['-i', filePath], {
      stdio: ['ignore', 'ignore', 'pipe']
    })

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', () => {
      resolveCallback(null)
    })

    child.on('close', () => {
      const matched = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
      if (!matched) {
        resolveCallback(null)
        return
      }

      const [, hoursRaw, minutesRaw, secondsRaw] = matched
      const totalSeconds =
        Number(hoursRaw) * 3600 + Number(minutesRaw) * 60 + Number.parseFloat(secondsRaw)

      if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
        resolveCallback(null)
        return
      }

      resolveCallback(totalSeconds)
    })
  })
}

/** 递归列出会话目录中的所有残留文件，供清理失败时诊断。 */
export async function listSessionArtifactPaths(sessionDir) {
  if (!sessionDir || !existsSync(sessionDir)) {
    return []
  }

  const entries = await readdir(sessionDir, { withFileTypes: true }).catch(() => [])
  const filePaths = []

  for (const entry of entries) {
    const entryPath = join(sessionDir, entry.name)
    if (entry.isDirectory()) {
      filePaths.push(...(await listSessionArtifactPaths(entryPath)))
      continue
    }

    filePaths.push(entryPath)
  }

  return filePaths
}

/** 计算文件内容的 SHA-256 值，用于云同步校验。 */
export async function sha256File(filePath) {
  const buffer = await readFile(filePath)
  return createHash('sha256').update(buffer).digest('hex')
}
