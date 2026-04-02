import { mkdir, statfs } from 'fs/promises'
import { LOW_DISK_SPACE_THRESHOLD_BYTES, getRecordingsDirectoryPath } from './recordingPaths'

/** Builds helpers that own manifest shape, live summaries, and SQLite sync. */
export function createRecordingSessionStateRuntime({
  getCloudSyncServerUrl,
  createCloudSyncState,
  syncRecordingSessionToDatabase,
  syncCloudSessionToDatabase,
  writeRecordingMetadataToDatabase
}) {
  /** Creates the canonical in-memory manifest for a new recording session.
   * @param {object} options Session creation inputs.
   */
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

  /** Builds the cloud-sync metadata stored beside a finalized local output.
   * @param {object} runtimeSession Active or recovered runtime session.
   */
  function buildCloudSyncMetadata(runtimeSession) {
    if (!runtimeSession?.manifest?.cloudSyncEnabled) {
      return null
    }

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
      ...runtimeSession.manifest.cloudSync,
      enabled: true,
      sessionId: runtimeSession.id,
      uploadedParts,
      failedParts,
      pendingParts,
      totalParts: runtimeSession.manifest.segments.length
    }
  }

  /** Produces the live session summary returned to the renderer UI.
   * @param {object} runtimeSession Active or recovered runtime session.
   */
  function getRecordingSessionSummary(runtimeSession) {
    const currentPart = runtimeSession.currentSegment
    const uploadedParts = runtimeSession.manifest.segments.filter(
      (part) => part.uploadStatus === 'uploaded'
    ).length
    const failedParts = runtimeSession.manifest.segments.filter(
      (part) => part.uploadStatus === 'failed'
    ).length
    const pendingParts = runtimeSession.manifest.segments.filter(
      (part) =>
        part.status === 'ready' &&
        part.uploadStatus !== 'uploaded' &&
        part.uploadStatus !== 'disabled'
    ).length

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
        uploadedParts,
        failedParts,
        pendingParts,
        totalParts: runtimeSession.manifest.segments.length
      }
    }
  }

  /** Persists output-side metadata once a final local output exists.
   * @param {object} runtimeSession Runtime session containing output info.
   */
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

  /** Flushes the current runtime session snapshot into SQLite.
   * @param {object} runtimeSession Runtime session to persist.
   */
  async function persistRecordingSessionManifest(runtimeSession) {
    runtimeSession.manifest.updatedAt = Date.now()
    syncRecordingSessionToDatabase(runtimeSession)
    syncCloudSessionToDatabase(runtimeSession)
    syncRuntimeSessionOutputMetadata(runtimeSession)
  }

  /** Returns a storage snapshot used by the renderer to surface disk warnings. */
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

  /** Returns a full renderer-facing status payload for one runtime session.
   * @param {object} runtimeSession Runtime session to summarize.
   */
  async function getRecordingSessionStatus(runtimeSession) {
    const storage = await getRecordingStorageSnapshot()
    return {
      ...getRecordingSessionSummary(runtimeSession),
      storage
    }
  }

  /** Wraps one manifest-like payload into the mutable runtime-session container.
   * @param {object} manifest Canonical session payload.
   */
  function createRuntimeSession(manifest) {
    return {
      id: manifest.sessionId,
      dir: manifest.sessionDir,
      writeQueue: Promise.resolve(),
      writeStream: null,
      partWriteStream: null,
      captureTempPath: '',
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
