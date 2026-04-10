/** 文件作用：负责录制元数据 SQLite 的连接创建与当前表结构初始化。 */
import { mkdirSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'path'
import { RECORDING_METADATA_DB_FILE_NAME, getRecordingsDirectoryPath } from './recordingPaths'

let recordingMetadataDb = null

/**
 * 返回录制元数据库文件的绝对路径。
 */
export function getRecordingMetadataDatabasePath() {
  return join(getRecordingsDirectoryPath(), RECORDING_METADATA_DB_FILE_NAME)
}

/**
 * 获取录制元数据库连接，并在首次访问时完成建表。
 */
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
  recordingMetadataDb = db
  return db
}

/**
 * 在单个事务中执行同步 SQLite 操作，失败时自动回滚。
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
      // 忽略回滚失败，优先抛出最初的业务错误。
    }
    throw error
  }
}
