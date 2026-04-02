import { app } from 'electron'
import { join } from 'path'

/** Video extensions that are treated as playable recording outputs. */
export const VIDEO_FILE_EXTENSIONS = new Set(['webm', 'mp4', 'ogv'])
/** Stable prefix used for all finalized local recordings. */
export const RECORDING_FILE_PREFIX = 'sr-'
/** Extension used for poster frames extracted beside recordings. */
export const POSTER_FILE_EXTENSION = 'jpg'
/** SQLite database file name for recording metadata. */
export const RECORDING_METADATA_DB_FILE_NAME = 'recordings.sqlite3'
/** Custom Electron protocol used to expose local media to renderer windows. */
export const RECORDING_MEDIA_SCHEME = 'recording'
/** Directory name that stores in-progress recording sessions. */
export const RECORDING_SESSIONS_DIR_NAME = 'sessions'
/** Default local segment duration used by segmented local recording flows. */
export const DEFAULT_SEGMENT_DURATION_MS = 5 * 1000
/** Smallest accepted segment duration from renderer payloads. */
export const MIN_SEGMENT_DURATION_MS = 1 * 1000
/** Maximum size of one upload part before the current part is sealed. */
export const DEFAULT_CLOUD_SYNC_PART_SIZE_BYTES = 2 * 1024 * 1024
/** Threshold used by the UI to surface low disk space warnings. */
export const LOW_DISK_SPACE_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024
/** Default development endpoint for the bundled cloud sync server. */
export const DEFAULT_CLOUD_SYNC_SERVER_URL = 'http://127.0.0.1:8787'
/** Retry schedule used by cloud upload/complete/status polling workers. */
export const CLOUD_SYNC_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000]

/** Returns the root local output directory used for recordings. */
export function getRecordingsDirectoryPath() {
  return join(app.getPath('downloads'), 'Recording')
}

/** Formats a timestamp into the `YYYYMMDD-HHMMSS` file naming convention. */
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

/** Creates the file name of one finalized recording output.
 * @param {string} extension Final video extension.
 */
export function createRecordingFileName(extension = 'webm') {
  const stamp = formatTimestampForFileName()
  return `${RECORDING_FILE_PREFIX}${stamp}.${extension}`
}

/** Creates a unique runtime session id for one recording session. */
export function createRecordingSessionId() {
  const stamp = formatTimestampForFileName()
  const randomSuffix = Math.random().toString(36).slice(2, 8)
  return `session-${stamp}-${randomSuffix}`
}

/** Returns the parent directory that contains all session work directories. */
export function getRecordingSessionsDirectoryPath() {
  return join(getRecordingsDirectoryPath(), RECORDING_SESSIONS_DIR_NAME)
}

/** Creates the file name for one local media segment.
 * @param {number} index One-based segment index.
 * @param {string} extension Video extension used by the segment.
 */
export function createRecordingSegmentFileName(index, extension = 'webm') {
  const indexLabel = String(index).padStart(4, '0')
  return `segment-${indexLabel}.${extension}`
}

/** Creates the file name for one cloud upload part.
 * @param {number} index One-based part index.
 */
export function createCloudSyncPartFileName(index) {
  const indexLabel = String(index).padStart(4, '0')
  return `part-${indexLabel}.bin`
}

/** Creates the temp file name for the continuous local capture stream.
 * @param {string} extension Final local container extension.
 */
export function createRecordingCaptureTempFileName(extension = 'webm') {
  return `capture.${extension}.part`
}

/** Maps a recorder mime type into the extension used on disk.
 * @param {string} mimeType MediaRecorder mime type.
 */
export function getVideoExtensionFromMimeType(mimeType = '') {
  const mime = typeof mimeType === 'string' ? mimeType.toLowerCase() : ''
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('ogg')) return 'ogv'
  return 'webm'
}

/** Maps a file extension back into the content type used by the media protocol.
 * @param {string} extension Video file extension.
 */
export function getMimeTypeByExtension(extension = '') {
  const normalized = String(extension || '').toLowerCase()
  if (normalized === 'mp4') return 'video/mp4'
  if (normalized === 'ogv' || normalized === 'ogg') return 'video/ogg'
  return 'video/webm'
}

/** Returns the poster path that corresponds to one local video path.
 * @param {string} filePath Absolute video file path.
 */
export function getPosterPathByVideoPath(filePath) {
  const marker = filePath.lastIndexOf('.')
  if (marker <= 0) {
    return `${filePath}.${POSTER_FILE_EXTENSION}`
  }
  return `${filePath.slice(0, marker)}.${POSTER_FILE_EXTENSION}`
}
