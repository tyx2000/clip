import {
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  protocol,
  shell,
  systemPreferences
} from 'electron'
import { createReadStream, createWriteStream, existsSync } from 'fs'
import { once } from 'node:events'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  unlink,
  writeFile
} from 'fs/promises'
import { dirname, extname, join, resolve, sep } from 'path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'
import {
  CLOUD_SYNC_RETRY_DELAYS_MS,
  DEFAULT_CLOUD_SYNC_SERVER_URL,
  DEFAULT_SEGMENT_DURATION_MS,
  LOW_DISK_SPACE_THRESHOLD_BYTES,
  MIN_SEGMENT_DURATION_MS,
  RECORDING_FILE_PREFIX,
  RECORDING_MEDIA_SCHEME,
  VIDEO_FILE_EXTENSIONS,
  createRecordingFileName,
  createRecordingSegmentFileName,
  createRecordingSessionId,
  getPosterPathByVideoPath,
  getRecordingSessionsDirectoryPath,
  getRecordingsDirectoryPath,
  getVideoExtensionFromMimeType
} from './recordingPaths'
import {
  createRuntimeSessionFromCloudSyncDatabaseRecord as createCloudSyncRuntimeSessionFromDatabase,
  createRuntimeSessionFromRecordingDatabaseRecord as createLocalRuntimeSessionFromDatabase,
  deleteCloudSessionFromDatabase,
  deleteRecordingMetadataFromDatabase,
  deleteRecordingSessionFromDatabase,
  listCloudSyncSessionRowsFromDatabase,
  listLocalRecordingSessionRowsFromDatabase,
  readCloudSyncSessionRowsFromDatabase,
  readRecordingMetadataFromDatabase,
  readRecordingSessionRowsFromDatabase,
  syncCloudSessionToDatabase,
  syncRecordingSessionToDatabase,
  writeRecordingMetadataToDatabase
} from './recordingDb'
import {
  listSessionArtifactPaths,
  probeVideoDurationSec,
  runFfmpeg,
  sha256File
} from './mediaUtils'

let preferredDisplaySourceId = ''
const activeRecordingSessions = new Map()
const cloudSyncWorkers = new Map()

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

function normalizeCloudSyncEnabled(value) {
  return value === true
}

function getCloudSyncServerUrl(payload = {}) {
  const candidate =
    typeof payload?.cloudSyncServerUrl === 'string' && payload.cloudSyncServerUrl.trim()
      ? payload.cloudSyncServerUrl.trim()
      : process.env.CLOUD_SYNC_SERVER_URL || DEFAULT_CLOUD_SYNC_SERVER_URL
  return candidate.replace(/\/+$/, '')
}

function createCloudSyncState({ enabled = false, serverUrl = '' } = {}) {
  return {
    enabled,
    serverUrl: enabled ? serverUrl : '',
    sessionCreated: false,
    sessionStatus: enabled ? 'pending' : 'disabled',
    uploadStatus: enabled ? 'pending' : 'disabled',
    mergeStatus: enabled ? 'pending' : 'disabled',
    uploadedSegments: 0,
    totalSegments: 0,
    remoteVideoUrl: '',
    remoteVideoPath: '',
    lastUploadedSegmentIndex: 0,
    lastError: '',
    completedAt: null,
    lastAttemptAt: null,
    nextRetryAt: null
  }
}

function normalizeSegmentCloudSyncState(segment = {}) {
  return {
    uploadStatus:
      typeof segment.uploadStatus === 'string' && segment.uploadStatus
        ? segment.uploadStatus
        : 'pending',
    checksum: typeof segment.checksum === 'string' ? segment.checksum : '',
    etag: typeof segment.etag === 'string' ? segment.etag : '',
    uploadedAt: Number(segment.uploadedAt || 0) || null,
    retryCount: Number(segment.retryCount || 0)
  }
}

function applyRecordingSessionManifestDefaults(manifest = {}) {
  const cloudSyncEnabled = normalizeCloudSyncEnabled(manifest?.cloudSyncEnabled)
  const serverUrl = getCloudSyncServerUrl({ cloudSyncServerUrl: manifest?.cloudSync?.serverUrl })
  const cloudSync = {
    ...createCloudSyncState({
      enabled: cloudSyncEnabled,
      serverUrl
    }),
    ...(manifest?.cloudSync && typeof manifest.cloudSync === 'object' ? manifest.cloudSync : {})
  }

  return {
    ...manifest,
    version: Number(manifest?.version || 1),
    cloudSyncEnabled,
    cloudSync,
    segments: Array.isArray(manifest?.segments)
      ? manifest.segments.map((segment) => ({
          ...segment,
          ...normalizeSegmentCloudSyncState(segment)
        }))
      : []
  }
}

