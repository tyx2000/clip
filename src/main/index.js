import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  protocol,
  session,
  shell,
  systemPreferences
} from 'electron'
import { createReadStream, createWriteStream, existsSync } from 'fs'
import ffmpegPath from 'ffmpeg-static'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  statfs,
  unlink,
  writeFile
} from 'fs/promises'
import { dirname, extname, join, resolve, sep } from 'path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'url'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

const VIDEO_FILE_EXTENSIONS = new Set(['webm', 'mp4', 'ogv'])
const RECORDING_FILE_PREFIX = 'screen-recording-'
const POSTER_FILE_EXTENSION = 'jpg'
const RECORDING_MEDIA_SCHEME = 'recording'
const RECORDING_SESSIONS_DIR_NAME = 'sessions'
const RECORDING_SESSION_MANIFEST_FILE_NAME = 'manifest.json'
const DEFAULT_SEGMENT_DURATION_MS = 5 * 1000
const MIN_SEGMENT_DURATION_MS = 1 * 1000
const LOW_DISK_SPACE_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024
let preferredDisplaySourceId = ''
const activeRecordingSessions = new Map()

protocol.registerSchemesAsPrivileged([
  {
    scheme: RECORDING_MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
])

function getRecordingsDirectoryPath() {
  return join(app.getPath('downloads'), 'Recording')
}

function createRecordingFileName(extension = 'webm') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${RECORDING_FILE_PREFIX}${stamp}.${extension}`
}

function createRecordingSessionId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const randomSuffix = Math.random().toString(36).slice(2, 8)
  return `session-${stamp}-${randomSuffix}`
}

function getRecordingSessionsDirectoryPath() {
  return join(getRecordingsDirectoryPath(), RECORDING_SESSIONS_DIR_NAME)
}

function createRecordingSegmentFileName(index, extension = 'webm') {
  const indexLabel = String(index).padStart(4, '0')
  return `segment-${indexLabel}.${extension}`
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

function parseChunkPayloadToBuffer(payload = {}) {
  if (Buffer.isBuffer(payload?.chunk)) {
    return payload.chunk
  }

  if (payload?.chunk instanceof Uint8Array) {
    return Buffer.from(payload.chunk)
  }

  if (payload?.chunk instanceof ArrayBuffer) {
    return Buffer.from(payload.chunk)
  }

  if (ArrayBuffer.isView(payload?.chunk)) {
    return Buffer.from(payload.chunk.buffer, payload.chunk.byteOffset, payload.chunk.byteLength)
  }

  if (typeof payload?.chunkBase64 === 'string' && payload.chunkBase64.trim()) {
    return Buffer.from(payload.chunkBase64, 'base64')
  }

  const parsed = parseDataUrl(payload?.dataUrl || '')
  return parsed?.buffer || null
}

function normalizeSegmentDurationMs(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < MIN_SEGMENT_DURATION_MS) {
    return DEFAULT_SEGMENT_DURATION_MS
  }
  return Math.floor(parsed)
}

function createRecordingSessionManifest({
  sessionId,
  sessionDir,
  extension,
  mimeType,
  segmentDurationMs
}) {
  const now = Date.now()
  return {
    version: 1,
    sessionId,
    sessionDir,
    extension,
    mimeType,
    segmentDurationMs,
    status: 'recording',
    startedAt: now,
    stoppedAt: null,
    updatedAt: now,
    totalBytes: 0,
    output: null,
    segments: []
  }
}

async function persistRecordingSessionManifest(runtimeSession) {
  runtimeSession.manifest.updatedAt = Date.now()
  const tempPath = `${runtimeSession.manifestPath}.tmp`
  const content = JSON.stringify(runtimeSession.manifest, null, 2)
  await writeFile(tempPath, content, 'utf8')
  await rename(tempPath, runtimeSession.manifestPath)
}

function getRecordingSessionSummary(runtimeSession) {
  const currentSegment = runtimeSession.currentSegment
  return {
    sessionId: runtimeSession.id,
    status: runtimeSession.manifest.status,
    sessionDir: runtimeSession.dir,
    manifestPath: runtimeSession.manifestPath,
    segmentDurationMs: runtimeSession.manifest.segmentDurationMs,
    segmentCount: runtimeSession.manifest.segments.length,
    currentSegmentIndex: currentSegment?.index || null,
    currentSegmentBytes: currentSegment?.bytes || 0,
    totalBytes: runtimeSession.manifest.totalBytes,
    startedAt: runtimeSession.manifest.startedAt,
    stoppedAt: runtimeSession.manifest.stoppedAt,
    output: runtimeSession.manifest.output
  }
}

async function getRecordingStorageSnapshot() {
  try {
    const recordingsDir = getRecordingsDirectoryPath()
    await mkdir(recordingsDir, { recursive: true })
    const stats = await statfs(recordingsDir)
    const blockSize = Number(stats.bsize || 0)
    const availableBlocks = Number(stats.bavail || 0)
    const freeBytes = blockSize > 0 && availableBlocks > 0 ? blockSize * availableBlocks : 0

    return {
      ok: true,
      freeBytes,
      lowDiskSpace: freeBytes > 0 && freeBytes <= LOW_DISK_SPACE_THRESHOLD_BYTES
    }
  } catch {
    return {
      ok: false,
      freeBytes: 0,
      lowDiskSpace: false
    }
  }
}

async function getRecordingSessionStatus(runtimeSession) {
  const storage = await getRecordingStorageSnapshot()
  return {
    ...getRecordingSessionSummary(runtimeSession),
    storage
  }
}

function createRuntimeSessionFromManifest(manifest, manifestPath) {
  return {
    id: manifest.sessionId,
    dir: manifest.sessionDir,
    manifestPath,
    writeQueue: Promise.resolve(),
    writeStream: null,
    currentSegment: null,
    manifest
  }
}

async function readRecordingSessionManifest(manifestPath) {
  const content = await readFile(manifestPath, 'utf8')
  const parsed = JSON.parse(content)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid recording session manifest.')
  }

  return parsed
}

async function runFfmpeg(args) {
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

async function mergeRecordingSession(runtimeSession) {
  const readySegments = runtimeSession.manifest.segments.filter(
    (segment) => segment.status === 'ready'
  )
  if (!readySegments.length) {
    throw new Error('No completed recording segments available for merge.')
  }

  const outputFilePath = join(
    getRecordingsDirectoryPath(),
    createRecordingFileName(runtimeSession.manifest.extension)
  )
  await mkdir(dirname(outputFilePath), { recursive: true })

  if (readySegments.length === 1) {
    await copyFile(readySegments[0].path, outputFilePath)
  } else {
    const concatListPath = join(runtimeSession.dir, 'concat-inputs.txt')
    const concatListContent = readySegments
      .map((segment) => `file '${segment.path.replaceAll("'", "'\\''")}'`)
      .join('\n')
    await writeFile(concatListPath, concatListContent, 'utf8')

    try {
      await runFfmpeg([
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatListPath,
        '-c',
        'copy',
        outputFilePath
      ])
    } finally {
      if (existsSync(concatListPath)) {
        await unlink(concatListPath).catch(() => {})
      }
    }
  }

  const outputStat = await stat(outputFilePath)
  runtimeSession.manifest.output = {
    path: outputFilePath,
    status: 'ready',
    bytes: Number(outputStat.size || 0),
    createdAt: Number(outputStat.birthtimeMs || outputStat.mtimeMs || Date.now())
  }
  await persistRecordingSessionManifest(runtimeSession)

  return {
    item: buildRecordingItem(outputFilePath, outputStat),
    outputPath: outputFilePath
  }
}

async function normalizeRecoveredRecordingSession(runtimeSession) {
  let manifestChanged = false
  const now = Date.now()

  for (const segment of runtimeSession.manifest.segments) {
    if (segment?.status === 'ready' && existsSync(segment.path)) {
      const fileStat = await stat(segment.path)
      segment.bytes = Number(fileStat.size || segment.bytes || 0)
      segment.endedAt = Number(segment.endedAt || fileStat.mtimeMs || now)
      continue
    }

    if (segment?.status !== 'writing') {
      continue
    }

    if (existsSync(segment.path)) {
      const fileStat = await stat(segment.path)
      segment.status = 'ready'
      segment.bytes = Number(fileStat.size || 0)
      segment.endedAt = Number(fileStat.mtimeMs || now)
      manifestChanged = true
      continue
    }

    const partialPath = `${segment.path}.part`
    if (existsSync(partialPath)) {
      const fileStat = await stat(partialPath)
      segment.status = 'interrupted'
      segment.bytes = Number(fileStat.size || segment.bytes || 0)
      segment.endedAt = Number(fileStat.mtimeMs || now)
      segment.partialPath = partialPath
      manifestChanged = true
      continue
    }

    segment.status = 'missing'
    segment.endedAt = Number(segment.endedAt || now)
    manifestChanged = true
  }

  if (runtimeSession.manifest.status === 'recording') {
    runtimeSession.manifest.status = 'interrupted'
    runtimeSession.manifest.stoppedAt = runtimeSession.manifest.stoppedAt || now
    manifestChanged = true
  }

  if (manifestChanged) {
    await persistRecordingSessionManifest(runtimeSession)
  }
}

function shouldRecoverRecordingSession(runtimeSession) {
  const outputPath = runtimeSession.manifest.output?.path || ''
  const outputReady =
    runtimeSession.manifest.output?.status === 'ready' && outputPath && existsSync(outputPath)
  if (outputReady) {
    return false
  }

  return runtimeSession.manifest.segments.some((segment) => segment.status === 'ready')
}

async function recoverPendingRecordingSessions() {
  const sessionsDir = getRecordingSessionsDirectoryPath()
  await mkdir(sessionsDir, { recursive: true })

  const entries = await readdir(sessionsDir, { withFileTypes: true })
  const summary = {
    scanned: 0,
    recovered: 0,
    skipped: 0,
    failed: 0
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    summary.scanned += 1
    const manifestPath = join(sessionsDir, entry.name, RECORDING_SESSION_MANIFEST_FILE_NAME)
    if (!existsSync(manifestPath)) {
      summary.skipped += 1
      continue
    }

    let runtimeSession = null

    try {
      const manifest = await readRecordingSessionManifest(manifestPath)
      runtimeSession = createRuntimeSessionFromManifest(manifest, manifestPath)
      await normalizeRecoveredRecordingSession(runtimeSession)

      if (!shouldRecoverRecordingSession(runtimeSession)) {
        summary.skipped += 1
        continue
      }

      await mergeRecordingSession(runtimeSession)
      summary.recovered += 1
    } catch (error) {
      summary.failed += 1
      if (runtimeSession) {
        runtimeSession.manifest.output = {
          path: '',
          status: 'failed',
          bytes: 0,
          createdAt: 0,
          message: error instanceof Error ? error.message : 'Failed to recover recording session.'
        }
        await persistRecordingSessionManifest(runtimeSession).catch(() => {})
      }
      console.warn(
        '[recording] failed to recover session:',
        manifestPath,
        error instanceof Error ? error.message : error
      )
    }
  }

  return summary
}

async function openRecordingSessionSegment(runtimeSession, index) {
  const fileName = createRecordingSegmentFileName(index, runtimeSession.manifest.extension)
  const partFileName = `${fileName}.part`
  const partPath = join(runtimeSession.dir, partFileName)
  const finalPath = join(runtimeSession.dir, fileName)
  const startedAt = Date.now()

  runtimeSession.writeStream = createWriteStream(partPath, { flags: 'w' })
  runtimeSession.currentSegment = {
    index,
    fileName,
    partFileName,
    partPath,
    finalPath,
    startedAt,
    bytes: 0
  }

  runtimeSession.manifest.segments.push({
    index,
    fileName,
    path: finalPath,
    startedAt,
    endedAt: null,
    bytes: 0,
    status: 'writing'
  })

  await persistRecordingSessionManifest(runtimeSession)
}

async function finalizeCurrentRecordingSessionSegment(runtimeSession) {
  const currentSegment = runtimeSession.currentSegment
  const currentWriteStream = runtimeSession.writeStream

  if (!currentSegment || !currentWriteStream) {
    return
  }

  await new Promise((resolveCallback, rejectCallback) => {
    currentWriteStream.end((error) => {
      if (error) {
        rejectCallback(error)
        return
      }
      resolveCallback()
    })
  })

  await rename(currentSegment.partPath, currentSegment.finalPath)

  const segmentItem = runtimeSession.manifest.segments.find(
    (segment) => segment.index === currentSegment.index
  )
  if (segmentItem) {
    segmentItem.bytes = currentSegment.bytes
    segmentItem.endedAt = Date.now()
    segmentItem.status = 'ready'
  }

  runtimeSession.currentSegment = null
  runtimeSession.writeStream = null
  await persistRecordingSessionManifest(runtimeSession)
}

function getActiveRecordingSession(sessionId) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!normalizedSessionId) {
    return null
  }
  return activeRecordingSessions.get(normalizedSessionId) || null
}

async function enqueueRecordingSessionTask(runtimeSession, task) {
  runtimeSession.writeQueue = runtimeSession.writeQueue.then(task, task)
  return runtimeSession.writeQueue
}

async function createRecordingSession(payload = {}) {
  const sessionIdInput = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
  const sessionId = sessionIdInput || createRecordingSessionId()
  if (activeRecordingSessions.has(sessionId)) {
    throw new Error('Recording session is already active.')
  }

  const detectedMimeType =
    typeof payload?.mimeType === 'string' && payload.mimeType.trim()
      ? payload.mimeType
      : 'video/webm'
  const extension = getVideoExtensionFromMimeType(detectedMimeType)
  const segmentDurationMs = normalizeSegmentDurationMs(payload?.segmentDurationMs)
  const sessionDir = join(getRecordingSessionsDirectoryPath(), sessionId)
  const manifestPath = join(sessionDir, RECORDING_SESSION_MANIFEST_FILE_NAME)

  if (existsSync(sessionDir)) {
    throw new Error('Recording session directory already exists.')
  }

  await mkdir(sessionDir, { recursive: true })

  const runtimeSession = {
    id: sessionId,
    dir: sessionDir,
    manifestPath,
    writeQueue: Promise.resolve(),
    writeStream: null,
    currentSegment: null,
    manifest: createRecordingSessionManifest({
      sessionId,
      sessionDir,
      extension,
      mimeType: detectedMimeType,
      segmentDurationMs
    })
  }

  activeRecordingSessions.set(sessionId, runtimeSession)

  try {
    await openRecordingSessionSegment(runtimeSession, 1)
    return runtimeSession
  } catch (error) {
    activeRecordingSessions.delete(sessionId)
    throw error
  }
}

async function appendRecordingSessionChunk(payload = {}) {
  const runtimeSession = getActiveRecordingSession(payload?.sessionId)
  if (!runtimeSession) {
    throw new Error('Recording session not found.')
  }

  return enqueueRecordingSessionTask(runtimeSession, async () => {
    if (runtimeSession.manifest.status !== 'recording') {
      throw new Error('Recording session is not writable.')
    }

    const chunk = parseChunkPayloadToBuffer(payload)
    if (!chunk?.length) {
      throw new Error('Invalid recording chunk payload.')
    }

    const stream = runtimeSession.writeStream
    const currentSegment = runtimeSession.currentSegment
    if (!stream || !currentSegment) {
      throw new Error('Recording segment is not available.')
    }

    const canContinue = stream.write(chunk)
    if (!canContinue) {
      await once(stream, 'drain')
    }

    currentSegment.bytes += chunk.length
    runtimeSession.manifest.totalBytes += chunk.length

    const segmentItem = runtimeSession.manifest.segments.find(
      (segment) => segment.index === currentSegment.index
    )
    if (segmentItem) {
      segmentItem.bytes = currentSegment.bytes
    }

    await persistRecordingSessionManifest(runtimeSession)

    return {
      ok: true,
      bytesWritten: chunk.length,
      ...(await getRecordingSessionStatus(runtimeSession))
    }
  })
}

async function rotateRecordingSessionSegment(payload = {}) {
  const runtimeSession = getActiveRecordingSession(payload?.sessionId)
  if (!runtimeSession) {
    throw new Error('Recording session not found.')
  }

  return enqueueRecordingSessionTask(runtimeSession, async () => {
    if (runtimeSession.manifest.status !== 'recording') {
      throw new Error('Recording session is not recording.')
    }

    await finalizeCurrentRecordingSessionSegment(runtimeSession)
    const nextIndex = runtimeSession.manifest.segments.length + 1
    await openRecordingSessionSegment(runtimeSession, nextIndex)

    return {
      ok: true,
      ...(await getRecordingSessionStatus(runtimeSession))
    }
  })
}

async function stopRecordingSession(payload = {}) {
  const runtimeSession = getActiveRecordingSession(payload?.sessionId)
  if (!runtimeSession) {
    throw new Error('Recording session not found.')
  }

  return enqueueRecordingSessionTask(runtimeSession, async () => {
    if (runtimeSession.manifest.status === 'stopped') {
      return {
        ok: true,
        ...(await getRecordingSessionStatus(runtimeSession))
      }
    }

    await finalizeCurrentRecordingSessionSegment(runtimeSession)
    runtimeSession.manifest.status = 'stopped'
    runtimeSession.manifest.stoppedAt = Date.now()
    await persistRecordingSessionManifest(runtimeSession)
    activeRecordingSessions.delete(runtimeSession.id)

    try {
      const mergeResult = await mergeRecordingSession(runtimeSession)
      return {
        ok: true,
        item: mergeResult.item,
        ...(await getRecordingSessionStatus(runtimeSession))
      }
    } catch (error) {
      runtimeSession.manifest.output = {
        path: '',
        status: 'failed',
        bytes: 0,
        createdAt: 0,
        message: error instanceof Error ? error.message : 'Failed to merge recording session.'
      }
      await persistRecordingSessionManifest(runtimeSession)

      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to merge recording session.',
        ...(await getRecordingSessionStatus(runtimeSession))
      }
    }
  })
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
  const marker = filePath.lastIndexOf('.')
  if (marker <= 0) {
    return `${filePath}.${POSTER_FILE_EXTENSION}`
  }
  return `${filePath.slice(0, marker)}.${POSTER_FILE_EXTENSION}`
}

function toRecordingMediaUrl(filePath) {
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

function buildRecordingItem(filePath, fileStat) {
  const createdAt = Number(fileStat.birthtimeMs || fileStat.mtimeMs || Date.now())
  const posterPath = getPosterPathByVideoPath(filePath)
  const posterUrl = existsSync(posterPath) ? pathToFileURL(posterPath).toString() : ''

  return {
    name: filePath.split(sep).pop() || '',
    path: filePath,
    fileUrl: toRecordingMediaUrl(filePath),
    posterUrl: posterUrl ? toRecordingMediaUrl(posterPath) : '',
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
      items.push(buildRecordingItem(filePath, fileStat))
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

function registerRecordingMediaProtocol() {
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

function createRecordingPlayerWindow(filePath) {
  const playerWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 720,
    minHeight: 460,
    autoHideMenuBar: true,
    title: `录制回放 - ${filePath.split(sep).pop() || ''}`,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
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
    playerWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: {
        player: videoUrl,
        name: displayName
      }
    })
  }
  return playerWindow
}

function registerRecordingHandlers() {
  ipcMain.handle('screen-recording:session-start', async (_, payload = {}) => {
    try {
      const runtimeSession = await createRecordingSession(payload)
      return {
        ok: true,
        ...(await getRecordingSessionStatus(runtimeSession))
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to start recording session.'
      }
    }
  })

  ipcMain.handle('screen-recording:session-append-chunk', async (_, payload = {}) => {
    try {
      return await appendRecordingSessionChunk(payload)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to append recording chunk.'
      }
    }
  })

  ipcMain.handle('screen-recording:session-rotate', async (_, payload = {}) => {
    try {
      return await rotateRecordingSessionSegment(payload)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to rotate recording segment.'
      }
    }
  })

  ipcMain.handle('screen-recording:session-stop', async (_, payload = {}) => {
    try {
      return await stopRecordingSession(payload)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to stop recording session.'
      }
    }
  })

  ipcMain.handle('screen-recording:session-status', (_, payload = {}) => {
    return (async () => {
      const runtimeSession = getActiveRecordingSession(payload?.sessionId)
      if (!runtimeSession) {
        return { ok: false, message: 'Recording session not found.' }
      }
      return {
        ok: true,
        ...(await getRecordingSessionStatus(runtimeSession))
      }
    })()
  })

  ipcMain.handle('screen-recording:save', async (_, payload = {}) => {
    const parsed = parseDataUrl(payload?.dataUrl || '')

    if (!parsed || !parsed.buffer?.length) {
      return { ok: false, message: 'Invalid recording payload.' }
    }

    const detectedMime = parsed.mimeType || payload?.mimeType || 'video/webm'
    const ext = getVideoExtensionFromMimeType(detectedMime)
    const filePath = join(getRecordingsDirectoryPath(), createRecordingFileName(ext))

    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, parsed.buffer)

    /*
      Backup plan (disabled): generate poster when saving with ffmpeg.
      Keep disabled by default to avoid ffmpeg runtime dependency and extra save latency.

      Suggested extraction target:
      - first try: around 1s / frame 12
      - fallback: first frame

      Example commands:
      ffmpeg -y -ss 1 -i "<videoPath>" -vf "select=eq(n\\,12)" -frames:v 1 "<posterPath>"
      ffmpeg -y -i "<videoPath>" -frames:v 1 "<posterPath>"

      Intended insertion point:
      const posterPath = getPosterPathByVideoPath(filePath)
      // run ffmpeg command to write posterPath
    */

    const fileStat = await stat(filePath)

    return {
      ok: true,
      item: buildRecordingItem(filePath, fileStat)
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

  ipcMain.handle('screen-recording:debug-access', async () => {
    const recordingsDir = getRecordingsDirectoryPath()

    try {
      await mkdir(recordingsDir, { recursive: true })
      const items = await listRecordingItems()
      const sample = items.slice(0, 8).map((item) => ({
        name: item.name,
        path: item.path,
        posterPath: getPosterPathByVideoPath(item.path),
        fileExists: existsSync(item.path),
        posterExists: existsSync(getPosterPathByVideoPath(item.path)),
        fileUrl: item.fileUrl,
        posterUrl: item.posterUrl || ''
      }))

      return {
        ok: true,
        recordingsDir,
        count: items.length,
        sample
      }
    } catch (error) {
      return {
        ok: false,
        recordingsDir,
        message: error instanceof Error ? error.message : 'Debug access failed.'
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

    try {
      createRecordingPlayerWindow(filePath)
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to open player window.'
      }
    }
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
      const posterPath = getPosterPathByVideoPath(filePath)
      if (existsSync(posterPath)) {
        try {
          await unlink(posterPath)
        } catch {
          // Ignore poster deletion failures.
        }
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

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.electron.clip-recorder')
  registerRecordingMediaProtocol()

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

  const recoverySummary = await recoverPendingRecordingSessions()
  if (recoverySummary.recovered || recoverySummary.failed) {
    console.info('[recording] recovery summary:', recoverySummary)
  }

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
