/** 文件作用：集中提供录屏相关的路径规则、主进程媒体能力、协议访问和底层工具。 */
import ffmpegPath from 'ffmpeg-static'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, desktopCapturer, protocol, shell, systemPreferences } from 'electron'
import { createReadStream, existsSync } from 'fs'
import { chmod, mkdir, readFile, readdir, stat } from 'fs/promises'
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
let resolvedFfmpegPath = ''

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

/** 生成剪辑导出文件名。 */
export function createRecordingCutFileName(extension = 'webm') {
  const stamp = formatTimestampForFileName()
  return `cut-${stamp}.${extension}`
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
      sandbox: false,
      webSecurity: false
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
export function registerRecordingMediaProtocolScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RECORDING_MEDIA_SCHEME,
      privileges: {
        secure: true,
        standard: true,
        stream: true,
        supportFetchAPI: true
      }
    }
  ])
}

/** 注册 recording:// 媒体请求处理器，用于安全暴露本地录屏文件。 */
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
      sandbox: false,
      webSecurity: false
    }
  })

  const videoUrl = toRecordingMediaUrl(filePath)
  const fileUrl = pathToFileURL(filePath).toString()
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
      fileUrl,
      path: filePath,
      name: displayName
    }).toString()
    editorWindow.loadURL(`${base}?${query}`)
  } else {
    editorWindow.loadFile(RENDERER_ENTRY_PATH, {
      query: {
        editor: videoUrl,
        fileUrl,
        path: filePath,
        name: displayName
      }
    })
  }

  return editorWindow
}

async function canRunFfmpeg(candidatePath) {
  if (!candidatePath) {
    return false
  }

  if (candidatePath.includes(sep) && !existsSync(candidatePath)) {
    return false
  }

  if (process.platform !== 'win32' && candidatePath.includes(sep)) {
    try {
      const fileStat = await stat(candidatePath)
      if ((fileStat.mode & 0o111) === 0) {
        await chmod(candidatePath, fileStat.mode | 0o755)
      }
    } catch {
      return false
    }
  }

  return await new Promise((resolveCallback) => {
    const child = spawn(candidatePath, ['-version'], {
      stdio: 'ignore'
    })
    const timer = setTimeout(() => {
      child.kill()
      resolveCallback(false)
    }, 3000)

    child.on('error', () => {
      clearTimeout(timer)
      resolveCallback(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveCallback(code === 0)
    })
  })
}

/** 返回当前应用依赖内置的 ffmpeg，不能依赖系统路径以保证 Electron 跨平台分发。 */
async function resolveFfmpegExecutable() {
  if (resolvedFfmpegPath) {
    return resolvedFfmpegPath
  }

  if (await canRunFfmpeg(ffmpegPath)) {
    resolvedFfmpegPath = ffmpegPath
    return resolvedFfmpegPath
  }

  throw new Error(
    `Bundled ffmpeg binary is not runnable for ${process.platform}/${process.arch}. Reinstall ffmpeg-static for the target platform.`
  )
}

function parseFfmpegProgressSeconds(value) {
  const matches = [...String(value || '').matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)]
  const lastMatch = matches.at(-1)
  if (!lastMatch) {
    return null
  }

  const [, hoursRaw, minutesRaw, secondsRaw] = lastMatch
  const seconds = Number(hoursRaw) * 3600 + Number(minutesRaw) * 60 + Number.parseFloat(secondsRaw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

/** 执行一次 ffmpeg 命令，并在失败时抛出带上下文的错误。 */
export async function runFfmpeg(args, { durationSec = 0, onProgress } = {}) {
  const executablePath = await resolveFfmpegExecutable()

  await new Promise((resolveCallback, rejectCallback) => {
    const child = spawn(executablePath, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    })

    let stderr = ''
    let lastProgress = 0
    const emitProgress = (seconds) => {
      if (!(durationSec > 0) || typeof onProgress !== 'function') {
        return
      }

      const progress = clampNumber(seconds / durationSec, 0, 0.99, 0)
      if (progress <= lastProgress + 0.002) {
        return
      }

      lastProgress = progress
      onProgress(progress)
    }

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      const progressSeconds =
        parseFfmpegProgressSeconds(text) || parseFfmpegProgressSeconds(stderr.slice(-2000))
      if (progressSeconds !== null) {
        emitProgress(progressSeconds)
      }
    })

    child.on('error', (error) => {
      rejectCallback(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        if (typeof onProgress === 'function') {
          onProgress(1)
        }
        resolveCallback()
        return
      }

      const tail = stderr.trim().split('\n').slice(-5).join('\n')
      rejectCallback(new Error(tail || `ffmpeg exited with code ${code}`))
    })
  })
}