function createRecordingSessionManifest({
  sessionId,
  sessionDir,
  extension,
  mimeType,
  segmentDurationMs,
  cloudSyncEnabled = false,
  cloudSyncServerUrl = ''
}) {
  const now = Date.now()
  return {
    version: 2,
    sessionId,
    sessionDir,
    extension,
    mimeType,
    segmentDurationMs,
    cloudSyncEnabled,
    cloudSync: createCloudSyncState({
      enabled: cloudSyncEnabled,
      serverUrl: cloudSyncEnabled ? getCloudSyncServerUrl({ cloudSyncServerUrl }) : ''
    }),
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
  syncRecordingSessionToDatabase(runtimeSession)
  syncCloudSessionToDatabase(runtimeSession)
  syncRuntimeSessionOutputMetadata(runtimeSession)
}

function getRecordingSessionSummary(runtimeSession) {
  const currentSegment = runtimeSession.currentSegment
  const cloudUploadedSegments = runtimeSession.manifest.segments.filter(
    (segment) => segment.uploadStatus === 'uploaded'
  ).length
  const cloudFailedSegments = runtimeSession.manifest.segments.filter(
    (segment) => segment.uploadStatus === 'failed'
  ).length
  const cloudPendingSegments = runtimeSession.manifest.segments.filter(
    (segment) =>
      segment.status === 'ready' &&
      segment.uploadStatus !== 'uploaded' &&
      segment.uploadStatus !== 'disabled'
  ).length

  return {
    sessionId: runtimeSession.id,
    status: runtimeSession.manifest.status,
    sessionDir: runtimeSession.dir,
    segmentDurationMs: runtimeSession.manifest.segmentDurationMs,
    segmentCount: runtimeSession.manifest.segments.length,
    currentSegmentIndex: currentSegment?.index || null,
    currentSegmentBytes: currentSegment?.bytes || 0,
    totalBytes: runtimeSession.manifest.totalBytes,
    startedAt: runtimeSession.manifest.startedAt,
    stoppedAt: runtimeSession.manifest.stoppedAt,
    output: runtimeSession.manifest.output,
    cloudSyncEnabled: runtimeSession.manifest.cloudSyncEnabled === true,
    cloudSync: {
      ...runtimeSession.manifest.cloudSync,
      uploadedSegments: cloudUploadedSegments,
      failedSegments: cloudFailedSegments,
      pendingSegments: cloudPendingSegments
    }
  }
}

function buildCloudSyncMetadata(runtimeSession) {
  if (!runtimeSession?.manifest?.cloudSyncEnabled) {
    return null
  }

  return {
    ...runtimeSession.manifest.cloudSync,
    enabled: true,
    sessionId: runtimeSession.id,
    failedSegments: runtimeSession.manifest.segments.filter(
      (segment) => segment.uploadStatus === 'failed'
    ).length,
    pendingSegments: runtimeSession.manifest.segments.filter(
      (segment) =>
        segment.status === 'ready' &&
        segment.uploadStatus !== 'uploaded' &&
        segment.uploadStatus !== 'disabled'
    ).length
  }
}

function syncRuntimeSessionOutputMetadata(runtimeSession) {
  const outputPath = runtimeSession?.manifest?.output?.path
  if (!outputPath) {
    return
  }

  writeRecordingMetadataToDatabase(outputPath, {
    durationSec: Number(runtimeSession.manifest.output?.durationSec || 0) || null,
    cloudSync: buildCloudSyncMetadata(runtimeSession)
  })
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

function createRuntimeSession(manifest) {
  return {
    id: manifest.sessionId,
    dir: manifest.sessionDir,
    writeQueue: Promise.resolve(),
    writeStream: null,
    currentSegment: null,
    manifest
  }
}

async function cleanupRecordingSessionArtifacts(runtimeSession) {
  if (!runtimeSession?.dir) {
    return
  }

  if (runtimeSession.writeStream) {
    await new Promise((resolveCallback) => {
      runtimeSession.writeStream.end(() => resolveCallback())
    }).catch(() => {})
    runtimeSession.writeStream = null
  }

  await rm(runtimeSession.dir, {
    recursive: true,
    force: true,
    maxRetries: 12,
    retryDelay: 300
  }).catch(() => {})

  if (existsSync(runtimeSession.dir)) {
    const remainingEntries = await listSessionArtifactPaths(runtimeSession.dir)
    const detail = remainingEntries.filter(Boolean).join(', ')
    throw new Error(
      detail
        ? `Failed to clean recording session artifacts: ${detail}`
        : 'Failed to clean recording session artifacts.'
    )
  }

  deleteRecordingSessionFromDatabase(runtimeSession.id)
  deleteCloudSessionFromDatabase(runtimeSession.id)
}

async function parseJsonResponse(response) {
  const text = await response.text()
  if (!text.trim()) {
    return {}
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Unexpected cloud sync response (${response.status}).`)
  }
}

async function cloudSyncFetchJson(runtimeSession, path, init = {}) {
  const serverUrl = runtimeSession.manifest.cloudSync?.serverUrl
  if (!serverUrl) {
    throw new Error('Cloud sync server URL is not configured.')
  }

  const response = await fetch(`${serverUrl}${path}`, init)
  const payload = await parseJsonResponse(response)
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.message || `Cloud sync request failed (${response.status}).`)
  }

  return payload
}

async function ensureCloudSyncRemoteSession(runtimeSession) {
  if (!runtimeSession.manifest.cloudSyncEnabled) {
    return
  }

  if (runtimeSession.manifest.cloudSync?.sessionCreated) {
    return
  }

  runtimeSession.manifest.cloudSync.sessionStatus = 'creating'
  runtimeSession.manifest.cloudSync.lastError = ''
  await persistRecordingSessionManifest(runtimeSession)

  try {
    await cloudSyncFetchJson(runtimeSession, '/api/cloud-sync/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sessionId: runtimeSession.id,
        mimeType: runtimeSession.manifest.mimeType,
        extension: runtimeSession.manifest.extension,
        segmentDurationMs: runtimeSession.manifest.segmentDurationMs,
        startedAt: runtimeSession.manifest.startedAt
      })
    })

    runtimeSession.manifest.cloudSync.sessionCreated = true
    runtimeSession.manifest.cloudSync.sessionStatus = 'created'
    runtimeSession.manifest.cloudSync.uploadStatus = 'pending'
    runtimeSession.manifest.cloudSync.lastError = ''
    await persistRecordingSessionManifest(runtimeSession)
  } catch (error) {
    runtimeSession.manifest.cloudSync.sessionStatus = 'failed'
    runtimeSession.manifest.cloudSync.lastError =
      error instanceof Error ? error.message : 'Failed to create cloud sync session.'
    await persistRecordingSessionManifest(runtimeSession)
    throw error
  }
}

function getCloudSyncWorkerState(sessionId) {
  if (!cloudSyncWorkers.has(sessionId)) {
    cloudSyncWorkers.set(sessionId, {
      running: false,
      timer: null
    })
  }

  return cloudSyncWorkers.get(sessionId)
}

function clearCloudSyncWorker(sessionId) {
  const worker = cloudSyncWorkers.get(sessionId)
  if (!worker) {
    return
  }

  if (worker.timer) {
    clearTimeout(worker.timer)
  }

  cloudSyncWorkers.delete(sessionId)
}

function getCloudSyncRetryDelayMs(retryCount) {
  const normalized = Math.max(0, Number(retryCount || 0))
  return CLOUD_SYNC_RETRY_DELAYS_MS[Math.min(normalized, CLOUD_SYNC_RETRY_DELAYS_MS.length - 1)]
}

function getPendingCloudSyncSegments(runtimeSession) {
  return runtimeSession.manifest.segments
    .filter(
      (segment) =>
        segment.status === 'ready' &&
        existsSync(segment.path) &&
        segment.uploadStatus !== 'uploaded'
    )
    .sort((left, right) => left.index - right.index)
}

function updateCloudSyncStateFromRemote(runtimeSession, payload = {}) {
  if (!runtimeSession.manifest.cloudSyncEnabled) {
    return
  }

  runtimeSession.manifest.cloudSync.sessionCreated = true
  runtimeSession.manifest.cloudSync.sessionStatus = 'created'
  runtimeSession.manifest.cloudSync.uploadStatus =
    typeof payload.uploadStatus === 'string' && payload.uploadStatus
      ? payload.uploadStatus
      : runtimeSession.manifest.cloudSync.uploadStatus
  runtimeSession.manifest.cloudSync.mergeStatus =
    typeof payload.mergeStatus === 'string' && payload.mergeStatus
      ? payload.mergeStatus
      : runtimeSession.manifest.cloudSync.mergeStatus
  runtimeSession.manifest.cloudSync.uploadedSegments = Number(payload.uploadedSegments || 0)
  runtimeSession.manifest.cloudSync.totalSegments = Number(payload.totalSegments || 0)
  runtimeSession.manifest.cloudSync.remoteVideoUrl =
    typeof payload.remoteVideoUrl === 'string' ? payload.remoteVideoUrl : ''
  runtimeSession.manifest.cloudSync.remoteVideoPath =
    typeof payload.remoteVideoPath === 'string' ? payload.remoteVideoPath : ''
  runtimeSession.manifest.cloudSync.lastError =
    typeof payload.lastError === 'string' ? payload.lastError : ''
}

async function uploadRecordingSessionSegment(runtimeSession, segment) {
  if (!runtimeSession.manifest.cloudSyncEnabled || !segment?.path || !existsSync(segment.path)) {
    return
  }

  if (segment.uploadStatus === 'uploaded') {
    return
  }

  await ensureCloudSyncRemoteSession(runtimeSession)

  segment.uploadStatus = 'uploading'
  runtimeSession.manifest.cloudSync.uploadStatus = 'uploading'
  runtimeSession.manifest.cloudSync.lastError = ''
  runtimeSession.manifest.cloudSync.lastAttemptAt = Date.now()
  runtimeSession.manifest.cloudSync.nextRetryAt = null
  await persistRecordingSessionManifest(runtimeSession)

  try {
    const checksum = await sha256File(segment.path)
    const body = await readFile(segment.path)
    const payload = await cloudSyncFetchJson(
      runtimeSession,
      `/api/cloud-sync/sessions/${encodeURIComponent(runtimeSession.id)}/segments/${segment.index}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-checksum-sha256': checksum,
          'x-file-size': String(body.length)
        },
        body
      }
    )

    segment.checksum = checksum
    segment.etag = typeof payload.etag === 'string' ? payload.etag : checksum
    segment.uploadStatus = 'uploaded'
    segment.uploadedAt = Date.now()
    segment.retryCount = Number(segment.retryCount || 0)
    runtimeSession.manifest.cloudSync.lastUploadedSegmentIndex = segment.index
    updateCloudSyncStateFromRemote(runtimeSession, {
      ...payload,
      uploadedSegments: runtimeSession.manifest.segments.filter(
        (item) => item.uploadStatus === 'uploaded'
      ).length,
      totalSegments: runtimeSession.manifest.segments.length
    })
    runtimeSession.manifest.cloudSync.lastAttemptAt = Date.now()
    runtimeSession.manifest.cloudSync.nextRetryAt = null
    await persistRecordingSessionManifest(runtimeSession)
  } catch (error) {
    segment.uploadStatus = 'failed'
    segment.retryCount = Number(segment.retryCount || 0) + 1
    runtimeSession.manifest.cloudSync.uploadStatus = 'failed'
    runtimeSession.manifest.cloudSync.lastError =
      error instanceof Error ? error.message : 'Failed to upload recording segment.'
    runtimeSession.manifest.cloudSync.lastAttemptAt = Date.now()
    runtimeSession.manifest.cloudSync.nextRetryAt =
      Date.now() + getCloudSyncRetryDelayMs(segment.retryCount)
    await persistRecordingSessionManifest(runtimeSession)
    throw error
  }
}

