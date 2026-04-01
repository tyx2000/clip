import { mkdir, statfs } from 'fs/promises'
import { LOW_DISK_SPACE_THRESHOLD_BYTES, getRecordingsDirectoryPath } from './recordingPaths'

export function createRecordingSessionStateRuntime({
  getCloudSyncServerUrl,
  createCloudSyncState,
  syncRecordingSessionToDatabase,
  syncCloudSessionToDatabase,
  writeRecordingMetadataToDatabase
}) {
  function createRecordingSessionManifest({
    sessionId,
    sessionDir,
    extension,
    mimeType,
    segmentDurationMs,
    cloudSyncEnabled = false,
    cloudSyncServerUrl = ''
  }) {
    const now = Date.now()
    return {
      version: 2,
      sessionId,
      sessionDir,
      extension,
      mimeType,
      segmentDurationMs,
      cloudSyncEnabled,
      cloudSync: createCloudSyncState({
        enabled: cloudSyncEnabled,
        serverUrl: cloudSyncEnabled ? getCloudSyncServerUrl({ cloudSyncServerUrl }) : ''
      }),
      status: 'recording',
      startedAt: now,
      stoppedAt: null,
      updatedAt: now,
      totalBytes: 0,
      output: null,
      segments: []
    }
  }

  function buildCloudSyncMetadata(runtimeSession) {
    if (!runtimeSession?.manifest?.cloudSyncEnabled) {
      return null
    }

    return {
      ...runtimeSession.manifest.cloudSync,
      enabled: true,
      sessionId: runtimeSession.id,
      failedSegments: runtimeSession.manifest.segments.filter(
        (segment) => segment.uploadStatus === 'failed'
      ).length,
      pendingSegments: runtimeSession.manifest.segments.filter(
        (segment) =>
          segment.status === 'ready' &&
          segment.uploadStatus !== 'uploaded' &&
          segment.uploadStatus !== 'disabled'
      ).length
    }
  }

  function getRecordingSessionSummary(runtimeSession) {
    const currentSegment = runtimeSession.currentSegment
    const cloudUploadedSegments = runtimeSession.manifest.segments.filter(
      (segment) => segment.uploadStatus === 'uploaded'
    ).length
    const cloudFailedSegments = runtimeSession.manifest.segments.filter(
      (segment) => segment.uploadStatus === 'failed'
    ).length
    const cloudPendingSegments = runtimeSession.manifest.segments.filter(
      (segment) =>
        segment.status === 'ready' &&
        segment.uploadStatus !== 'uploaded' &&
        segment.uploadStatus !== 'disabled'
    ).length

    return {
      sessionId: runtimeSession.id,
      status: runtimeSession.manifest.status,
      sessionDir: runtimeSession.dir,
      segmentDurationMs: runtimeSession.manifest.segmentDurationMs,
      segmentCount: runtimeSession.manifest.segments.length,
      currentSegmentIndex: currentSegment?.index || null,
      currentSegmentBytes: currentSegment?.bytes || 0,
      totalBytes: runtimeSession.manifest.totalBytes,
      startedAt: runtimeSession.manifest.startedAt,
      stoppedAt: runtimeSession.manifest.stoppedAt,
      output: runtimeSession.manifest.output,
      cloudSyncEnabled: runtimeSession.manifest.cloudSyncEnabled === true,
      cloudSync: {
        ...runtimeSession.manifest.cloudSync,
        uploadedSegments: cloudUploadedSegments,
        failedSegments: cloudFailedSegments,
        pendingSegments: cloudPendingSegments
      }
    }
  }

  function syncRuntimeSessionOutputMetadata(runtimeSession) {
    const outputPath = runtimeSession?.manifest?.output?.path
    if (!outputPath) {
      return
    }

    writeRecordingMetadataToDatabase(outputPath, {
      durationSec: Number(runtimeSession.manifest.output?.durationSec || 0) || null,
      cloudSync: buildCloudSyncMetadata(runtimeSession)
    })
  }

  async function persistRecordingSessionManifest(runtimeSession) {
    runtimeSession.manifest.updatedAt = Date.now()
    syncRecordingSessionToDatabase(runtimeSession)
    syncCloudSessionToDatabase(runtimeSession)
    syncRuntimeSessionOutputMetadata(runtimeSession)
  }

  async function getRecordingStorageSnapshot() {
    try {
      const recordingsDir = getRecordingsDirectoryPath()
      await mkdir(recordingsDir, { recursive: true })
      const stats = await statfs(recordingsDir)
      const blockSize = Number(stats.bsize || 0)
      const availableBlocks = Number(stats.bavail || 0)
      const freeBytes = blockSize > 0 && availableBlocks > 0 ? blockSize * availableBlocks : 0

      return {
        ok: true,
        freeBytes,
        lowDiskSpace: freeBytes > 0 && freeBytes <= LOW_DISK_SPACE_THRESHOLD_BYTES
      }
    } catch {
      return {
        ok: false,
        freeBytes: 0,
        lowDiskSpace: false
      }
    }
  }

  async function getRecordingSessionStatus(runtimeSession) {
    const storage = await getRecordingStorageSnapshot()
    return {
      ...getRecordingSessionSummary(runtimeSession),
      storage
    }
  }

  function createRuntimeSession(manifest) {
    return {
      id: manifest.sessionId,
      dir: manifest.sessionDir,
      writeQueue: Promise.resolve(),
      writeStream: null,
      currentSegment: null,
      manifest
    }
  }

  return {
    createRecordingSessionManifest,
    persistRecordingSessionManifest,
    buildCloudSyncMetadata,
    getRecordingSessionSummary,
    getRecordingSessionStatus,
    createRuntimeSession
  }
}