/** 执行 ffmpeg 并读取 stdout buffer。 */
async function runFfmpegBuffer(args) {
  const executablePath = await resolveFfmpegExecutable()

  return await new Promise((resolveCallback, rejectCallback) => {
    const child = spawn(executablePath, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const stdoutChunks = []
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(chunk)
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', (error) => {
      rejectCallback(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolveCallback(Buffer.concat(stdoutChunks))
        return
      }

      const tail = stderr.trim().split('\n').slice(-5).join('\n')
      rejectCallback(new Error(tail || `ffmpeg exited with code ${code}`))
    })
  })
}

function roundFilterNumber(value, fallback = 0) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return fallback
  }

  return Math.round(number * 1000) / 1000
}

function makeEvenDimension(value, fallback) {
  const number = Math.trunc(Number(value) || fallback)
  const safeNumber = Math.max(2, number)
  return safeNumber % 2 === 0 ? safeNumber : safeNumber - 1
}

function clampNumber(value, min, max, fallback = min) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return fallback
  }

  return Math.min(Math.max(number, min), max)
}

function getFilterColor(value, alpha = 1) {
  const color = typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'
  return `0x${color.slice(1)}@${clampNumber(alpha, 0, 1, 1)}`
}

function escapeDrawText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, '\\n')
}

function escapeFilterExpression(value) {
  return String(value).replace(/,/g, '\\,')
}

async function probeMediaDetails(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return { durationSec: null, hasAudio: false, hasVideo: false, height: 0, width: 0 }
  }

  let executablePath = ''
  try {
    executablePath = await resolveFfmpegExecutable()
  } catch {
    return { durationSec: null, hasAudio: false, hasVideo: false, height: 0, width: 0 }
  }

  return await new Promise((resolveCallback) => {
    const child = spawn(executablePath, ['-i', filePath], {
      stdio: ['ignore', 'ignore', 'pipe']
    })

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', () => {
      resolveCallback({ durationSec: null, hasAudio: false, hasVideo: false, height: 0, width: 0 })
    })

    child.on('close', () => {
      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
      const videoLine = stderr
        .split('\n')
        .find((line) => /Video:/.test(line) && /,\s*\d+x\d+/.test(line))
      const sizeMatch = videoLine?.match(/,\s*(\d+)x(\d+)[,\s]/)
      const durationSec = durationMatch
        ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
        : null

      resolveCallback({
        durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
        hasAudio: /Audio:/.test(stderr),
        hasVideo: /Video:/.test(stderr),
        height: sizeMatch ? Number(sizeMatch[2]) : 0,
        width: sizeMatch ? Number(sizeMatch[1]) : 0
      })
    })
  })
}

/** 使用 ffmpeg 从录屏里抽取时间线缩略图。 */
export async function extractRecordingThumbnails({
  filePath,
  times = [],
  width = 160,
  height = 90
}) {
  if (!isRecordingFilePath(filePath) || !existsSync(filePath)) {
    throw new Error('Invalid recording path.')
  }

  const safeWidth = Math.max(48, Math.min(360, Math.trunc(Number(width) || 160)))
  const safeHeight = Math.max(32, Math.min(240, Math.trunc(Number(height) || 90)))
  const safeTimes = (Array.isArray(times) ? times : [])
    .map((time) => Math.max(0, Number(time) || 0))
    .slice(0, 24)
  const thumbnails = []

  for (const time of safeTimes) {
    const buffer = await runFfmpegBuffer([
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(time),
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${safeWidth}:${safeHeight}:force_original_aspect_ratio=increase,crop=${safeWidth}:${safeHeight}`,
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      'pipe:1'
    ])

    thumbnails.push({
      time,
      dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`
    })
  }

  return thumbnails
}

