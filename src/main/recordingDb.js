import { resolve } from 'path'
import { DEFAULT_SEGMENT_DURATION_MS } from './recordingPaths'
import { getRecordingMetadataDatabase, runDatabaseTransaction } from './recordingDbCore'
export {
  createRuntimeSessionFromCloudSyncDatabaseRecord,
  createRuntimeSessionFromRecordingDatabaseRecord
} from './recordingDbRuntime'

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

export function deleteRecordingMetadataFromDatabase(filePath) {
  const db = getRecordingMetadataDatabase()
  const normalizedPath = resolve(filePath)
  runDatabaseTransaction(db, () => {
    db.prepare('DELETE FROM recording_cloud_sync_state WHERE file_path = ?').run(normalizedPath)
    db.prepare('DELETE FROM recordings WHERE file_path = ?').run(normalizedPath)
  })
}

export function syncCloudSessionToDatabase(runtimeSession) {
  if (!runtimeSession?.manifest?.cloudSyncEnabled) {
    return
  }

  const db = getRecordingMetadataDatabase()
  const outputPath = runtimeSession.manifest.output?.path
    ? resolve(runtimeSession.manifest.output.path)
    : null
  const updatedAt = Number(runtimeSession.manifest.updatedAt || Date.now())
  const cloudSync = runtimeSession.manifest.cloudSync || {}

  runDatabaseTransaction(db, () => {
    db.prepare(
      `
        INSERT INTO cloud_sync_sessions (
          session_id,
          output_path,
          status,
          upload_status,
          merge_status,
          server_url,
          completed_at,
          last_error,
          last_attempt_at,
          next_retry_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          output_path = excluded.output_path,
          status = excluded.status,
          upload_status = excluded.upload_status,
          merge_status = excluded.merge_status,
          server_url = excluded.server_url,
          completed_at = excluded.completed_at,
          last_error = excluded.last_error,
          last_attempt_at = excluded.last_attempt_at,
          next_retry_at = excluded.next_retry_at,
          updated_at = excluded.updated_at
      `
    ).run(
      runtimeSession.id,
      outputPath,
      runtimeSession.manifest.status,
      cloudSync.uploadStatus || null,
      cloudSync.mergeStatus || null,
      cloudSync.serverUrl || null,
      Number(cloudSync.completedAt || 0) || null,
      cloudSync.lastError || null,
      Number(cloudSync.lastAttemptAt || 0) || null,
      Number(cloudSync.nextRetryAt || 0) || null,
      updatedAt
    )

    db.prepare('DELETE FROM cloud_sync_segments WHERE session_id = ?').run(runtimeSession.id)
    const insertSegment = db.prepare(
      `
        INSERT INTO cloud_sync_segments (
          session_id,
          segment_index,
          file_path,
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )

    for (const segment of runtimeSession.manifest.segments) {
      insertSegment.run(
        runtimeSession.id,
        Number(segment.index || 0),
        segment.path ? resolve(segment.path) : null,
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

export function deleteCloudSessionFromDatabase(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return
  }

  const db = getRecordingMetadataDatabase()
  runDatabaseTransaction(db, () => {
    db.prepare('DELETE FROM cloud_sync_segments WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM cloud_sync_sessions WHERE session_id = ?').run(sessionId)
  })
}

export function syncRecordingSessionToDatabase(runtimeSession) {
  if (!runtimeSession?.id || !runtimeSession?.manifest) {
    return
  }

  const db = getRecordingMetadataDatabase()
  const output = runtimeSession.manifest.output || null
  const updatedAt = Number(runtimeSession.manifest.updatedAt || Date.now())

  runDatabaseTransaction(db, () => {
    db.prepare(
      `
        INSERT INTO recording_sessions (
          session_id,
          session_dir,
          manifest_path,
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
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          updated_at = excluded.updated_at
      `
    ).run(
      runtimeSession.id,
      runtimeSession.dir,
      '',
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

export function listCloudSyncSessionRowsFromDatabase() {
  const db = getRecordingMetadataDatabase()
  return db
    .prepare(
      `
        SELECT
          session_id AS sessionId,
          output_path AS outputPath,
          status,
          upload_status AS uploadStatus,
          merge_status AS mergeStatus,
          server_url AS serverUrl,
          completed_at AS completedAt,
          last_error AS lastError,
          last_attempt_at AS lastAttemptAt,
          next_retry_at AS nextRetryAt,
          updated_at AS updatedAt
        FROM cloud_sync_sessions
        ORDER BY updated_at DESC
      `
    )
    .all()
}

export function readCloudSyncSessionRowsFromDatabase(sessionId) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!normalizedSessionId) {
    return null
  }

  const db = getRecordingMetadataDatabase()
  const sessionRow = db
    .prepare(
      `
        SELECT
          session_id AS sessionId,
          output_path AS outputPath,
          status,
          upload_status AS uploadStatus,
          merge_status AS mergeStatus,
          server_url AS serverUrl,
          completed_at AS completedAt,
          last_error AS lastError,
          last_attempt_at AS lastAttemptAt,
          next_retry_at AS nextRetryAt,
          updated_at AS updatedAt
        FROM cloud_sync_sessions
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
        SELECT
          segment_index AS "index",
          file_path AS filePath,
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
        FROM cloud_sync_segments
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

export function listLocalRecordingSessionRowsFromDatabase() {
  const db = getRecordingMetadataDatabase()
  return db
    .prepare(
      `
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
          updated_at AS updatedAt
        FROM recording_sessions
        WHERE cloud_sync_enabled = 0
        ORDER BY updated_at DESC
      `
    )
    .all()
}

export function readRecordingSessionRowsFromDatabase(sessionId) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!normalizedSessionId) {
    return null
  }

  const db = getRecordingMetadataDatabase()
  const sessionRow = db
    .prepare(
      `
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
          updated_at AS updatedAt
        FROM recording_sessions
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