async function completeCloudSyncRecordingSession(runtimeSession) {
  if (!runtimeSession.manifest.cloudSyncEnabled) {
    return
  }

  try {
    runtimeSession.manifest.cloudSync.lastAttemptAt = Date.now()
    runtimeSession.manifest.cloudSync.nextRetryAt = null
    await persistRecordingSessionManifest(runtimeSession)
    await ensureCloudSyncRemoteSession(runtimeSession)
    const payload = await cloudSyncFetchJson(
      runtimeSession,
      `/api/cloud-sync/sessions/${encodeURIComponent(runtimeSession.id)}/complete`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          stoppedAt: runtimeSession.manifest.stoppedAt || Date.now(),
          segmentCount: runtimeSession.manifest.segments.filter(
            (segment) => segment.status === 'ready'
          ).length,
          totalBytes: runtimeSession.manifest.totalBytes
        })
      }
    )
    runtimeSession.manifest.cloudSync.completedAt = Date.now()
    updateCloudSyncStateFromRemote(runtimeSession, payload)
    runtimeSession.manifest.cloudSync.nextRetryAt = null
    await persistRecordingSessionManifest(runtimeSession)
    return true
  } catch (error) {
    runtimeSession.manifest.cloudSync.mergeStatus = 'merge_failed'
    runtimeSession.manifest.cloudSync.lastError =
      error instanceof Error ? error.message : 'Failed to complete cloud sync session.'
    runtimeSession.manifest.cloudSync.lastAttemptAt = Date.now()
    runtimeSession.manifest.cloudSync.nextRetryAt = Date.now() + getCloudSyncRetryDelayMs(0)
    await persistRecordingSessionManifest(runtimeSession)
    return false
  }
}

