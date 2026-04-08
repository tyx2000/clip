import { mkdir, statfs } from 'fs/promises'
import {
  deleteCloudSessionFromDatabase,
  deleteRecordingMetadataFromDatabase,
  deleteRecordingSessionFromDatabase,
  listCloudSyncSessionRowsFromDatabase,
  listLocalRecordingSessionRowsFromDatabase,
  readCloudSyncSessionRowsFromDatabase,
  readRecordingMetadataFromDatabase,
  readRecordingSessionRowsFromDatabase,
  syncRecordingSessionToDatabase,
  writeRecordingMetadataToDatabase
} from './recordingDb'
import {
  createRuntimeSessionFromCloudSyncDatabaseRecord as createCloudSyncRuntimeSessionFromDatabaseRecord,
  createRuntimeSessionFromRecordingDatabaseRecord as createLocalRuntimeSessionFromDatabaseRecord
} from './recordingDbRuntime'
import { LOW_DISK_SPACE_THRESHOLD_BYTES, getRecordingsDirectoryPath } from './recordingPaths'

export function createRecordingStorageRuntime({ getCloudSyncServerUrl, createCloudSyncState }) {
  function getCloudSyncPartStats(runtimeSession) {
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

  function createRecordingSessionState({
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
      ...getCloudSyncPartStats(runtimeSession)
    }
  }

  function getRecordingSessionSummary(runtimeSession) {
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
      }
    }
  }

  function readRecordingMetadata(filePath) {
    return readRecordingMetadataFromDatabase(filePath)
  }

  function writeRecordingMetadata(filePath, metadata) {
    writeRecordingMetadataToDatabase(filePath, metadata)
  }

  function syncRuntimeSessionOutputMetadata(runtimeSession) {
    const outputPath = runtimeSession?.manifest?.output?.path
    if (!outputPath) {
      return
    }

    writeRecordingMetadata(outputPath, {
      durationSec: Number(runtimeSession.manifest.output?.durationSec || 0) || null,
      cloudSync: buildCloudSyncMetadata(runtimeSession)
    })
  }

  async function persistRecordingSessionState(runtimeSession) {
    runtimeSession.manifest.updatedAt = Date.now()
    syncRecordingSessionToDatabase(runtimeSession)
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

  function createRuntimeSession(sessionState) {
    return {
      id: sessionState.sessionId,
      dir: sessionState.sessionDir,
      writeQueue: Promise.resolve(),
      writeStream: null,
      partWriteStream: null,
      captureTempPath: '',
      currentSegment: null,
      manifest: sessionState
    }
  }

  function createLocalRuntimeSessionFromDatabase(sessionRow, segmentRows) {
    return createLocalRuntimeSessionFromDatabaseRecord(
      sessionRow,
      segmentRows,
      createRuntimeSession,
      createCloudSyncState
    )
  }

  function createCloudSyncRuntimeSessionFromDatabase(
    sessionRow,
    segmentRows,
    applyRecordingSessionStateDefaults
  ) {
    return createCloudSyncRuntimeSessionFromDatabaseRecord(
      sessionRow,
      segmentRows,
      applyRecordingSessionStateDefaults,
      createCloudSyncState,
      createRuntimeSession
    )
  }

  return {
    createRecordingSessionState,
    persistRecordingSessionState,
    buildCloudSyncMetadata,
    getRecordingSessionStatus,
    createRuntimeSession,
    readRecordingMetadata,
    writeRecordingMetadata,
    deleteRecordingMetadataFromDatabase,
    syncRecordingSessionToDatabase,
    deleteRecordingSessionFromDatabase,
    deleteCloudSessionFromDatabase,
    listCloudSyncSessionRowsFromDatabase,
    listLocalRecordingSessionRowsFromDatabase,
    readCloudSyncSessionRowsFromDatabase,
    readRecordingSessionRowsFromDatabase,
    createLocalRuntimeSessionFromDatabase,
    createCloudSyncRuntimeSessionFromDatabase
  }
}
