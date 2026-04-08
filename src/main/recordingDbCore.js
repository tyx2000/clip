import { mkdirSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'path'
import { RECORDING_METADATA_DB_FILE_NAME, getRecordingsDirectoryPath } from './recordingPaths'

let recordingMetadataDb = null

/** Returns the absolute SQLite path used by the recording subsystem. */
export function getRecordingMetadataDatabasePath() {
  return join(getRecordingsDirectoryPath(), RECORDING_METADATA_DB_FILE_NAME)
}

/** Opens the SQLite database and creates required tables on first access. */
export function getRecordingMetadataDatabase() {
  if (recordingMetadataDb) {
    return recordingMetadataDb
  }

  mkdirSync(getRecordingsDirectoryPath(), { recursive: true })
  const db = new DatabaseSync(getRecordingMetadataDatabasePath())
  db.exec(`
    CREATE TABLE IF NOT EXISTS recordings (
      file_path TEXT PRIMARY KEY,
      duration_sec REAL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recording_cloud_sync_state (
      file_path TEXT PRIMARY KEY,
      cloud_sync_json TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recording_sessions (
      session_id TEXT PRIMARY KEY,
      session_dir TEXT NOT NULL,
      extension TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      segment_duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER,
      stopped_at INTEGER,
      total_bytes INTEGER NOT NULL,
      output_path TEXT,
      output_status TEXT,
      output_bytes INTEGER,
      output_created_at INTEGER,
      output_duration_sec REAL,
      cloud_sync_enabled INTEGER NOT NULL,
      cloud_sync_status TEXT NOT NULL DEFAULT 'disabled',
      cloud_server_url TEXT,
      cloud_remote_video_url TEXT,
      cloud_completed_at INTEGER,
      cloud_last_error TEXT,
      cloud_last_attempt_at INTEGER,
      cloud_next_retry_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recording_session_segments (
      session_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      file_path TEXT,
      partial_path TEXT,
      status TEXT,
      upload_status TEXT,
      bytes INTEGER,
      checksum TEXT,
      etag TEXT,
      uploaded_at INTEGER,
      retry_count INTEGER,
      started_at INTEGER,
      ended_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, segment_index)
    );
  `)
  runRecordingMetadataMigrations(db)
  recordingMetadataDb = db
  return db
}

function tableExists(db, tableName) {
  const row = db
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
      `
    )
    .get(tableName)

  return Boolean(row?.name)
}

function getTableColumns(db, tableName) {
  if (!tableExists(db, tableName)) {
    return []
  }

  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((column) => String(column?.name || ''))
}

function ensureColumn(db, tableName, columnName, sqlDefinition) {
  const columns = getTableColumns(db, tableName)
  if (columns.includes(columnName)) {
    return
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqlDefinition};`)
}

function mapLegacyCloudStatus(row = {}) {
  const mergeStatus = String(row?.mergeStatus || '').trim()
  const uploadStatus = String(row?.uploadStatus || '').trim()

  if (mergeStatus === 'merged') {
    return 'completed'
  }

  if (mergeStatus === 'merging') {
    return 'merging'
  }

  if (mergeStatus === 'merge_failed' || uploadStatus === 'failed') {
    return 'failed'
  }

  if (uploadStatus === 'uploading' || uploadStatus === 'uploaded' || uploadStatus === 'receiving') {
    return 'syncing'
  }

  return 'pending'
}

function pickUpdatedValue(currentValue, currentUpdatedAt, incomingValue, incomingUpdatedAt) {
  const currentTime = Number(currentUpdatedAt || 0)
  const incomingTime = Number(incomingUpdatedAt || 0)
  return incomingTime >= currentTime ? incomingValue : currentValue
}

