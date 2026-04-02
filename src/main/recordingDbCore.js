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
      manifest_path TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS cloud_sync_sessions (
      session_id TEXT PRIMARY KEY,
      output_path TEXT,
      status TEXT NOT NULL,
      upload_status TEXT,
      merge_status TEXT,
      server_url TEXT,
      completed_at INTEGER,
      last_error TEXT,
      last_attempt_at INTEGER,
      next_retry_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cloud_sync_parts (
      session_id TEXT NOT NULL,
      part_index INTEGER NOT NULL,
      file_path TEXT,
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
      PRIMARY KEY (session_id, part_index)
    );
  `)
  recordingMetadataDb = db
  return db
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
