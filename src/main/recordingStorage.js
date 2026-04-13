/** 文件作用：管理录屏相关的 SQLite 持久化、会话恢复和最终录屏目录读写。 */
import { existsSync, mkdirSync } from 'fs'
import { mkdir, readdir, stat, statfs, unlink, writeFile } from 'fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve, sep } from 'path'
import {
  DEFAULT_CLOUD_SYNC_SERVER_URL,
  DEFAULT_SEGMENT_DURATION_MS,
  LOW_DISK_SPACE_THRESHOLD_BYTES,
  RECORDING_FILE_PREFIX,
  RECORDING_METADATA_DB_FILE_NAME,
  VIDEO_FILE_EXTENSIONS,
  createRecordingFileName,
  getMimeTypeByExtension,
  getPosterPathByVideoPath,
  getRecordingsDirectoryPath,
  getVideoExtensionFromMimeType,
  probeVideoDurationSec
} from './mediaUtils'

function parseDataUrl(dataUrl = '') {
  if (typeof dataUrl !== 'string') {
    return null
  }

  const matched = dataUrl.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/)
  if (!matched) {
    return null
  }

  try {
    return {
      mimeType: matched[1] || '',
      buffer: Buffer.from(matched[2], 'base64')
    }
  } catch {
    return null
  }
}

let recordingMetadataDb = null

