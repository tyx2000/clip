/** 文件作用：集中管理录屏目录、文件命名规则、扩展名与协议常量。 */
import { app } from 'electron'
import { join } from 'path'

/** 可被视为最终录屏输出文件的视频扩展名集合。 */
export const VIDEO_FILE_EXTENSIONS = new Set(['webm', 'mp4', 'ogv'])
/** 所有本地最终录屏文件统一使用的文件名前缀。 */
export const RECORDING_FILE_PREFIX = 'sr-'
/** 录屏封面图使用的图片扩展名。 */
export const POSTER_FILE_EXTENSION = 'jpg'
/** 录屏元数据 SQLite 数据库文件名。 */
export const RECORDING_METADATA_DB_FILE_NAME = 'recordings.sqlite3'
/** 用于向渲染进程安全暴露本地媒体文件的自定义协议名。 */
export const RECORDING_MEDIA_SCHEME = 'recording'
/** 用于保存录制中会话临时文件的目录名。 */
export const RECORDING_SESSIONS_DIR_NAME = 'sessions'
/** 本地分段录制默认使用的切片时长。 */
export const DEFAULT_SEGMENT_DURATION_MS = 5 * 1000
/** 渲染进程允许传入的最小时长下限。 */
export const MIN_SEGMENT_DURATION_MS = 1 * 1000
/** 单个上传分片允许增长到的最大体积。 */
export const DEFAULT_CLOUD_SYNC_PART_SIZE_BYTES = 2 * 1024 * 1024
/** 磁盘空间低于该阈值时，界面会展示容量告警。 */
export const LOW_DISK_SPACE_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024
/** 内置云同步服务的默认开发地址。 */
export const DEFAULT_CLOUD_SYNC_SERVER_URL = 'http://127.0.0.1:8787'
/** 云同步上传与重试流程使用的退避时间表。 */
export const CLOUD_SYNC_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000]

/** 返回录屏输出根目录。 */
export function getRecordingsDirectoryPath() {
  return join(app.getPath('downloads'), 'Recording')
}

/** 将时间戳格式化为适合文件命名的稳定文本。 */
export function formatTimestampForFileName(value = Date.now()) {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}${month}${day}-${hours}${minutes}${seconds}`
}

/** 生成最终录屏文件名。 */
export function createRecordingFileName(extension = 'webm') {
  const stamp = formatTimestampForFileName()
  return `${RECORDING_FILE_PREFIX}${stamp}.${extension}`
}

/** 生成新的录屏会话 id。 */
export function createRecordingSessionId() {
  const stamp = formatTimestampForFileName()
  const randomSuffix = Math.random().toString(36).slice(2, 8)
  return `session-${stamp}-${randomSuffix}`
}

/** 返回所有录屏会话临时目录的父目录。 */
export function getRecordingSessionsDirectoryPath() {
  return join(getRecordingsDirectoryPath(), RECORDING_SESSIONS_DIR_NAME)
}

/** 生成本地分段文件名。 */
export function createRecordingSegmentFileName(index, extension = 'webm') {
  const indexLabel = String(index).padStart(4, '0')
  return `segment-${indexLabel}.${extension}`
}

/** 生成云同步分片文件名。 */
export function createCloudSyncPartFileName(index) {
  const indexLabel = String(index).padStart(4, '0')
  return `part-${indexLabel}.bin`
}

/** 生成连续录制临时文件名。 */
export function createRecordingCaptureTempFileName(extension = 'webm') {
  return `capture.${extension}.part`
}

/** 根据 mime type 推断视频扩展名。 */
export function getVideoExtensionFromMimeType(mimeType = '') {
  const mime = typeof mimeType === 'string' ? mimeType.toLowerCase() : ''
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('ogg')) return 'ogv'
  return 'webm'
}

/** 根据扩展名反推 mime type。 */
export function getMimeTypeByExtension(extension = '') {
  const normalized = String(extension || '').toLowerCase()
  if (normalized === 'mp4') return 'video/mp4'
  if (normalized === 'ogv' || normalized === 'ogg') return 'video/ogg'
  return 'video/webm'
}

/** 根据视频路径推导对应的封面图路径。 */
export function getPosterPathByVideoPath(filePath) {
  const marker = filePath.lastIndexOf('.')
  if (marker <= 0) {
    return `${filePath}.${POSTER_FILE_EXTENSION}`
  }
  return `${filePath.slice(0, marker)}.${POSTER_FILE_EXTENSION}`
}
