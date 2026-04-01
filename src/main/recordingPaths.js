import { app } from 'electron'
import { join } from 'path'

export const VIDEO_FILE_EXTENSIONS = new Set(['webm', 'mp4', 'ogv'])
export const RECORDING_FILE_PREFIX = 'sr-'
export const POSTER_FILE_EXTENSION = 'jpg'
export const RECORDING_METADATA_DB_FILE_NAME = 'recordings.sqlite3'
export const RECORDING_MEDIA_SCHEME = 'recording'
export const RECORDING_SESSIONS_DIR_NAME = 'sessions'
export const DEFAULT_SEGMENT_DURATION_MS = 5 * 1000
export const MIN_SEGMENT_DURATION_MS = 1 * 1000
export const LOW_DISK_SPACE_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024
export const DEFAULT_CLOUD_SYNC_SERVER_URL = 'http://127.0.0.1:8787'
export const CLOUD_SYNC_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000]

export function getRecordingsDirectoryPath() {
  return join(app.getPath('downloads'), 'Recording')
}

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

export function createRecordingFileName(extension = 'webm') {
  const stamp = formatTimestampForFileName()
  return `${RECORDING_FILE_PREFIX}${stamp}.${extension}`
}

export function createRecordingSessionId() {
  const stamp = formatTimestampForFileName()
  const randomSuffix = Math.random().toString(36).slice(2, 8)
  return `session-${stamp}-${randomSuffix}`
}

export function getRecordingSessionsDirectoryPath() {
  return join(getRecordingsDirectoryPath(), RECORDING_SESSIONS_DIR_NAME)
}

export function createRecordingSegmentFileName(index, extension = 'webm') {
  const indexLabel = String(index).padStart(4, '0')
  return `segment-${indexLabel}.${extension}`
}

export function getVideoExtensionFromMimeType(mimeType = '') {
  const mime = typeof mimeType === 'string' ? mimeType.toLowerCase() : ''
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('ogg')) return 'ogv'
  return 'webm'
}

export function getMimeTypeByExtension(extension = '') {
  const normalized = String(extension || '').toLowerCase()
  if (normalized === 'mp4') return 'video/mp4'
  if (normalized === 'ogv' || normalized === 'ogg') return 'video/ogg'
  return 'video/webm'
}

export function getPosterPathByVideoPath(filePath) {
  const marker = filePath.lastIndexOf('.')
  if (marker <= 0) {
    return `${filePath}.${POSTER_FILE_EXTENSION}`
  }
  return `${filePath.slice(0, marker)}.${POSTER_FILE_EXTENSION}`
}