/** 使用 ffmpeg 按剪辑时间线导出录屏视频。 */
export async function exportRecordingCut({ filePath, clips = [], output = {}, onProgress }) {
  if (!isRecordingFilePath(filePath) || !existsSync(filePath)) {
    throw new Error('Invalid recording path.')
  }

  const safeClips = (Array.isArray(clips) ? clips : [])
    .map((clip) => {
      const kind = String(clip?.kind || 'video')
      const sourcePath =
        typeof clip?.sourcePath === 'string' && clip.sourcePath.trim()
          ? resolve(clip.sourcePath)
          : kind === 'video'
            ? filePath
            : ''
      const startTime = Math.max(0, Number(clip?.startTime) || 0)
      const sourceStart = Math.max(0, Number(clip?.sourceStart) || 0)
      const duration = Math.max(0, Number(clip?.duration) || 0)
      return {
        align: String(clip?.align || 'center'),
        backgroundAlpha: clampNumber(clip?.backgroundAlpha, 0, 1, 0.58),
        backgroundColor: clip?.backgroundColor,
        color: clip?.color,
        duration,
        fontFamily: String(clip?.fontFamily || ''),
        fontSize: clampNumber(clip?.fontSize, 8, 160, 22),
        fontWeight: String(clip?.fontWeight || '800'),
        kind,
        label: String(clip?.label || ''),
        lineHeight: clampNumber(clip?.lineHeight, 0.8, 3, 1.2),
        muted: Boolean(clip?.muted),
        opacity: clampNumber(clip?.opacity, 0, 1, 1),
        scale: clampNumber(clip?.scale, 1, 100, 28),
        shadowBlur: clampNumber(clip?.shadowBlur, 0, 80, 8),
        shadowColor: clip?.shadowColor,
        shadowDistance: clampNumber(clip?.shadowDistance, 0, 80, 2),
        sourcePath,
        sourceStart,
        sourceEnd: sourceStart + duration,
        startTime,
        strokeColor: clip?.strokeColor,
        strokeWidth: clampNumber(clip?.strokeWidth, 0, 40, 0),
        transitionSeconds: clampNumber(clip?.transitionSeconds, 0, 5, 0),
        transitionType: String(clip?.transitionType || 'none'),
        volume: clampNumber(clip?.volume, 0, 2, 1),
        x: clampNumber(clip?.x, 0, 100, 50),
        y: clampNumber(clip?.y, 0, 100, kind === 'text' ? 84 : 50)
      }
    })
    .filter((clip) => clip.duration >= 0.1 && (clip.kind === 'text' || existsSync(clip.sourcePath)))
    .slice(0, 160)

  const sourceVideoClips = safeClips
    .filter((clip) => clip.kind === 'video' && clip.sourcePath)
    .sort((a, b) => a.startTime - b.startTime)
  const sourceAudioClips = safeClips.filter((clip) => clip.kind === 'audio' && clip.sourcePath)
  const sourceImageClips = safeClips.filter((clip) => clip.kind === 'image' && clip.sourcePath)
  const textClips = safeClips.filter((clip) => clip.kind === 'text' && clip.label.trim())
  const timelineDuration = Math.max(
    0.2,
    Number(output?.duration) || 0,
    ...safeClips.map((clip) => clip.startTime + clip.duration)
  )

  if (!sourceVideoClips.length) {
    throw new Error('No clips to export.')
  }

  const primaryDetails = await probeMediaDetails(filePath)
  const width = makeEvenDimension(output?.width, primaryDetails.width || 1280)
  const height = makeEvenDimension(output?.height, primaryDetails.height || 720)
  const bitrate = Math.max(300_000, Math.min(30_000_000, Math.trunc(Number(output?.bitrate) || 0)))
  const fps = Math.max(1, Math.min(60, Math.trunc(Number(output?.fps) || 30)))
  const outputFilePath = join(getRecordingsDirectoryPath(), createRecordingCutFileName('webm'))
  const inputSources = []
  const inputSourceMap = new Map()

  function addInputSource(role, sourcePath) {
    const key = `${role}:${sourcePath}`
    const existing = inputSourceMap.get(key)
    if (existing) {
      return existing
    }

    const source = {
      index: inputSources.length,
      role,
      sourcePath
    }
    inputSourceMap.set(key, source)
    inputSources.push(source)
    return source
  }

  const videoClips = sourceVideoClips.map((clip) => ({
    ...clip,
    inputSource: addInputSource('media', clip.sourcePath)
  }))
  const audioClips = sourceAudioClips.map((clip) => ({
    ...clip,
    inputSource: addInputSource('media', clip.sourcePath)
  }))
  const imageClips = sourceImageClips.map((clip) => ({
    ...clip,
    inputSource: addInputSource('image', clip.sourcePath)
  }))

  await Promise.all(
    inputSources.map(async (source) => {
      source.details =
        source.role === 'image'
          ? { durationSec: null, hasAudio: false, hasVideo: false, height: 0, width: 0 }
          : await probeMediaDetails(source.sourcePath)
    })
  )

  const inputArgs = inputSources.flatMap((source) =>
    source.role === 'image'
      ? ['-loop', '1', '-t', String(roundFilterNumber(timelineDuration)), '-i', source.sourcePath]
      : ['-i', source.sourcePath]
  )
  const filters = [
    `color=c=black:s=${width}x${height}:d=${roundFilterNumber(timelineDuration)}:r=${fps}[vbase0]`
  ]
  let videoChain = 'vbase0'
  let videoChainIndex = 0

  videoClips.forEach((clip, index) => {
    const start = roundFilterNumber(clip.startTime)
    const duration = roundFilterNumber(clip.duration)
    const sourceStart = roundFilterNumber(clip.sourceStart)
    const inputIndex = clip.inputSource.index
    const clipLabel = `vclip${index}`
    const nextChain = `vbase${index + 1}`
    filters.push(
      `[${inputIndex}:v]trim=start=${sourceStart}:duration=${duration},setpts=PTS-STARTPTS+${start}/TB,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuva420p[${clipLabel}]`
    )
    filters.push(
      `[${videoChain}][${clipLabel}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:shortest=0[${nextChain}]`
    )
    videoChain = nextChain
    videoChainIndex = index + 1
  })

  imageClips.forEach((clip, index) => {
    const start = roundFilterNumber(clip.startTime)
    const duration = roundFilterNumber(clip.duration)
    const transitionSeconds =
      clip.transitionType === 'none' ? 0 : Math.min(clip.transitionSeconds, duration / 2)
    const imageWidth = makeEvenDimension((width * clip.scale) / 100, Math.round(width * 0.28))
    const clipLabel = `imgclip${index}`
    const nextChain = `vimage${index + 1}`
    const fadeFilters =
      transitionSeconds > 0
        ? `,fade=t=in:st=0:d=${roundFilterNumber(transitionSeconds)}:alpha=1,fade=t=out:st=${roundFilterNumber(
            Math.max(0, duration - transitionSeconds)
          )}:d=${roundFilterNumber(transitionSeconds)}:alpha=1`
        : ''
    filters.push(
      `[${clip.inputSource.index}:v]trim=duration=${duration},setpts=PTS-STARTPTS,scale=${imageWidth}:-1,format=rgba,colorchannelmixer=aa=${clip.opacity}${fadeFilters},setpts=PTS-STARTPTS+${start}/TB[${clipLabel}]`
    )
    filters.push(
      `[${videoChain}][${clipLabel}]overlay=x=main_w*${clip.x / 100}-overlay_w/2:y=main_h*${clip.y / 100}-overlay_h/2:eof_action=pass:repeatlast=0:shortest=0[${nextChain}]`
    )
    videoChain = nextChain
    videoChainIndex += 1
  })

  textClips.forEach((clip, index) => {
    const start = roundFilterNumber(clip.startTime)
    const end = roundFilterNumber(clip.startTime + clip.duration)
    const duration = roundFilterNumber(clip.duration)
    const transitionSeconds =
      clip.transitionType === 'none' ? 0 : Math.min(clip.transitionSeconds, duration / 2)
    const alphaExpression =
      transitionSeconds > 0
        ? `:alpha='${escapeFilterExpression(
            `if(lt(t,${roundFilterNumber(start + transitionSeconds)}),max(0,min(1,(t-${start})/${roundFilterNumber(
              transitionSeconds
            )})),if(gt(t,${roundFilterNumber(end - transitionSeconds)}),max(0,min(1,(${end}-t)/${roundFilterNumber(
              transitionSeconds
            )})),1))`
          )}'`
        : ''
    const nextChain = `vtext${index + 1}`
    const fontColor = getFilterColor(clip.color, clip.opacity)
    const boxColor = getFilterColor(clip.backgroundColor || '#000000', clip.backgroundAlpha)
    const strokeColor = getFilterColor(clip.strokeColor || '#000000', 1)
    const shadowColor = getFilterColor(clip.shadowColor || '#000000', 1)
    filters.push(
      `[${videoChain}]drawtext=text='${escapeDrawText(clip.label)}':fontcolor=${fontColor}:fontsize=${Math.round(
        clip.fontSize
      )}:line_spacing=${Math.round(clip.fontSize * (clip.lineHeight - 1))}:x=w*${clip.x / 100}-text_w/2:y=h*${
        clip.y / 100
      }-text_h/2:box=1:boxcolor=${boxColor}:boxborderw=14:borderw=${roundFilterNumber(
        clip.strokeWidth
      )}:bordercolor=${strokeColor}:shadowcolor=${shadowColor}:shadowx=${roundFilterNumber(
        clip.shadowDistance
      )}:shadowy=${roundFilterNumber(clip.shadowDistance)}:enable='between(t\\,${start}\\,${end})'${alphaExpression}[${nextChain}]`
    )
    videoChain = nextChain
    videoChainIndex += 1
  })

  const audioLabels = []
  let audioIndex = 0
  for (const clip of videoClips) {
    if (clip.muted || !clip.inputSource.details?.hasAudio) {
      continue
    }

    const label = `aclip${audioIndex}`
    const delayMs = Math.round(clip.startTime * 1000)
    filters.push(
      `[${clip.inputSource.index}:a]atrim=start=${roundFilterNumber(clip.sourceStart)}:duration=${roundFilterNumber(
        clip.duration
      )},asetpts=PTS-STARTPTS,volume=${roundFilterNumber(clip.volume, 1)},adelay=${delayMs}:all=1[${label}]`
    )
    audioLabels.push(`[${label}]`)
    audioIndex += 1
  }
  for (const clip of audioClips) {
    if (clip.muted || !clip.inputSource.details?.hasAudio) {
      continue
    }

    const label = `aclip${audioIndex}`
    const delayMs = Math.round(clip.startTime * 1000)
    filters.push(
      `[${clip.inputSource.index}:a]atrim=start=${roundFilterNumber(clip.sourceStart)}:duration=${roundFilterNumber(
        clip.duration
      )},asetpts=PTS-STARTPTS,volume=${roundFilterNumber(clip.volume, 1)},adelay=${delayMs}:all=1[${label}]`
    )
    audioLabels.push(`[${label}]`)
    audioIndex += 1
  }

  const outputVideoLabel = videoChainIndex > 0 ? videoChain : 'vbase0'
  filters.push(`[${outputVideoLabel}]format=yuv420p,fps=${fps}[outv]`)
  if (audioLabels.length) {
    filters.push(
      `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0,atrim=duration=${roundFilterNumber(
        timelineDuration
      )},asetpts=PTS-STARTPTS[aout]`
    )
  }

  const filterComplex = filters.join(';')

  await mkdir(dirname(outputFilePath), { recursive: true })
  await runFfmpeg(
    [
      '-y',
      '-hide_banner',
      ...inputArgs,
      '-filter_complex',
      filterComplex,
      '-map',
      '[outv]',
      ...(audioLabels.length ? ['-map', '[aout]'] : ['-an']),
      '-c:v',
      'libvpx-vp9',
      '-b:v',
      bitrate ? String(bitrate) : '4M',
      '-row-mt',
      '1',
      '-deadline',
      'realtime',
      '-cpu-used',
      '4',
      ...(audioLabels.length ? ['-c:a', 'libopus', '-b:a', '128k'] : []),
      '-t',
      String(roundFilterNumber(timelineDuration)),
      outputFilePath
    ],
    { durationSec: timelineDuration, onProgress }
  )

  return outputFilePath
}