async function syncCloudRecordingSessionStatus(runtimeSession) {
  if (
    !runtimeSession.manifest.cloudSyncEnabled ||
    !runtimeSession.manifest.cloudSync?.sessionCreated
  ) {
    return false
  }

  try {
    runtimeSession.manifest.cloudSync.lastAttemptAt = Date.now()
    const payload = await cloudSyncFetchJson(
      runtimeSession,
      `/api/cloud-sync/sessions/${encodeURIComponent(runtimeSession.id)}`
    )
    updateCloudSyncStateFromRemote(runtimeSession, payload)
    runtimeSession.manifest.cloudSync.nextRetryAt = null
    await persistRecordingSessionManifest(runtimeSession)

    if (payload.mergeStatus === 'merged') {
      if (runtimeSession.manifest.output?.path && existsSync(runtimeSession.manifest.output.path)) {
        await writeRecordingMetadata(runtimeSession.manifest.output.path, {
          durationSec: Number(runtimeSession.manifest.output?.durationSec || 0) || null,
          cloudSync: buildCloudSyncMetadata(runtimeSession)
        })
      }
      await cleanupRecordingSessionArtifacts(runtimeSession)
      clearCloudSyncWorker(runtimeSession.id)
      return true
    }
  } catch (error) {
    runtimeSession.manifest.cloudSync.lastError =
      error instanceof Error ? error.message : 'Failed to refresh cloud sync status.'
    runtimeSession.manifest.cloudSync.nextRetryAt = Date.now() + getCloudSyncRetryDelayMs(0)
    await persistRecordingSessionManifest(runtimeSession)
  }

  return false
}

