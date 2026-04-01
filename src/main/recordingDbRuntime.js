import { join, resolve, sep } from 'path'
import {
  DEFAULT_SEGMENT_DURATION_MS,
  getMimeTypeByExtension,
  getRecordingsDirectoryPath
} from './recordingPaths'

export function createRuntimeSessionFromRecordingDatabaseRecord(
  sessionRow,
  segmentRows,
  createRuntimeSession
) {
  const sessionId = String(sessionRow?.sessionId || '').trim()
  if (!sessionId) {
    return null
  }

  const manifest = {
    version: 2,
    sessionId,
    sessionDir: sessionRow.sessionDir,
    extension: sessionRow.extension || 'webm',
    mimeType: sessionRow.mimeType || getMimeTypeByExtension(sessionRow.extension),
    segmentDurationMs: Number(sessionRow.segmentDurationMs || DEFAULT_SEGMENT_DURATION_MS),
    cloudSyncEnabled: Boolean(sessionRow.cloudSyncEnabled),
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
    segments: segmentRows.map((segment) => ({
      index: Number(segment.index || 0),
      fileName: segment.filePath ? resolve(segment.filePath).split(sep).pop() || '' : '',
      path: segment.filePath ? resolve(segment.filePath) : '',
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
    }))
  }

  return createRuntimeSession(manifest)
}

export function createRuntimeSessionFromCloudSyncDatabaseRecord(
  sessionRow,
  segmentRows,
  applyRecordingSessionManifestDefaults,
  createCloudSyncState,
  createRuntimeSession
) {
  const sessionId = String(sessionRow?.sessionId || '').trim()
  if (!sessionId) {
    return null
  }

  const sessionDir = join(getRecordingsDirectoryPath(), 'sessions', sessionId)
  const firstSegmentPath =
    segmentRows.find((segment) => typeof segment.filePath === 'string' && segment.filePath)
      ?.filePath || ''
  const outputPath =
    typeof sessionRow?.outputPath === 'string' ? resolve(sessionRow.outputPath) : ''
  const extensionSource = outputPath || firstSegmentPath
  const extension = extensionSource.split('.').pop()?.toLowerCase() || 'webm'
  const startedAt = segmentRows.reduce((minimum, segment) => {
    const value = Number(segment.startedAt || 0)
    if (!value) {
      return minimum
    }
    return minimum === 0 ? value : Math.min(minimum, value)
  }, 0)
  const stoppedAt = segmentRows.reduce(
    (maximum, segment) => {
      const value = Number(segment.endedAt || 0)
      return value > maximum ? value : maximum
    },
    Number(sessionRow?.completedAt || 0) || 0
  )
  const totalBytes = segmentRows.reduce((sum, segment) => sum + Number(segment.bytes || 0), 0)

  const manifest = applyRecordingSessionManifestDefaults({
    version: 2,
    sessionId,
    sessionDir,
    extension,
    mimeType: getMimeTypeByExtension(extension),
    segmentDurationMs: DEFAULT_SEGMENT_DURATION_MS,
    cloudSyncEnabled: true,
    cloudSync: {
      ...createCloudSyncState({
        enabled: true,
        serverUrl: sessionRow?.serverUrl || ''
      }),
      enabled: true,
      serverUrl: sessionRow?.serverUrl || '',
      sessionCreated: true,
      sessionStatus: sessionRow?.status || 'stopped',
      uploadStatus: sessionRow?.uploadStatus || 'pending',
      mergeStatus: sessionRow?.mergeStatus || 'pending',
      completedAt: Number(sessionRow?.completedAt || 0) || null,
      lastError: sessionRow?.lastError || '',
      lastAttemptAt: Number(sessionRow?.lastAttemptAt || 0) || null,
      nextRetryAt: Number(sessionRow?.nextRetryAt || 0) || null
    },
    status: sessionRow?.status || 'stopped',
    startedAt,
    stoppedAt: stoppedAt || null,
    updatedAt: Number(sessionRow?.updatedAt || Date.now()),
    totalBytes,
    output: outputPath
      ? {
          path: outputPath,
          status: 'pending',
          bytes: 0,
          createdAt: 0,
          durationSec: null
        }
      : null,
    segments: segmentRows.map((segment) => {
      const filePath = segment.filePath ? resolve(segment.filePath) : ''
      return {
        index: Number(segment.index || 0),
        fileName: filePath ? filePath.split(sep).pop() || '' : '',
        path: filePath,
        partialPath: '',
        startedAt: Number(segment.startedAt || 0) || null,
        endedAt: Number(segment.endedAt || 0) || null,
        bytes: Number(segment.bytes || 0),
        status: segment.status || 'ready',
        uploadStatus: segment.uploadStatus || 'pending',
        checksum: segment.checksum || '',
        etag: segment.etag || '',
        uploadedAt: Number(segment.uploadedAt || 0) || null,
        retryCount: Number(segment.retryCount || 0)
      }
    })
  })

  return createRuntimeSession(manifest)
}