function migrateLegacyCloudSyncTables(db) {
  if (!tableExists(db, 'cloud_sync_sessions')) {
    return
  }

  const legacySessions = db
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
      `
    )
    .all()

  const legacyParts = tableExists(db, 'cloud_sync_parts')
    ? db
        .prepare(
          `
            SELECT
              session_id AS sessionId,
              part_index AS segmentIndex,
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
            FROM cloud_sync_parts
            ORDER BY session_id ASC, part_index ASC
          `
        )
        .all()
    : []

  const selectSession = db.prepare(
    `
      SELECT
        cloud_sync_status AS cloudSyncStatus,
        cloud_server_url AS cloudServerUrl,
        cloud_remote_video_url AS cloudRemoteVideoUrl,
        cloud_completed_at AS cloudCompletedAt,
        cloud_last_error AS cloudLastError,
        cloud_last_attempt_at AS cloudLastAttemptAt,
        cloud_next_retry_at AS cloudNextRetryAt,
        updated_at AS updatedAt
      FROM recording_sessions
      WHERE session_id = ?
    `
  )
  const updateSession = db.prepare(
    `
      UPDATE recording_sessions
      SET
        output_path = COALESCE(output_path, ?),
        cloud_sync_enabled = 1,
        cloud_sync_status = ?,
        cloud_server_url = ?,
        cloud_remote_video_url = ?,
        cloud_completed_at = ?,
        cloud_last_error = ?,
        cloud_last_attempt_at = ?,
        cloud_next_retry_at = ?,
        updated_at = ?
      WHERE session_id = ?
    `
  )
  const selectSegment = db.prepare(
    `
      SELECT
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
      FROM recording_session_segments
      WHERE session_id = ? AND segment_index = ?
    `
  )
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
      ON CONFLICT(session_id, segment_index) DO UPDATE SET
        file_path = excluded.file_path,
        status = excluded.status,
        upload_status = excluded.upload_status,
        bytes = excluded.bytes,
        checksum = excluded.checksum,
        etag = excluded.etag,
        uploaded_at = excluded.uploaded_at,
        retry_count = excluded.retry_count,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        updated_at = excluded.updated_at
    `
  )

  for (const row of legacySessions) {
    const current = selectSession.get(row.sessionId)
    if (!current) {
      continue
    }

    updateSession.run(
      row.outputPath || null,
      pickUpdatedValue(
        current.cloudSyncStatus || 'disabled',
        current.updatedAt,
        mapLegacyCloudStatus(row),
        row.updatedAt
      ),
      pickUpdatedValue(
        current.cloudServerUrl || null,
        current.updatedAt,
        row.serverUrl || null,
        row.updatedAt
      ),
      pickUpdatedValue(
        current.cloudRemoteVideoUrl || null,
        current.updatedAt,
        row.mergeStatus === 'merged'
          ? `/api/cloud-sync/sessions/${encodeURIComponent(row.sessionId)}/merged`
          : null,
        row.updatedAt
      ),
      pickUpdatedValue(
        current.cloudCompletedAt || null,
        current.updatedAt,
        Number(row.completedAt || 0) || null,
        row.updatedAt
      ),
      pickUpdatedValue(
        current.cloudLastError || null,
        current.updatedAt,
        row.lastError || null,
        row.updatedAt
      ),
      pickUpdatedValue(
        current.cloudLastAttemptAt || null,
        current.updatedAt,
        Number(row.lastAttemptAt || 0) || null,
        row.updatedAt
      ),
      pickUpdatedValue(
        current.cloudNextRetryAt || null,
        current.updatedAt,
        Number(row.nextRetryAt || 0) || null,
        row.updatedAt
      ),
      Math.max(Number(current.updatedAt || 0), Number(row.updatedAt || 0), Date.now()),
      row.sessionId
    )
  }

  for (const row of legacyParts) {
    const current = selectSegment.get(row.sessionId, Number(row.segmentIndex || 0))
    const currentUpdatedAt = current?.updatedAt || 0
    const incomingUpdatedAt = Number(row.updatedAt || 0)
    const useIncoming = incomingUpdatedAt >= Number(currentUpdatedAt || 0)

    insertSegment.run(
      row.sessionId,
      Number(row.segmentIndex || 0),
      useIncoming ? row.filePath || null : current?.filePath || null,
      null,
      useIncoming ? row.status || null : current?.status || null,
      useIncoming ? row.uploadStatus || null : current?.uploadStatus || null,
      useIncoming ? Number(row.bytes || 0) : Number(current?.bytes || 0),
      useIncoming ? row.checksum || null : current?.checksum || null,
      useIncoming ? row.etag || null : current?.etag || null,
      useIncoming ? Number(row.uploadedAt || 0) || null : Number(current?.uploadedAt || 0) || null,
      useIncoming ? Number(row.retryCount || 0) : Number(current?.retryCount || 0),
      useIncoming ? Number(row.startedAt || 0) || null : Number(current?.startedAt || 0) || null,
      useIncoming ? Number(row.endedAt || 0) || null : Number(current?.endedAt || 0) || null,
      Math.max(Number(currentUpdatedAt || 0), incomingUpdatedAt, Date.now())
    )
  }

  db.exec(`
    DROP TABLE IF EXISTS cloud_sync_parts;
    DROP TABLE IF EXISTS cloud_sync_sessions;
  `)
}