async function processCloudSyncSession(runtimeSession) {
  if (!runtimeSession.manifest.cloudSyncEnabled) {
    clearCloudSyncWorker(runtimeSession.id)
    return
  }

  const pendingSegments = getPendingCloudSyncSegments(runtimeSession)
  for (const segment of pendingSegments) {
    try {
      await uploadRecordingSessionSegment(runtimeSession, segment)
    } catch {
      return {
        retryDelayMs: getCloudSyncRetryDelayMs(segment.retryCount)
      }
    }
  }

  const allReadySegmentsUploaded = runtimeSession.manifest.segments
    .filter((segment) => segment.status === 'ready')
    .every((segment) => segment.uploadStatus === 'uploaded')

  if (
    runtimeSession.manifest.status === 'stopped' &&
    allReadySegmentsUploaded &&
    !runtimeSession.manifest.cloudSync.completedAt
  ) {
    const completed = await completeCloudSyncRecordingSession(runtimeSession)
    if (!completed) {
      return {
        retryDelayMs: getCloudSyncRetryDelayMs(0)
      }
    }
  }

  if (runtimeSession.manifest.cloudSync.completedAt) {
    const merged = await syncCloudRecordingSessionStatus(runtimeSession)
    if (!merged) {
      return {
        retryDelayMs: 5_000
      }
    }
  }

  return null
}

function scheduleCloudSyncProcessing(runtimeSession, delayMs = 0) {
  if (!runtimeSession?.manifest?.cloudSyncEnabled) {
    return
  }

  const worker = getCloudSyncWorkerState(runtimeSession.id)
  if (worker.timer) {
    clearTimeout(worker.timer)
    worker.timer = null
  }

  worker.timer = setTimeout(
    async () => {
      if (worker.running) {
        scheduleCloudSyncProcessing(runtimeSession, 1_000)
        return
      }

      worker.running = true
      worker.timer = null

      try {
        const result = await processCloudSyncSession(runtimeSession)
        if (result?.retryDelayMs) {
          scheduleCloudSyncProcessing(runtimeSession, result.retryDelayMs)
        } else if (runtimeSession.manifest.cloudSync.completedAt) {
          scheduleCloudSyncProcessing(runtimeSession, 5_000)
        }
      } catch (error) {
        runtimeSession.manifest.cloudSync.lastError =
          error instanceof Error ? error.message : 'Cloud sync processing failed.'
        runtimeSession.manifest.cloudSync.nextRetryAt = Date.now() + getCloudSyncRetryDelayMs(0)
        await persistRecordingSessionManifest(runtimeSession).catch(() => {})
        scheduleCloudSyncProcessing(runtimeSession, getCloudSyncRetryDelayMs(0))
      } finally {
        worker.running = false
      }
    },
    Math.max(0, Number(delayMs || 0))
  )
}