/** 读取视频时长，无法探测时返回 null。 */
export async function probeVideoDurationSec(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return null
  }

  let executablePath = ''
  try {
    executablePath = await resolveFfmpegExecutable()
  } catch {
    return null
  }

  return await new Promise((resolveCallback) => {
    const child = spawn(executablePath, ['-i', filePath], {
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
      if (matched) {
        const [, hoursRaw, minutesRaw, secondsRaw] = matched
        const totalSeconds =
          Number(hoursRaw) * 3600 + Number(minutesRaw) * 60 + Number.parseFloat(secondsRaw)

        if (Number.isFinite(totalSeconds) && totalSeconds > 0) {
          resolveCallback(totalSeconds)
          return
        }
      }

      probeVideoDurationByDecoding(filePath, executablePath).then(resolveCallback)
    })
  })
}

/** WebM 可能没有容器时长，必要时解码到 null 输出并读取最后的 time= 进度。 */
async function probeVideoDurationByDecoding(filePath, executablePath) {
  return await new Promise((resolveCallback) => {
    const child = spawn(
      executablePath,
      ['-hide_banner', '-nostdin', '-i', filePath, '-map', '0:v:0', '-f', 'null', '-'],
      {
        stdio: ['ignore', 'ignore', 'pipe']
      }
    )

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', () => {
      resolveCallback(null)
    })

    child.on('close', () => {
      const matches = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)]
      const lastMatch = matches.at(-1)
      if (!lastMatch) {
        resolveCallback(null)
        return
      }

      const [, hoursRaw, minutesRaw, secondsRaw] = lastMatch
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