function runRecordingMetadataMigrations(db) {
  ensureColumn(db, 'recording_sessions', 'cloud_sync_status', `TEXT NOT NULL DEFAULT 'disabled'`)
  ensureColumn(db, 'recording_sessions', 'cloud_server_url', 'TEXT')
  ensureColumn(db, 'recording_sessions', 'cloud_remote_video_url', 'TEXT')
  ensureColumn(db, 'recording_sessions', 'cloud_completed_at', 'INTEGER')
  ensureColumn(db, 'recording_sessions', 'cloud_last_error', 'TEXT')
  ensureColumn(db, 'recording_sessions', 'cloud_last_attempt_at', 'INTEGER')
  ensureColumn(db, 'recording_sessions', 'cloud_next_retry_at', 'INTEGER')

  const recordingSessionColumns = getTableColumns(db, 'recording_sessions')
  if (recordingSessionColumns.includes('manifest_path')) {
    runDatabaseTransaction(db, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS recording_sessions_v2 (
          session_id TEXT PRIMARY KEY,
          session_dir TEXT NOT NULL,
          extension TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          segment_duration_ms INTEGER NOT NULL,
          status TEXT NOT NULL,
          started_at INTEGER,
          stopped_at INTEGER,
          total_bytes INTEGER NOT NULL,
          output_path TEXT,
          output_status TEXT,
          output_bytes INTEGER,
          output_created_at INTEGER,
          output_duration_sec REAL,
          cloud_sync_enabled INTEGER NOT NULL,
          cloud_sync_status TEXT NOT NULL DEFAULT 'disabled',
          cloud_server_url TEXT,
          cloud_remote_video_url TEXT,
          cloud_completed_at INTEGER,
          cloud_last_error TEXT,
          cloud_last_attempt_at INTEGER,
          cloud_next_retry_at INTEGER,
          updated_at INTEGER NOT NULL
        );

        INSERT INTO recording_sessions_v2 (
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
        SELECT
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
          'disabled',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          updated_at
        FROM recording_sessions;

        DROP TABLE recording_sessions;
        ALTER TABLE recording_sessions_v2 RENAME TO recording_sessions;
      `)
    })
  }

  runDatabaseTransaction(db, () => {
    migrateLegacyCloudSyncTables(db)
  })
}

/** Runs synchronous SQLite work inside one transaction.
 * @param {DatabaseSync} db Open SQLite connection.
 * @param {() => any} work Synchronous unit of work to run inside BEGIN/COMMIT.
 */
export function runDatabaseTransaction(db, work) {
  db.exec('BEGIN')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Ignore rollback errors so the original failure can surface.
    }
    throw error
  }
}