function scheduleCloudSyncFinalize(runtimeSession) {
  if (!runtimeSession.manifest.cloudSyncEnabled) {
    return
  }

  scheduleCloudSyncProcessing(runtimeSession)
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
      /*
        MediaRecorder-generated WebM segments do not merge reliably with stream copy.
        Re-encode the concatenated input so ffmpeg regenerates timestamps across segments;
        otherwise the final file can appear to contain only the first 5s segment.
      */
      await runFfmpeg([
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatListPath,
        '-an',
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        'yuv420p',
        '-row-mt',
        '1',
        '-deadline',
        'realtime',
        '-cpu-used',
        '4',
        outputFilePath
      ])
    } finally {
      if (existsSync(concatListPath)) {
        await unlink(concatListPath).catch(() => {})
      }
    }
  }

  const outputStat = await stat(outputFilePath)
  const durationSec = await probeVideoDurationSec(outputFilePath)
  runtimeSession.manifest.output = {
    path: outputFilePath,
    status: 'ready',
    bytes: Number(outputStat.size || 0),
    createdAt: Number(outputStat.birthtimeMs || outputStat.mtimeMs || Date.now()),
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null
  }
  await persistRecordingSessionManifest(runtimeSession)
  await writeRecordingMetadata(outputFilePath, {
    durationSec: runtimeSession.manifest.output.durationSec,
    cloudSync: buildCloudSyncMetadata(runtimeSession)
  })

  const item = await buildRecordingItem(outputFilePath, outputStat)

  return {
    item,
    outputPath: outputFilePath
  }
}

