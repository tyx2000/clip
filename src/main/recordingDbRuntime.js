import { resolve, sep } from 'path'
import { DEFAULT_SEGMENT_DURATION_MS, getMimeTypeByExtension } from './recordingPaths'

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

export function createRuntimeSessionFromCloudSyncDatabaseRecord(
  sessionRow,
  segmentRows,
  _applyRecordingSessionStateDefaults,
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
