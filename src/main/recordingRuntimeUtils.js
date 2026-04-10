/** 文件作用：提供录屏运行时的通用解析、归一化和默认值工具。 */
import {
  CLOUD_SYNC_RETRY_DELAYS_MS,
  DEFAULT_CLOUD_SYNC_SERVER_URL,
  DEFAULT_SEGMENT_DURATION_MS,
  MIN_SEGMENT_DURATION_MS
} from './recordingPaths'

/** 解析 data URL，提取 mime type 与二进制内容。 */
export function parseDataUrl(dataUrl = '') {
  if (typeof dataUrl !== 'string') return null

  const matched = dataUrl.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/)
  if (!matched) return null

  const [, mimeType, encoded] = matched

  try {
    return {
      mimeType: mimeType || '',
      buffer: Buffer.from(encoded, 'base64')
    }
  } catch {
    return null
  }
}

/** 把多种 chunk 载荷形式统一转换为 Buffer。 */
export function parseChunkPayloadToBuffer(payload = {}) {
  if (Buffer.isBuffer(payload?.chunk)) {
    return payload.chunk
  }

  if (payload?.chunk instanceof Uint8Array) {
    return Buffer.from(payload.chunk)
  }

  if (payload?.chunk instanceof ArrayBuffer) {
    return Buffer.from(payload.chunk)
  }

  if (ArrayBuffer.isView(payload?.chunk)) {
    return Buffer.from(payload.chunk.buffer, payload.chunk.byteOffset, payload.chunk.byteLength)
  }

  if (typeof payload?.chunkBase64 === 'string' && payload.chunkBase64.trim()) {
    return Buffer.from(payload.chunkBase64, 'base64')
  }

  const parsed = parseDataUrl(payload?.dataUrl || '')
  return parsed?.buffer || null
}

/** 归一化单段录制时长配置。 */
export function normalizeSegmentDurationMs(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < MIN_SEGMENT_DURATION_MS) {
    return DEFAULT_SEGMENT_DURATION_MS
  }
  return Math.floor(parsed)
}

/** 归一化云同步开关值。 */
export function normalizeCloudSyncEnabled(value) {
  return value === true
}

/** 读取云同步服务地址，并移除末尾斜杠。 */
export function getCloudSyncServerUrl(payload = {}) {
  const candidate =
    typeof payload?.cloudSyncServerUrl === 'string' && payload.cloudSyncServerUrl.trim()
      ? payload.cloudSyncServerUrl.trim()
      : process.env.CLOUD_SYNC_SERVER_URL || DEFAULT_CLOUD_SYNC_SERVER_URL
  return candidate.replace(/\/+$/, '')
}

/** 创建云同步状态的默认结构。 */
export function createCloudSyncState({ enabled = false, serverUrl = '' } = {}) {
  return {
    enabled,
    serverUrl: enabled ? serverUrl : '',
    status: enabled ? 'pending' : 'disabled',
    remoteVideoUrl: '',
    lastError: '',
    completedAt: null,
    lastAttemptAt: null,
    nextRetryAt: null
  }
}

/** 归一化单个分段的云同步状态字段。 */
export function normalizeSegmentCloudSyncState(segment = {}) {
  return {
    uploadStatus:
      typeof segment.uploadStatus === 'string' && segment.uploadStatus
        ? segment.uploadStatus
        : 'pending',
    checksum: typeof segment.checksum === 'string' ? segment.checksum : '',
    etag: typeof segment.etag === 'string' ? segment.etag : '',
    uploadedAt: Number(segment.uploadedAt || 0) || null,
    retryCount: Number(segment.retryCount || 0)
  }
}

/** 为从数据库恢复的会话状态补齐缺失字段。 */
export function applyRecordingSessionStateDefaults(sessionState = {}) {
  const cloudSyncEnabled = normalizeCloudSyncEnabled(sessionState?.cloudSyncEnabled)
  const serverUrl = getCloudSyncServerUrl({
    cloudSyncServerUrl: sessionState?.cloudSync?.serverUrl
  })
  const cloudSync = {
    ...createCloudSyncState({
      enabled: cloudSyncEnabled,
      serverUrl
    }),
    ...(sessionState?.cloudSync && typeof sessionState.cloudSync === 'object'
      ? sessionState.cloudSync
      : {})
  }

  return {
    ...sessionState,
    version: 2,
    cloudSyncEnabled,
    cloudSync,
    segments: Array.isArray(sessionState?.segments)
      ? sessionState.segments.map((segment) => ({
          ...segment,
          ...normalizeSegmentCloudSyncState(segment)
        }))
      : []
  }
}

/** 根据重试次数返回下一次云同步重试延迟。 */
export function getCloudSyncRetryDelayMs(retryCount) {
  const normalized = Math.max(0, Number(retryCount || 0))
  return CLOUD_SYNC_RETRY_DELAYS_MS[Math.min(normalized, CLOUD_SYNC_RETRY_DELAYS_MS.length - 1)]
}
