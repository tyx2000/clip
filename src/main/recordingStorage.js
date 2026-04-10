/** 文件作用：管理录屏会话状态、数据库恢复和最终录屏目录读写。 */
import { existsSync } from 'fs'
import { mkdir, readdir, stat, statfs, unlink, writeFile } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import {
  createRuntimeSessionFromCloudSyncDatabaseRecord as createCloudSyncRuntimeSessionFromDatabaseRecord,
  createRuntimeSessionFromRecordingDatabaseRecord as createLocalRuntimeSessionFromDatabaseRecord,
  deleteRecordingMetadataFromDatabase,
  deleteRecordingSessionFromDatabase,
  listCloudSyncSessionRowsFromDatabase,
  listLocalRecordingSessionRowsFromDatabase,
  readCloudSyncSessionRowsFromDatabase,
  readRecordingMetadataFromDatabase,
  readRecordingSessionRowsFromDatabase,
  syncRecordingSessionToDatabase,
  writeRecordingMetadataToDatabase
} from './recordingDb'
import {
  LOW_DISK_SPACE_THRESHOLD_BYTES,
  RECORDING_FILE_PREFIX,
  VIDEO_FILE_EXTENSIONS,
  createRecordingFileName,
  getPosterPathByVideoPath,
  getRecordingsDirectoryPath,
  getVideoExtensionFromMimeType
} from './recordingPaths'

/** 统计一个会话当前的云同步分片状态。 */
function getCloudSyncPartStats(runtimeSession) {
  const uploadedParts = runtimeSession.manifest.segments.filter(
    (segment) => segment.uploadStatus === 'uploaded'
  ).length
  const failedParts = runtimeSession.manifest.segments.filter(
    (segment) => segment.uploadStatus === 'failed'
  ).length
  const pendingParts = runtimeSession.manifest.segments.filter(
    (segment) =>
      segment.status === 'ready' &&
      segment.uploadStatus !== 'uploaded' &&
      segment.uploadStatus !== 'disabled'
  ).length

  return {
    uploadedParts,
    failedParts,
    pendingParts,
    totalParts: runtimeSession.manifest.segments.length
  }
}

/** 创建新录屏会话的默认状态结构。 */
export function createRecordingSessionState(
  { getCloudSyncServerUrl, createCloudSyncState },
  {
    sessionId,
    sessionDir,
    extension,
    mimeType,
    segmentDurationMs,
    cloudSyncEnabled = false,
    cloudSyncServerUrl = ''
  }
) {
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

/** 构建写入录屏元数据表的云同步摘要。 */
export function buildCloudSyncMetadata(runtimeSession) {
  if (!runtimeSession?.manifest?.cloudSyncEnabled) {
    return null
  }

  return {
    ...runtimeSession.manifest.cloudSync,
    enabled: true,
    sessionId: runtimeSession.id,
    ...getCloudSyncPartStats(runtimeSession)
  }
}

/** 生成返回给渲染进程的会话状态摘要。 */
export function getRecordingSessionSummary(runtimeSession) {
  const currentPart = runtimeSession.currentSegment

  return {
    sessionId: runtimeSession.id,
    status: runtimeSession.manifest.status,
    sessionDir: runtimeSession.dir,
    segmentDurationMs: runtimeSession.manifest.segmentDurationMs,
    partCount: runtimeSession.manifest.segments.length,
    currentPartIndex: currentPart?.index || null,
    currentPartBytes: currentPart?.bytes || 0,
    totalBytes: runtimeSession.manifest.totalBytes,
    startedAt: runtimeSession.manifest.startedAt,
    stoppedAt: runtimeSession.manifest.stoppedAt,
    output: runtimeSession.manifest.output,
    cloudSyncEnabled: runtimeSession.manifest.cloudSyncEnabled === true,
    cloudSync: {
      ...runtimeSession.manifest.cloudSync,
      ...getCloudSyncPartStats(runtimeSession)
    }
  }
}

/** 从数据库读取某个最终录屏文件的元数据。 */
export function readRecordingMetadata(filePath) {
  return readRecordingMetadataFromDatabase(filePath)
}

/** 向数据库写入某个最终录屏文件的元数据。 */
export function writeRecordingMetadata(filePath, metadata) {
  writeRecordingMetadataToDatabase(filePath, metadata)
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

/** 根据文件状态和附加元数据组装列表项。 */
export async function buildRecordingItem({ probeVideoDurationSec }, filePath, fileStat) {
  const metadata = await readRecordingMetadata(filePath)
  const createdAt = Number(fileStat.birthtimeMs || fileStat.mtimeMs || Date.now())
  const posterPath = getPosterPathByVideoPath(filePath)
  const posterUrl = existsSync(posterPath)
    ? `recording://media/${encodeURIComponent(posterPath)}`
    : ''
  const probedDurationSec = await probeVideoDurationSec(filePath)
  const durationSec =
    Number.isFinite(probedDurationSec) && probedDurationSec > 0 ? probedDurationSec : null
  const cloudSync = metadata?.cloudSync || null

  return {
    name: filePath.split(sep).pop() || '',
    path: filePath,
    fileUrl: `recording://media/${encodeURIComponent(filePath)}`,
    posterUrl,
    bytes: Number(fileStat.size || 0),
    createdAt,
    durationSec,
    cloudSync
  }
}

/** 扫描录屏目录并返回可展示的录屏列表。 */
export async function listRecordingItems(deps) {
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
      items.push(await buildRecordingItem(deps, filePath, fileStat))
    } catch {
      continue
    }
  }

  items.sort((left, right) => right.createdAt - left.createdAt)
  return items
}