async function normalizeRecoveredRecordingSession(runtimeSession) {
  let manifestChanged = false
  const now = Date.now()

  runtimeSession.manifest = applyRecordingSessionManifestDefaults(runtimeSession.manifest)

  for (const segment of runtimeSession.manifest.segments) {
    const normalizedSyncState = normalizeSegmentCloudSyncState(segment)
    if (
      segment.uploadStatus !== normalizedSyncState.uploadStatus ||
      segment.checksum !== normalizedSyncState.checksum ||
      segment.etag !== normalizedSyncState.etag ||
      segment.uploadedAt !== normalizedSyncState.uploadedAt
    ) {
      Object.assign(segment, normalizedSyncState)
      manifestChanged = true
    }

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

  if (runtimeSession.manifest.cloudSyncEnabled) {
    runtimeSession.manifest.cloudSync.totalSegments = runtimeSession.manifest.segments.length
    runtimeSession.manifest.cloudSync.uploadedSegments = runtimeSession.manifest.segments.filter(
      (segment) => segment.uploadStatus === 'uploaded'
    ).length
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

export async function recoverPendingRecordingSessions() {
  const summary = {
    scanned: 0,
    recovered: 0,
    skipped: 0,
    failed: 0
  }

  const sessionRows = listLocalRecordingSessionRowsFromDatabase()
  for (const sessionRow of sessionRows) {
    summary.scanned += 1
    let runtimeSession = null

    try {
      const storedSession = readRecordingSessionRowsFromDatabase(sessionRow.sessionId)
      if (!storedSession) {
        summary.skipped += 1
        continue
      }

      runtimeSession = createLocalRuntimeSessionFromDatabase(
        storedSession.sessionRow,
        storedSession.segmentRows,
        createRuntimeSession
      )
      if (!runtimeSession) {
        summary.skipped += 1
        continue
      }

      await normalizeRecoveredRecordingSession(runtimeSession)

      const outputPath = runtimeSession.manifest.output?.path || ''
      const outputReady =
        runtimeSession.manifest.output?.status === 'ready' && outputPath && existsSync(outputPath)
      if (outputReady) {
        await cleanupRecordingSessionArtifacts(runtimeSession)
        summary.skipped += 1
        continue
      }

      if (!shouldRecoverRecordingSession(runtimeSession)) {
        summary.skipped += 1
        continue
      }

      await mergeRecordingSession(runtimeSession)
      try {
        await cleanupRecordingSessionArtifacts(runtimeSession)
      } catch (error) {
        console.warn(
          '[recording] failed to clean recovered local session:',
          runtimeSession.id,
          error instanceof Error ? error.message : error
        )
      }
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
        sessionRow.sessionId,
        error instanceof Error ? error.message : error
      )
    }
  }

  try {
    const resumedCloudSync = await resumeAllCloudSyncSessions()
    summary.recovered += Number(resumedCloudSync?.resumed || 0)
  } catch (error) {
    console.warn(
      '[recording] failed to resume cloud sync sessions:',
      error instanceof Error ? error.message : error
    )
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
    status: 'writing',
    uploadStatus: runtimeSession.manifest.cloudSyncEnabled ? 'pending' : 'disabled',
    checksum: '',
    etag: '',
    uploadedAt: null,
    retryCount: 0
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
  if (runtimeSession.manifest.cloudSyncEnabled && segmentItem) {
    runtimeSession.manifest.cloudSync.totalSegments = runtimeSession.manifest.segments.length
  }
  await persistRecordingSessionManifest(runtimeSession)

  if (runtimeSession.manifest.cloudSyncEnabled && segmentItem) {
    scheduleCloudSyncProcessing(runtimeSession)
  }
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
  const cloudSyncEnabled = normalizeCloudSyncEnabled(payload?.cloudSyncEnabled)
  const cloudSyncServerUrl = getCloudSyncServerUrl(payload)
  const sessionDir = join(getRecordingSessionsDirectoryPath(), sessionId)

  if (existsSync(sessionDir)) {
    throw new Error('Recording session directory already exists.')
  }

  await mkdir(sessionDir, { recursive: true })

  const runtimeSession = {
    id: sessionId,
    dir: sessionDir,
    writeQueue: Promise.resolve(),
    writeStream: null,
    currentSegment: null,
    manifest: createRecordingSessionManifest({
      sessionId,
      sessionDir,
      extension,
      mimeType: detectedMimeType,
      segmentDurationMs,
      cloudSyncEnabled,
      cloudSyncServerUrl
    })
  }

  activeRecordingSessions.set(sessionId, runtimeSession)

  try {
    await openRecordingSessionSegment(runtimeSession, 1)
    if (cloudSyncEnabled) {
      scheduleCloudSyncProcessing(runtimeSession)
    }
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
      if (!runtimeSession.manifest.cloudSyncEnabled) {
        await cleanupRecordingSessionArtifacts(runtimeSession)
      }
      scheduleCloudSyncFinalize(runtimeSession)
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

async function cancelRecordingSession(payload = {}) {
  const runtimeSession = getActiveRecordingSession(payload?.sessionId)
  if (!runtimeSession) {
    throw new Error('Recording session not found.')
  }

  return enqueueRecordingSessionTask(runtimeSession, async () => {
    clearCloudSyncWorker(runtimeSession.id)
    activeRecordingSessions.delete(runtimeSession.id)

    if (runtimeSession.writeStream) {
      await new Promise((resolveCallback) => {
        runtimeSession.writeStream.end(() => resolveCallback())
      }).catch(() => {})
    }

    runtimeSession.writeStream = null
    runtimeSession.currentSegment = null
    runtimeSession.manifest.status = 'cancelled'
    runtimeSession.manifest.stoppedAt = Date.now()

    await cleanupRecordingSessionArtifacts(runtimeSession)

    return {
      ok: true,
      sessionId: runtimeSession.id,
      status: 'cancelled'
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

async function readRecordingMetadata(filePath) {
  return readRecordingMetadataFromDatabase(filePath)
}

async function writeRecordingMetadata(filePath, metadata) {
  writeRecordingMetadataToDatabase(filePath, metadata)
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

async function buildRecordingItem(filePath, fileStat) {
  const metadata = await readRecordingMetadata(filePath)
  const createdAt = Number(fileStat.birthtimeMs || fileStat.mtimeMs || Date.now())
  const posterPath = getPosterPathByVideoPath(filePath)
  const posterUrl = existsSync(posterPath) ? pathToFileURL(posterPath).toString() : ''
  const probedDurationSec = await probeVideoDurationSec(filePath)
  const durationSec =
    Number.isFinite(probedDurationSec) && probedDurationSec > 0 ? probedDurationSec : null
  const cloudSync = metadata?.cloudSync || null

  return {
    name: filePath.split(sep).pop() || '',
    path: filePath,
    fileUrl: toRecordingMediaUrl(filePath),
    posterUrl: posterUrl ? toRecordingMediaUrl(posterPath) : '',
    bytes: Number(fileStat.size || 0),
    createdAt,
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
    cloudSync
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

async function getRuntimeSessionForCloudSync(payload = {}) {
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
  if (sessionId) {
    const activeSession = getActiveRecordingSession(sessionId)
    if (activeSession) {
      return activeSession
    }

    const storedSession = readCloudSyncSessionRowsFromDatabase(sessionId)
    if (!storedSession) {
      return null
    }

    return await createCloudSyncRuntimeSessionFromDatabase(
      storedSession.sessionRow,
      storedSession.segmentRows,
      applyRecordingSessionManifestDefaults,
      createCloudSyncState,
      createRuntimeSession
    )
  }

  return null
}

async function retryCloudSyncSession(payload = {}) {
  const runtimeSession = await getRuntimeSessionForCloudSync(payload)
  if (!runtimeSession) {
    throw new Error('Cloud sync session not found.')
  }

  if (!runtimeSession.manifest.cloudSyncEnabled) {
    throw new Error('This recording did not enable cloud sync.')
  }

  runtimeSession.manifest.cloudSync.lastError = ''
  runtimeSession.manifest.cloudSync.uploadStatus = 'pending'
  runtimeSession.manifest.cloudSync.nextRetryAt = null

  for (const segment of runtimeSession.manifest.segments) {
    if (segment.status === 'ready' && segment.uploadStatus !== 'uploaded') {
      segment.uploadStatus = 'pending'
    }
  }

  await persistRecordingSessionManifest(runtimeSession)
  scheduleCloudSyncProcessing(runtimeSession)

  return {
    ok: true,
    sessionId: runtimeSession.id,
    ...(await getRecordingSessionStatus(runtimeSession))
  }
}

async function resumeAllCloudSyncSessions() {
  const sessionRows = listCloudSyncSessionRowsFromDatabase()
  let resumed = 0

  for (const sessionRow of sessionRows) {
    try {
      const storedSession = readCloudSyncSessionRowsFromDatabase(sessionRow.sessionId)
      if (!storedSession) {
        continue
      }

      const runtimeSession = await createCloudSyncRuntimeSessionFromDatabase(
        storedSession.sessionRow,
        storedSession.segmentRows,
        applyRecordingSessionManifestDefaults,
        createCloudSyncState,
        createRuntimeSession
      )
      if (!runtimeSession?.manifest?.cloudSyncEnabled) {
        continue
      }

      await normalizeRecoveredRecordingSession(runtimeSession)

      const outputPath = runtimeSession.manifest.output?.path || ''
      const outputReady =
        runtimeSession.manifest.output?.status === 'ready' && outputPath && existsSync(outputPath)

      if (!outputReady && shouldRecoverRecordingSession(runtimeSession)) {
        await mergeRecordingSession(runtimeSession)
      }

      scheduleCloudSyncProcessing(runtimeSession)
      resumed += 1
    } catch {
      continue
    }
  }

  return {
    ok: true,
    resumed
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

export function resolvePreferredDisplaySource(sources) {
  return (
    sources.find((source) => source.id === preferredDisplaySourceId) ||
    sources.find((source) => source.id.startsWith('screen:')) ||
    sources[0] ||
    null
  )
}

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

export function registerRecordingHandlers() {
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

  ipcMain.handle('screen-recording:session-cancel', async (_, payload = {}) => {
    try {
      return await cancelRecordingSession(payload)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to cancel recording session.'
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
    const durationSec = await probeVideoDurationSec(filePath)
    await writeRecordingMetadata(filePath, {
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
      cloudSync: null
    })

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

  ipcMain.handle('screen-recording:cloud-sync-retry', async (_, payload = {}) => {
    try {
      return await retryCloudSyncSession(payload)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to retry cloud sync.'
      }
    }
  })

  ipcMain.handle('screen-recording:cloud-sync-resume-all', async () => {
    try {
      return await resumeAllCloudSyncSessions()
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to resume cloud sync sessions.'
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
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
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
      deleteRecordingMetadataFromDatabase(filePath)
      if (existsSync(posterPath)) {
        try {
          await unlink(posterPath)
        } catch {
          // Ignore poster deletion failures.
        }
      }

      const runtimeSession = sessionId ? await getRuntimeSessionForCloudSync({ sessionId }) : null
      if (runtimeSession) {
        clearCloudSyncWorker(runtimeSession.id)
        await cleanupRecordingSessionArtifacts(runtimeSession)
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