/** 获取录制元数据库连接，并在首次访问时完成建表。 */
function getRecordingMetadataDatabase() {
  if (recordingMetadataDb) {
    return recordingMetadataDb
  }

  mkdirSync(getRecordingsDirectoryPath(), { recursive: true })
  const dbPath = join(getRecordingsDirectoryPath(), RECORDING_METADATA_DB_FILE_NAME)
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS recordings (
      -- file_path: 最终录屏文件的绝对路径，也是元数据主键。
      file_path TEXT PRIMARY KEY,
      -- duration_sec: 探测出的最终录屏时长，单位秒。
      duration_sec REAL,
      -- updated_at: 这条录屏元数据最后一次写入时间戳。
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recording_cloud_sync_state (
      -- file_path: 对应最终录屏文件的绝对路径，和 recordings 一一对应。
      file_path TEXT PRIMARY KEY,
      -- cloud_sync_json: 最终录屏对应的云同步摘要 JSON。
      cloud_sync_json TEXT,
      -- updated_at: 云同步元数据最后一次写入时间戳。
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recording_sessions (
      -- session_id: 一次录屏会话的唯一标识。
      session_id TEXT PRIMARY KEY,
      -- session_dir: 该会话临时目录的绝对路径。
      session_dir TEXT NOT NULL,
      -- extension: 当前录屏产物使用的文件扩展名。
      extension TEXT NOT NULL,
      -- mime_type: 本次录屏实际采用的 MIME 类型。
      mime_type TEXT NOT NULL,
      -- segment_duration_ms: 预期分段时长，单位毫秒。
      segment_duration_ms INTEGER NOT NULL,
      -- status: 会话状态，如 recording/stopped/interrupted/cancelled。
      status TEXT NOT NULL,
      -- started_at: 会话开始时间戳。
      started_at INTEGER,
      -- stopped_at: 会话停止时间戳。
      stopped_at INTEGER,
      -- total_bytes: 当前累计写入的总字节数。
      total_bytes INTEGER NOT NULL,
      -- output_path: 最终输出成片的绝对路径。
      output_path TEXT,
      -- output_status: 最终输出状态，如 ready/failed/pending。
      output_status TEXT,
      -- output_bytes: 最终输出文件大小。
      output_bytes INTEGER,
      -- output_created_at: 最终输出文件生成时间戳。
      output_created_at INTEGER,
      -- output_duration_sec: 最终输出文件时长，单位秒。
      output_duration_sec REAL,
      -- cloud_sync_enabled: 是否启用云同步，0/1。
      cloud_sync_enabled INTEGER NOT NULL,
      -- cloud_sync_status: 当前云同步状态，如 pending/syncing/completed/failed。
      cloud_sync_status TEXT NOT NULL DEFAULT 'disabled',
      -- cloud_server_url: 云同步服务地址。
      cloud_server_url TEXT,
      -- cloud_remote_video_url: 服务端合并后返回的远端视频地址。
      cloud_remote_video_url TEXT,
      -- cloud_completed_at: 云同步完成时间戳。
      cloud_completed_at INTEGER,
      -- cloud_last_error: 最近一次云同步失败信息。
      cloud_last_error TEXT,
      -- cloud_last_attempt_at: 最近一次尝试上传/合并的时间戳。
      cloud_last_attempt_at INTEGER,
      -- cloud_next_retry_at: 下一次计划重试的时间戳。
      cloud_next_retry_at INTEGER,
      -- updated_at: 会话记录最后一次持久化时间戳。
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recording_session_segments (
      -- session_id: 所属录屏会话 id。
      session_id TEXT NOT NULL,
      -- segment_index: 会话内分段/分片序号。
      segment_index INTEGER NOT NULL,
      -- file_path: 分段正式文件绝对路径。
      file_path TEXT,
      -- partial_path: 中断或未封段时的临时 part 文件路径。
      partial_path TEXT,
      -- status: 分段状态，如 writing/ready/interrupted/missing。
      status TEXT,
      -- upload_status: 云同步上传状态，如 pending/uploading/uploaded/failed。
      upload_status TEXT,
      -- bytes: 当前分段的字节数。
      bytes INTEGER,
      -- checksum: 上传成功后记录的分段校验值。
      checksum TEXT,
      -- etag: 服务端返回的分段 etag。
      etag TEXT,
      -- uploaded_at: 分段上传完成时间戳。
      uploaded_at INTEGER,
      -- retry_count: 当前分段上传重试次数。
      retry_count INTEGER,
      -- started_at: 分段开始写入时间戳。
      started_at INTEGER,
      -- ended_at: 分段结束写入或中断时间戳。
      ended_at INTEGER,
      -- updated_at: 分段记录最后一次持久化时间戳。
      updated_at INTEGER NOT NULL,
      -- PRIMARY KEY(session_id, segment_index): 保证一个会话内每个序号只对应一条分段记录。
      PRIMARY KEY (session_id, segment_index)
    );
  `)
  recordingMetadataDb = db
  return db
}

/** 在单个事务中执行同步 SQLite 操作，失败时自动回滚。 */
function runDatabaseTransaction(db, work) {
  db.exec('BEGIN')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 忽略回滚失败，优先抛出最初的业务错误。
    }
    throw error
  }
}

const SESSION_SELECT = `
  SELECT
    session_id AS sessionId,
    session_dir AS sessionDir,
    extension,
    mime_type AS mimeType,
    segment_duration_ms AS segmentDurationMs,
    status,
    started_at AS startedAt,
    stopped_at AS stoppedAt,
    total_bytes AS totalBytes,
    output_path AS outputPath,
    output_status AS outputStatus,
    output_bytes AS outputBytes,
    output_created_at AS outputCreatedAt,
    output_duration_sec AS outputDurationSec,
    cloud_sync_enabled AS cloudSyncEnabled,
    cloud_sync_status AS cloudSyncStatus,
    cloud_server_url AS cloudServerUrl,
    cloud_remote_video_url AS cloudRemoteVideoUrl,
    cloud_completed_at AS cloudCompletedAt,
    cloud_last_error AS cloudLastError,
    cloud_last_attempt_at AS cloudLastAttemptAt,
    cloud_next_retry_at AS cloudNextRetryAt,
    updated_at AS updatedAt
  FROM recording_sessions
`

const SEGMENT_SELECT = `
  SELECT
    segment_index AS "index",
    file_path AS filePath,
    partial_path AS partialPath,
    status,
    upload_status AS uploadStatus,
    bytes,
    checksum,
    etag,
    uploaded_at AS uploadedAt,
    retry_count AS retryCount,
    started_at AS startedAt,
    ended_at AS endedAt,
    updated_at AS updatedAt
  FROM recording_session_segments
`

/** 从数据库记录恢复运行时会话。 */
export function createRuntimeSessionFromDatabase(sessionRow, segmentRows) {
  const sessionId = String(sessionRow?.sessionId || '').trim()
  if (!sessionId) {
    return null
  }

  const segments = segmentRows.map((segment) => {
    const filePath = segment.filePath ? resolve(segment.filePath) : ''
    return {
      index: Number(segment.index || 0),
      fileName: filePath ? filePath.split(sep).pop() || '' : '',
      path: filePath,
      partialPath: segment.partialPath ? resolve(segment.partialPath) : '',
      startedAt: Number(segment.startedAt || 0) || null,
      endedAt: Number(segment.endedAt || 0) || null,
      bytes: Number(segment.bytes || 0),
      status: segment.status || 'ready',
      uploadStatus: segment.uploadStatus || 'disabled',
      checksum: segment.checksum || '',
      etag: segment.etag || '',
      uploadedAt: Number(segment.uploadedAt || 0) || null,
      retryCount: Number(segment.retryCount || 0)
    }
  })

  const cloudSyncEnabled = Boolean(sessionRow.cloudSyncEnabled)
  const cloudServerUrl = sessionRow.cloudServerUrl || ''
  const failedParts = segments.filter((segment) => segment.uploadStatus === 'failed').length
  const pendingParts = segments.filter(
    (segment) =>
      segment.status === 'ready' &&
      segment.uploadStatus !== 'uploaded' &&
      segment.uploadStatus !== 'disabled'
  ).length

  let cloudSyncStatus = sessionRow.cloudSyncStatus || (cloudSyncEnabled ? 'pending' : 'disabled')
  if (
    cloudSyncEnabled &&
    cloudSyncStatus === 'completed' &&
    (pendingParts > 0 || failedParts > 0)
  ) {
    cloudSyncStatus = failedParts > 0 ? 'failed' : 'syncing'
  }

  const extension = sessionRow.extension || 'webm'
  return {
    id: sessionId,
    dir: sessionRow.sessionDir,
    writeQueue: Promise.resolve(),
    writeStream: null,
    partWriteStream: null,
    captureTempPath: '',
    currentSegment: null,
    manifest: {
      version: 2,
      sessionId,
      sessionDir: sessionRow.sessionDir,
      extension,
      mimeType: sessionRow.mimeType || getMimeTypeByExtension(extension),
      segmentDurationMs: Number(sessionRow.segmentDurationMs || DEFAULT_SEGMENT_DURATION_MS),
      cloudSyncEnabled,
      cloudSync: {
        enabled: cloudSyncEnabled,
        serverUrl: cloudSyncEnabled ? cloudServerUrl : '',
        status: cloudSyncStatus,
        remoteVideoUrl: sessionRow.cloudRemoteVideoUrl || '',
        lastError: sessionRow.cloudLastError || '',
        completedAt: Number(sessionRow.cloudCompletedAt || 0) || null,
        lastAttemptAt: Number(sessionRow.cloudLastAttemptAt || 0) || null,
        nextRetryAt: Number(sessionRow.cloudNextRetryAt || 0) || null
      },
      status: sessionRow.status || 'interrupted',
      startedAt: Number(sessionRow.startedAt || 0) || Date.now(),
      stoppedAt: Number(sessionRow.stoppedAt || 0) || null,
      updatedAt: Number(sessionRow.updatedAt || Date.now()),
      totalBytes: Number(sessionRow.totalBytes || 0),
      output: sessionRow.outputPath
        ? {
            path: resolve(sessionRow.outputPath),
            status: sessionRow.outputStatus || 'pending',
            bytes: Number(sessionRow.outputBytes || 0),
            createdAt: Number(sessionRow.outputCreatedAt || 0),
            durationSec: Number(sessionRow.outputDurationSec || 0) || null
          }
        : null,
      segments
    }
  }
}

/** 读取某个最终录屏文件的时长和云同步元数据。 */
export function readRecordingMetadata(filePath) {
  const db = getRecordingMetadataDatabase()
  const row = db
    .prepare(
      `
        SELECT
          recordings.duration_sec AS durationSec,
          recording_cloud_sync_state.cloud_sync_json AS cloudSyncJson
        FROM recordings
        LEFT JOIN recording_cloud_sync_state
          ON recording_cloud_sync_state.file_path = recordings.file_path
        WHERE recordings.file_path = ?
      `
    )
    .get(resolve(filePath))

  if (!row || typeof row !== 'object') {
    return null
  }

  let cloudSync = null
  if (typeof row.cloudSyncJson === 'string' && row.cloudSyncJson.trim()) {
    try {
      cloudSync = JSON.parse(row.cloudSyncJson)
    } catch {
      cloudSync = null
    }
  }

  const durationSec = Number(row.durationSec || 0)
  return {
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
    cloudSync: cloudSync && typeof cloudSync === 'object' ? cloudSync : null
  }
}

/** 写入或更新某个最终录屏文件的元数据。 */
export function writeRecordingMetadata(filePath, metadata) {
  const db = getRecordingMetadataDatabase()
  const durationSec = Number(metadata?.durationSec || 0)
  const cloudSyncJson =
    metadata?.cloudSync && typeof metadata.cloudSync === 'object'
      ? JSON.stringify(metadata.cloudSync)
      : null

  const normalizedPath = resolve(filePath)
  const updatedAt = Date.now()
  runDatabaseTransaction(db, () => {
    db.prepare(
      `
        INSERT INTO recordings (file_path, duration_sec, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
          duration_sec = excluded.duration_sec,
          updated_at = excluded.updated_at
      `
    ).run(
      normalizedPath,
      Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
      updatedAt
    )

    if (cloudSyncJson) {
      db.prepare(
        `
          INSERT INTO recording_cloud_sync_state (file_path, cloud_sync_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(file_path) DO UPDATE SET
            cloud_sync_json = excluded.cloud_sync_json,
            updated_at = excluded.updated_at
        `
      ).run(normalizedPath, cloudSyncJson, updatedAt)
      return
    }

    db.prepare('DELETE FROM recording_cloud_sync_state WHERE file_path = ?').run(normalizedPath)
  })
}

/** 在录屏文件删除后移除其元数据记录。 */
export function deleteRecordingMetadataFromDatabase(filePath) {
  const db = getRecordingMetadataDatabase()
  const normalizedPath = resolve(filePath)
  runDatabaseTransaction(db, () => {
    db.prepare('DELETE FROM recording_cloud_sync_state WHERE file_path = ?').run(normalizedPath)
    db.prepare('DELETE FROM recordings WHERE file_path = ?').run(normalizedPath)
  })
}

/** 把当前运行时会话及其全部分段状态同步到 SQLite。 */
export function syncRecordingSessionToDatabase(runtimeSession) {
  if (!runtimeSession?.id || !runtimeSession?.manifest) {
    return
  }

  const db = getRecordingMetadataDatabase()
  const output = runtimeSession.manifest.output || null
  const updatedAt = Number(runtimeSession.manifest.updatedAt || Date.now())
  const cloudSync = runtimeSession.manifest.cloudSync || {}

  runDatabaseTransaction(db, () => {
    db.prepare(
      `
        INSERT INTO recording_sessions (
          session_id,
          session_dir,
          extension,
          mime_type,
          segment_duration_ms,
          status,
          started_at,
          stopped_at,
          total_bytes,
          output_path,
          output_status,
          output_bytes,
          output_created_at,
          output_duration_sec,
          cloud_sync_enabled,
          cloud_sync_status,
          cloud_server_url,
          cloud_remote_video_url,
          cloud_completed_at,
          cloud_last_error,
          cloud_last_attempt_at,
          cloud_next_retry_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          session_dir = excluded.session_dir,
          extension = excluded.extension,
          mime_type = excluded.mime_type,
          segment_duration_ms = excluded.segment_duration_ms,
          status = excluded.status,
          started_at = excluded.started_at,
          stopped_at = excluded.stopped_at,
          total_bytes = excluded.total_bytes,
          output_path = excluded.output_path,
          output_status = excluded.output_status,
          output_bytes = excluded.output_bytes,
          output_created_at = excluded.output_created_at,
          output_duration_sec = excluded.output_duration_sec,
          cloud_sync_enabled = excluded.cloud_sync_enabled,
          cloud_sync_status = excluded.cloud_sync_status,
          cloud_server_url = excluded.cloud_server_url,
          cloud_remote_video_url = excluded.cloud_remote_video_url,
          cloud_completed_at = excluded.cloud_completed_at,
          cloud_last_error = excluded.cloud_last_error,
          cloud_last_attempt_at = excluded.cloud_last_attempt_at,
          cloud_next_retry_at = excluded.cloud_next_retry_at,
          updated_at = excluded.updated_at
      `
    ).run(
      runtimeSession.id,
      runtimeSession.dir,
      runtimeSession.manifest.extension,
      runtimeSession.manifest.mimeType,
      Number(runtimeSession.manifest.segmentDurationMs || DEFAULT_SEGMENT_DURATION_MS),
      runtimeSession.manifest.status,
      Number(runtimeSession.manifest.startedAt || 0) || null,
      Number(runtimeSession.manifest.stoppedAt || 0) || null,
      Number(runtimeSession.manifest.totalBytes || 0),
      output?.path ? resolve(output.path) : null,
      output?.status || null,
      Number(output?.bytes || 0) || null,
      Number(output?.createdAt || 0) || null,
      Number(output?.durationSec || 0) || null,
      runtimeSession.manifest.cloudSyncEnabled ? 1 : 0,
      cloudSync.status || (runtimeSession.manifest.cloudSyncEnabled ? 'pending' : 'disabled'),
      cloudSync.serverUrl || null,
      cloudSync.remoteVideoUrl || null,
      Number(cloudSync.completedAt || 0) || null,
      cloudSync.lastError || null,
      Number(cloudSync.lastAttemptAt || 0) || null,
      Number(cloudSync.nextRetryAt || 0) || null,
      updatedAt
    )

    db.prepare('DELETE FROM recording_session_segments WHERE session_id = ?').run(runtimeSession.id)
    const insertSegment = db.prepare(
      `
        INSERT INTO recording_session_segments (
          session_id,
          segment_index,
          file_path,
          partial_path,
          status,
          upload_status,
          bytes,
          checksum,
          etag,
          uploaded_at,
          retry_count,
          started_at,
          ended_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )

    for (const segment of runtimeSession.manifest.segments) {
      insertSegment.run(
        runtimeSession.id,
        Number(segment.index || 0),
        segment.path ? resolve(segment.path) : null,
        segment.partialPath ? resolve(segment.partialPath) : null,
        segment.status || null,
        segment.uploadStatus || null,
        Number(segment.bytes || 0),
        segment.checksum || null,
        segment.etag || null,
        Number(segment.uploadedAt || 0) || null,
        Number(segment.retryCount || 0),
        Number(segment.startedAt || 0) || null,
        Number(segment.endedAt || 0) || null,
        updatedAt
      )
    }
  })
}

/** 删除某个会话在 SQLite 中的主记录和分段记录。 */
export function deleteRecordingSessionFromDatabase(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return
  }

  const db = getRecordingMetadataDatabase()
  runDatabaseTransaction(db, () => {
    db.prepare('DELETE FROM recording_session_segments WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM recording_sessions WHERE session_id = ?').run(sessionId)
  })
}

/** 按条件列出需要恢复本地合并的录屏会话。 */
export function listLocalRecordingSessionRowsFromDatabase() {
  const db = getRecordingMetadataDatabase()
  return db
    .prepare(
      `
        ${SESSION_SELECT}
        WHERE status IN ('recording', 'stopped', 'interrupted')
          AND (cloud_sync_enabled = 0 OR cloud_sync_enabled IS NULL)
        ORDER BY updated_at ASC
      `
    )
    .all()
}

/** 按条件列出启用云同步的录屏会话。 */
export function listCloudSyncSessionRowsFromDatabase() {
  const db = getRecordingMetadataDatabase()
  return db
    .prepare(
      `
        ${SESSION_SELECT}
        WHERE cloud_sync_enabled = 1
        ORDER BY updated_at ASC
      `
    )
    .all()
}

/** 读取单个录屏会话的主记录和全部分段记录。 */
function readRecordingSessionRows(sessionId) {
  const db = getRecordingMetadataDatabase()
  const sessionRow = db
    .prepare(
      `
        ${SESSION_SELECT}
        WHERE session_id = ?
      `
    )
    .get(sessionId)

  if (!sessionRow) {
    return null
  }

  const segmentRows = db
    .prepare(
      `
        ${SEGMENT_SELECT}
        WHERE session_id = ?
        ORDER BY segment_index ASC
      `
    )
    .all(sessionId)

  return { sessionRow, segmentRows }
}

/** 读取单个本地录屏会话记录。 */
export function readRecordingSessionRowsFromDatabase(sessionId) {
  return readRecordingSessionRows(sessionId)
}

/** 读取单个云同步录屏会话记录。 */
export function readCloudSyncSessionRowsFromDatabase(sessionId) {
  return readRecordingSessionRows(sessionId)
}

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
export function createRecordingSessionState({
  sessionId,
  sessionDir,
  extension,
  mimeType,
  segmentDurationMs,
  cloudSyncEnabled = false,
  cloudSyncServerUrl = ''
}) {
  const now = Date.now()
  const cloudSyncServerUrlCandidate =
    typeof cloudSyncServerUrl === 'string' && cloudSyncServerUrl.trim()
      ? cloudSyncServerUrl.trim()
      : process.env.CLOUD_SYNC_SERVER_URL || DEFAULT_CLOUD_SYNC_SERVER_URL
  const normalizedCloudSyncServerUrl = cloudSyncEnabled
    ? cloudSyncServerUrlCandidate.replace(/\/+$/, '')
    : ''
  return {
    version: 2,
    sessionId,
    sessionDir,
    extension,
    mimeType,
    segmentDurationMs,
    cloudSyncEnabled,
    cloudSync: {
      enabled: cloudSyncEnabled,
      serverUrl: normalizedCloudSyncServerUrl,
      status: cloudSyncEnabled ? 'pending' : 'disabled',
      remoteVideoUrl: '',
      lastError: '',
      completedAt: null,
      lastAttemptAt: null,
      nextRetryAt: null
    },
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
export async function buildRecordingItem(filePath, fileStat) {
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
export async function listRecordingItems() {
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

  items.sort((left, right) => right.createdAt - left.createdAt)
  return items
}

/** 将渲染进程传来的 data URL 直接保存为一个最终录屏文件。 */
export async function saveRecordingFromDataUrl(payload = {}) {
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
    item: await buildRecordingItem(filePath, fileStat)
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
    },
    storage
  }
}
