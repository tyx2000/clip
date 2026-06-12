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

// 这个兜底解析只服务“直接保存最终文件”的路径，不参与分段录制主链路。
// 返回 null 而不是抛异常，目的是让上层统一以 ok:false 形式反馈给 renderer。
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

// SQLite 连接做成模块级单例，避免每次查询都重新打开数据库句柄。
let recordingMetadataDb = null
const RECORDING_CUT_FILE_PREFIX = 'cut-'

function isKnownRecordingOutputFileName(fileName) {
  return (
    fileName.startsWith(RECORDING_FILE_PREFIX) || fileName.startsWith(RECORDING_CUT_FILE_PREFIX)
  )
}

function ensureRecordingsSourceColumn(db) {
  const columns = db.prepare('PRAGMA table_info(recordings)').all()
  const hasSourceColumn = columns.some((column) => column?.name === 'source_json')
  if (!hasSourceColumn) {
    db.exec('ALTER TABLE recordings ADD COLUMN source_json TEXT')
  }
}

function parseJsonObject(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }

  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 获取录制元数据库连接，并在首次访问时完成建表。 */
function getRecordingMetadataDatabase() {
  if (recordingMetadataDb) {
    return recordingMetadataDb
  }

  // 先确保父目录存在，否则 SQLite 会因为路径不存在而无法创建数据库文件。
  mkdirSync(getRecordingsDirectoryPath(), { recursive: true })
  const dbPath = join(getRecordingsDirectoryPath(), RECORDING_METADATA_DB_FILE_NAME)
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS recordings (
      -- file_path: 最终录屏文件的绝对路径，也是元数据主键。
      file_path TEXT PRIMARY KEY,
      -- duration_sec: 探测出的最终录屏时长，单位秒。
      duration_sec REAL,
      -- source_json: 可选来源分类，剪辑导出等派生文件用它和原始录制区分。
      source_json TEXT,
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
  ensureRecordingsSourceColumn(db)
  recordingMetadataDb = db
  return db
}

/** 在单个事务中执行同步 SQLite 操作，失败时自动回滚。 */
function runDatabaseTransaction(db, work) {
  // 所有多表写入统一包事务，避免 session 主表和 segment 子表只写进一半。
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
  -- 统一维护会话字段映射，避免不同查询手写别名时出现字段名漂移。
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
  -- 分段字段也集中维护，保证恢复路径和单会话读取路径拿到同一份结构。
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

  /*
   * 输入事实：
   * - 数据库存的是扁平化的 session row + segment rows。
   * - 上层 service / segments / cloudSyncRuntime 只认 runtimeSession 形态。
   *
   * 状态目标：
   * - 构造出一份主进程可直接接管的 runtimeSession。
   * - 把数据库字段恢复成稳定的 manifest / segments 结构。
   *
   * 风险点：
   * - session 级 cloudSyncStatus 可能陈旧。
   * - segment 的 path / retryCount / uploadedAt 可能类型不稳定。
   * - 数据库存的是快照，不代表文件系统一定同步。
   *
   * 顺序约束：
   * - 先恢复 segment 列表，再根据它们反推 session 级 cloudSync 状态。
   * - 文件存在性修正不在这里做，留给 service 层统一处理。
   *
   * 失败后果：
   * - 上层拿到的不是完整 runtimeSession，就会在恢复、上传、状态展示中继续分叉判空。
   */
  // 先把 segment rows 恢复成运行时结构；后续 service 层只认这份内存态对象。
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
  // 这些计数用于反推 session 级上传状态，避免只相信数据库里可能陈旧的 cloudSyncStatus。
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
    // 如果分段仍未全部完成，就纠正掉错误的 completed 状态。
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
      // 这里恢复的是 service 层可直接消费的完整 manifest，而不是数据库原始 row 结构。
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
          recordings.source_json AS sourceJson,
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

  const cloudSync = parseJsonObject(row.cloudSyncJson)
  const source = parseJsonObject(row.sourceJson)

  const durationSec = Number(row.durationSec || 0)
  return {
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
    cloudSync,
    source
  }
}

/** 写入或更新某个最终录屏文件的元数据。 */
export function writeRecordingMetadata(filePath, metadata) {
  /*
   * 输入事实：
   * - 最终成片的基础信息和云同步摘要并不总是同时存在。
   * - 同一个 output 文件在不同阶段可能反复被补写 metadata。
   *
   * 状态目标：
   * - 把最终文件的时长和可选 cloudSync 摘要稳定写回 SQLite。
   * - 保证 recordings 表和 recording_cloud_sync_state 表始终同步表达同一个文件。
   *
   * 风险点：
   * - 只更新一张表会让最终文件元数据出现半同步状态。
   * - cloudSync 为空时如果不删除旧摘要，会把过期云同步状态继续展示给前端。
   *
   * 顺序约束：
   * - 两张表的写入必须在同一事务内完成。
   *
   * 失败后果：
   * - 列表页、播放器、调试面板看到的最终文件状态会和真实状态不一致。
   */
  const db = getRecordingMetadataDatabase()
  const durationSec = Number(metadata?.durationSec || 0)
  const cloudSyncJson =
    metadata?.cloudSync && typeof metadata.cloudSync === 'object'
      ? JSON.stringify(metadata.cloudSync)
      : null
  const shouldUpdateSource = Object.prototype.hasOwnProperty.call(metadata || {}, 'source')
  const sourceJson =
    metadata?.source && typeof metadata.source === 'object' ? JSON.stringify(metadata.source) : null

  const normalizedPath = resolve(filePath)
  const updatedAt = Date.now()
  runDatabaseTransaction(db, () => {
    // recordings 表记录最终成片的基础信息；cloud_sync_state 表单独存可选云同步摘要。
    db.prepare(
      `
        INSERT INTO recordings (file_path, duration_sec, source_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
          duration_sec = excluded.duration_sec,
          source_json = CASE
            WHEN ? THEN excluded.source_json
            ELSE recordings.source_json
          END,
          updated_at = excluded.updated_at
      `
    ).run(
      normalizedPath,
      Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
      shouldUpdateSource ? sourceJson : null,
      updatedAt,
      shouldUpdateSource ? 1 : 0
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

    // 没有 cloudSync 摘要时要主动删掉旧记录，避免文件状态已经变化但库里还留着历史值。
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

  /*
   * 输入事实：
   * - manifest、output、cloudSync、segments 之间是强耦合状态，不适合局部 patch。
   * - 录屏过程中状态变化频繁，差量更新很容易漏字段。
   *
   * 状态目标：
   * - 把当前 runtimeSession 完整快照稳定地落进 SQLite。
   * - 让 SQLite 能作为“最后一次可信状态”参与恢复。
   *
   * 风险点：
   * - 只更新部分字段会留下半同步状态。
   * - session 表和 segment 表如果不同步，恢复逻辑会更复杂。
   *
   * 顺序约束：
   * - 主表 upsert 和 segment 集合同步必须处在同一事务里。
   * - segment 采用删后重建，保证数据库与内存态一一对应。
   *
   * 失败后果：
   * - 恢复时看到的不是完整快照，而是拼凑状态；后续 merge/upload 判断都会变脆弱。
   */
  // 这些字段先抽平，后面的 SQL 参数列表才不至于全是深层可选链。
  const db = getRecordingMetadataDatabase()
  const output = runtimeSession.manifest.output || null
  const updatedAt = Number(runtimeSession.manifest.updatedAt || Date.now())
  const cloudSync = runtimeSession.manifest.cloudSync || {}

  runDatabaseTransaction(db, () => {
    // session 主表使用 upsert，把当前 runtimeSession 视作最新真相源。
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

    // segments 采用“删后重建”的策略，牺牲一点写入量换来实现和恢复语义的确定性。
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

  // 先删 segments 再删 session，避免留下孤儿分段记录。
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

  // 分段必须按 index 升序读出，否则恢复后的上传/合并顺序会出错。
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
  // 这里只生成摘要统计，主要给状态面板和最终 metadata 使用，不参与真正上传调度。
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
  /*
   * 输入事实：
   * - 新会话一创建，后续多个模块都会立刻开始读写 manifest。
   * - 如果这里留下半缺省结构，后面每个调用点都得补默认值。
   *
   * 状态目标：
   * - 生成一份“刚开录就可被所有模块直接消费”的完整 manifest。
   * - 保证 cloudSync 结构在启用和未启用时都保持同样形状。
   *
   * 风险点：
   * - 结构不完整会导致前端展示、持久化、恢复、重试逻辑到处判空。
   * - serverUrl 如果不统一规整，后续请求地址容易带出重复斜杠。
   *
   * 顺序约束：
   * - 先统一 now 和 serverUrl，再一次性构造 manifest。
   *
   * 失败后果：
   * - 新建会话的初始状态不稳定，后面每个模块都要各自补结构，容易再次碎片化。
   */
  // 统一 now，避免 startedAt / updatedAt 在同一创建动作里出现细小偏差。
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
      // 这里构造的是会话初始默认状态，后续上传流程会持续覆盖这些字段。
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

  // 最终文件元数据只保留摘要，避免把整棵 manifest 再写回 recordings 表。
  return {
    ...runtimeSession.manifest.cloudSync,
    enabled: true,
    sessionId: runtimeSession.id,
    ...getCloudSyncPartStats(runtimeSession)
  }
}

/** 根据文件状态和附加元数据组装列表项。 */
export async function buildRecordingItem(filePath, fileStat) {
  /*
   * 输入事实：
   * - 最终列表项的数据源不是单一来源，而是文件 stat、SQLite 元数据、封面路径、媒体探测结果。
   *
   * 状态目标：
   * - 生成一份前端可直接展示和点击播放的完整条目。
   *
   * 风险点：
   * - 只信文件 stat 会缺少时长和云同步摘要。
   * - 只信 SQLite 又会丢失文件大小、poster 存在性这类文件系统事实。
   *
   * 顺序约束：
   * - 先读 metadata，再结合文件和 poster 情况补全派生字段，最后统一返回条目对象。
   *
   * 失败后果：
   * - 列表展示信息会碎片化，前端还得自己拼字段或再次发请求。
   */
  // 列表项需要融合文件 stat、SQLite 元数据、封面路径和媒体时长。
  const metadata = await readRecordingMetadata(filePath)
  const createdAt = Number(fileStat.birthtimeMs || fileStat.mtimeMs || Date.now())
  const posterPath = getPosterPathByVideoPath(filePath)
  const posterUrl = existsSync(posterPath)
    ? `recording://media/${encodeURIComponent(posterPath)}`
    : ''
  const probedDurationSec = await probeVideoDurationSec(filePath)
  const durationSec =
    Number.isFinite(probedDurationSec) && probedDurationSec > 0
      ? probedDurationSec
      : metadata?.durationSec || null
  const cloudSync = metadata?.cloudSync || null
  const fileName = filePath.split(sep).pop() || ''
  const source =
    metadata?.source && typeof metadata.source === 'object'
      ? metadata.source
      : fileName.startsWith(RECORDING_CUT_FILE_PREFIX)
        ? { type: 'editor-cut' }
        : { type: 'recording' }

  return {
    name: fileName,
    path: filePath,
    fileUrl: `recording://media/${encodeURIComponent(filePath)}`,
    posterUrl,
    bytes: Number(fileStat.size || 0),
    createdAt,
    durationSec,
    cloudSync,
    source,
    type: source.type || 'recording'
  }
}

/** 扫描录屏目录并返回可展示的录屏列表。 */
export async function listRecordingItems() {
  /*
   * 输入事实：
   * - Recording 目录下除了最终成片，可能还混有其他非视频文件或损坏文件。
   * - 列表读取属于高频 UI 行为，不能因为单个坏文件整体失败。
   *
   * 状态目标：
   * - 稳定返回一组“可以展示给用户”的最终录屏条目。
   *
   * 风险点：
   * - 不过滤前缀/扩展名，会把无关文件混进录屏列表。
   * - 对单个文件的 stat 或 metadata 失败如果直接抛出，会拖垮整个列表接口。
   *
   * 顺序约束：
   * - 先扫描目录，再做前缀和扩展名过滤，再逐个构造列表项，最后按时间倒序排序。
   *
   * 失败后果：
   * - UI 列表不稳定，甚至一个坏文件就让整个录屏页空白。
   */
  const recordingsDir = getRecordingsDirectoryPath()
  await mkdir(recordingsDir, { recursive: true })

  // 这里只扫描最终成片目录，不关心 sessions 临时目录。
  const fileNames = await readdir(recordingsDir)
  const items = []

  for (const fileName of fileNames) {
    if (!isKnownRecordingOutputFileName(fileName)) {
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
      // buildRecordingItem 内部会补全 poster、duration、cloudSync 等派生字段。
      items.push(await buildRecordingItem(filePath, fileStat))
    } catch {
      // 单个坏文件不应该拖垮整个列表读取。
      continue
    }
  }

  // 最新文件排前面，符合用户查看最近录屏的主要场景。
  items.sort((left, right) => right.createdAt - left.createdAt)
  return items
}

/** 将渲染进程传来的 data URL 直接保存为一个最终录屏文件。 */
export async function saveRecordingFromDataUrl(payload = {}) {
  // 这是“直接写最终文件”的兜底路径，不经过 session / segment 状态机。
  const parsed = parseDataUrl(payload?.dataUrl || '')

  if (!parsed || !parsed.buffer?.length) {
    return { ok: false, message: 'Invalid recording payload.' }
  }

  const detectedMime = parsed.mimeType || payload?.mimeType || 'video/webm'
  const ext = getVideoExtensionFromMimeType(detectedMime)
  const filePath = join(getRecordingsDirectoryPath(), createRecordingFileName(ext))

  // 先把文件真正写出来，再探测时长和写 metadata，避免记录指向不存在的文件。
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

  // 主文件删除是核心动作；metadata 和 poster 删除属于附属清理。
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

  // 只有 output.path 存在时才写最终文件 metadata，避免录制中会话误落最终元数据。
  writeRecordingMetadata(outputPath, {
    durationSec: Number(runtimeSession.manifest.output?.durationSec || 0) || null,
    cloudSync: buildCloudSyncMetadata(runtimeSession)
  })
}

/** 把当前运行时会话完整刷新到 SQLite。 */
export async function persistRecordingSessionState(runtimeSession) {
  // updatedAt 统一在这里刷新，保证数据库里的更新时间真正代表最后一次状态变更。
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
    // statfs 返回的是块信息，这里换算成字节数供前端直接消费。
    const blockSize = Number(stats.bsize || 0)
    const availableBlocks = Number(stats.bavail || 0)
    const freeBytes = blockSize > 0 && availableBlocks > 0 ? blockSize * availableBlocks : 0

    return {
      ok: true,
      freeBytes,
      // 低磁盘空间只用于提示，不在这里强行中断业务流程。
      lowDiskSpace: freeBytes > 0 && freeBytes <= LOW_DISK_SPACE_THRESHOLD_BYTES
    }
  } catch {
    // 获取失败时回 ok:false，避免磁盘检查问题反向拖垮录制主流程。
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
  // currentPart 单独抽出，方便前端实时展示“当前第几段、已写多少字节”。
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
