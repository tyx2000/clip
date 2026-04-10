/** 文件作用：封装录屏相关的高层 SQLite 读写接口。 */
import { resolve, sep } from 'path'
import { DEFAULT_SEGMENT_DURATION_MS, getMimeTypeByExtension } from './recordingPaths'
import { getRecordingMetadataDatabase, runDatabaseTransaction } from './recordingDbCore'

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

/** 把录屏元数据查询结果归一化成目录层可消费的结构。 */
function normalizeRecordingMetadataRecord(row) {
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

/** 根据会话行和分段行恢复云同步状态摘要。 */
function normalizeCloudSyncStateFromSessionRow(
  sessionRow = {},
  segmentRows = [],
  createCloudSyncState
) {
  const enabled = Boolean(sessionRow?.cloudSyncEnabled)
  const serverUrl = sessionRow?.cloudServerUrl || ''
  const failedParts = segmentRows.filter((segment) => segment.uploadStatus === 'failed').length
  const pendingParts = segmentRows.filter(
    (segment) =>
      segment.status === 'ready' &&
      segment.uploadStatus !== 'uploaded' &&
      segment.uploadStatus !== 'disabled'
  ).length

  let status = sessionRow?.cloudSyncStatus || (enabled ? 'pending' : 'disabled')
  if (enabled && status === 'completed' && (pendingParts > 0 || failedParts > 0)) {
    status = failedParts > 0 ? 'failed' : 'syncing'
  }

  return {
    ...createCloudSyncState({ enabled, serverUrl }),
    enabled,
    serverUrl,
    status,
    remoteVideoUrl: sessionRow?.cloudRemoteVideoUrl || '',
    lastError: sessionRow?.cloudLastError || '',
    completedAt: Number(sessionRow?.cloudCompletedAt || 0) || null,
    lastAttemptAt: Number(sessionRow?.cloudLastAttemptAt || 0) || null,
    nextRetryAt: Number(sessionRow?.cloudNextRetryAt || 0) || null
  }
}

/** 把数据库中的分段行归一化为内存中的分段结构。 */
function normalizeSegments(segmentRows = []) {
  return segmentRows.map((segment) => {
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
}

/** 将数据库记录组合成一个完整的运行时会话对象。 */
function createSessionStateFromDatabaseRecord(
  sessionRow,
  segmentRows,
  createCloudSyncState,
  createRuntimeSession
) {
  const sessionId = String(sessionRow?.sessionId || '').trim()
  if (!sessionId) {
    return null
  }

  const normalizedSegments = normalizeSegments(segmentRows)
  const extension = sessionRow.extension || 'webm'
  const sessionState = {
    version: 2,
    sessionId,
    sessionDir: sessionRow.sessionDir,
    extension,
    mimeType: sessionRow.mimeType || getMimeTypeByExtension(extension),
    segmentDurationMs: Number(sessionRow.segmentDurationMs || DEFAULT_SEGMENT_DURATION_MS),
    cloudSyncEnabled: Boolean(sessionRow.cloudSyncEnabled),
    cloudSync: normalizeCloudSyncStateFromSessionRow(
      sessionRow,
      normalizedSegments,
      createCloudSyncState
    ),
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
    segments: normalizedSegments
  }

  return createRuntimeSession(sessionState)
}

/** 从本地录屏数据库记录恢复运行时会话。 */
export function createRuntimeSessionFromRecordingDatabaseRecord(
  sessionRow,
  segmentRows,
  createRuntimeSession,
  createCloudSyncState = () => ({ enabled: false, status: 'disabled' })
) {
  return createSessionStateFromDatabaseRecord(
    sessionRow,
    segmentRows,
    createCloudSyncState,
    createRuntimeSession
  )
}

/** 从云同步数据库记录恢复运行时会话。 */
export function createRuntimeSessionFromCloudSyncDatabaseRecord(
  sessionRow,
  segmentRows,
  createCloudSyncState,
  createRuntimeSession
) {
  return createSessionStateFromDatabaseRecord(
    sessionRow,
    segmentRows,
    createCloudSyncState,
    createRuntimeSession
  )
}

/** 读取某个最终录屏文件的时长和云同步元数据。 */
export function readRecordingMetadataFromDatabase(filePath) {
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

  return normalizeRecordingMetadataRecord(row)
}

/** 写入或更新某个最终录屏文件的元数据。 */
export function writeRecordingMetadataToDatabase(filePath, metadata) {
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

/** 列出所有开启云同步的会话记录。 */
export function listCloudSyncSessionRowsFromDatabase() {
  const db = getRecordingMetadataDatabase()
  return db
    .prepare(
      `
        ${SESSION_SELECT}
        WHERE cloud_sync_enabled = 1
        ORDER BY updated_at DESC
      `
    )
    .all()
}

/** 读取单个云同步会话记录。 */
export function readCloudSyncSessionRowsFromDatabase(sessionId) {
  return readRecordingSessionRowsFromDatabase(sessionId)
}

/** 列出所有本地录制会话记录。 */
export function listLocalRecordingSessionRowsFromDatabase() {
  const db = getRecordingMetadataDatabase()
  return db
    .prepare(
      `
        ${SESSION_SELECT}
        WHERE cloud_sync_enabled = 0
        ORDER BY updated_at DESC
      `
    )
    .all()
}

/** 按 sessionId 读取一条完整的会话记录及其分段记录。 */
export function readRecordingSessionRowsFromDatabase(sessionId) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!normalizedSessionId) {
    return null
  }

  const db = getRecordingMetadataDatabase()
  const sessionRow = db
    .prepare(
      `
        ${SESSION_SELECT}
        WHERE session_id = ?
      `
    )
    .get(normalizedSessionId)

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
    .all(normalizedSessionId)

  return {
    sessionRow,
    segmentRows
  }
}