/** 将渲染进程传来的 data URL 直接保存为一个最终录屏文件。 */
export async function saveRecordingFromDataUrl(
  { parseDataUrl, probeVideoDurationSec },
  payload = {}
) {
  const parsed = parseDataUrl(payload?.dataUrl || '')

  if (!parsed || !parsed.buffer?.length) {
    return { ok: false, message: 'Invalid recording payload.' }
  }

  const detectedMime = parsed.mimeType || payload?.mimeType || 'video/webm'
  const ext = getVideoExtensionFromMimeType(detectedMime)
  const filePath = join(getRecordingsDirectoryPath(), createRecordingFileName(ext))

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, parsed.buffer)

  const fileStat = await stat(filePath)
  const durationSec = await probeVideoDurationSec(filePath)
  writeRecordingMetadata(filePath, {
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
    cloudSync: null
  })

  return {
    ok: true,
    item: await buildRecordingItem({ probeVideoDurationSec }, filePath, fileStat)
  }
}

/** 删除一个录屏文件及其附属元数据和封面。 */
export async function deleteRecordingFile(filePath) {
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
      // 忽略封面图删除失败，避免影响主文件删除结果。
    }
  }

  return { ok: true }
}

/** 当输出文件存在时，把 output 元数据同步到元数据表。 */
function syncRuntimeSessionOutputMetadata(runtimeSession) {
  const outputPath = runtimeSession?.manifest?.output?.path
  if (!outputPath) {
    return
  }

  writeRecordingMetadata(outputPath, {
    durationSec: Number(runtimeSession.manifest.output?.durationSec || 0) || null,
    cloudSync: buildCloudSyncMetadata(runtimeSession)
  })
}

/** 把当前运行时会话完整刷新到 SQLite。 */
export async function persistRecordingSessionState(runtimeSession) {
  runtimeSession.manifest.updatedAt = Date.now()
  syncRecordingSessionToDatabase(runtimeSession)
  syncRuntimeSessionOutputMetadata(runtimeSession)
}

/** 读取录屏目录的可用磁盘空间快照。 */
export async function getRecordingStorageSnapshot() {
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

/** 生成包含磁盘快照的完整会话状态。 */
export async function getRecordingSessionStatus(runtimeSession) {
  const storage = await getRecordingStorageSnapshot()
  return {
    ...getRecordingSessionSummary(runtimeSession),
    storage
  }
}

/** 把纯状态对象包装成主进程可操作的运行时会话对象。 */
export function createRuntimeSession(sessionState) {
  return {
    id: sessionState.sessionId,
    dir: sessionState.sessionDir,
    writeQueue: Promise.resolve(),
    writeStream: null,
    partWriteStream: null,
    captureTempPath: '',
    currentSegment: null,
    manifest: sessionState
  }
}

/** 从本地录屏数据库记录恢复运行时会话。 */
export function createLocalRuntimeSessionFromDatabase(
  { createCloudSyncState },
  sessionRow,
  segmentRows
) {
  return createLocalRuntimeSessionFromDatabaseRecord(
    sessionRow,
    segmentRows,
    createRuntimeSession,
    createCloudSyncState
  )
}

/** 从云同步数据库记录恢复运行时会话。 */
export function createCloudSyncRuntimeSessionFromDatabase(
  { createCloudSyncState },
  sessionRow,
  segmentRows
) {
  return createCloudSyncRuntimeSessionFromDatabaseRecord(
    sessionRow,
    segmentRows,
    createCloudSyncState,
    createRuntimeSession
  )
}

export {
  deleteRecordingMetadataFromDatabase,
  deleteRecordingSessionFromDatabase,
  listCloudSyncSessionRowsFromDatabase,
  listLocalRecordingSessionRowsFromDatabase,
  readCloudSyncSessionRowsFromDatabase,
  readRecordingSessionRowsFromDatabase,
  syncRecordingSessionToDatabase
}
