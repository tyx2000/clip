import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import {
  createRecordingSessionId,
  getRecordingSessionsDirectoryPath,
  getVideoExtensionFromMimeType
} from './recordingPaths'
import { createRecordingRecoveryRuntime } from './recordingRecovery'
import { createRecordingSegmentsRuntime } from './recordingSegments'
import { createRecordingSessionStateRuntime } from './recordingSessionState'

/** Builds the session lifecycle runtime used by recording IPC handlers. */
export function createRecordingSessionsRuntime({
  normalizeSegmentDurationMs,
  normalizeCloudSyncEnabled,
  getCloudSyncServerUrl,
  createCloudSyncState,
  normalizeSegmentCloudSyncState,
  applyRecordingSessionManifestDefaults,
  syncRecordingSessionToDatabase,
  syncCloudSessionToDatabase,
  writeRecordingMetadataToDatabase,
  listSessionArtifactPaths,
  deleteRecordingSessionFromDatabase,
  deleteCloudSessionFromDatabase,
  runFfmpeg,
  probeVideoDurationSec,
  buildRecordingItem,
  writeRecordingMetadata,
  listLocalRecordingSessionRowsFromDatabase,
  readRecordingSessionRowsFromDatabase,
  createLocalRuntimeSessionFromDatabase,
  listCloudSyncSessionRowsFromDatabase,
  readCloudSyncSessionRowsFromDatabase,
  createCloudSyncRuntimeSessionFromDatabase,
  scheduleCloudSyncProcessing,
  scheduleCloudSyncFinalize,
  clearCloudSyncWorker,
  parseChunkPayloadToBuffer
}) {
  const activeRecordingSessions = new Map()
  const stateRuntime = createRecordingSessionStateRuntime({
    getCloudSyncServerUrl,
    createCloudSyncState,
    syncRecordingSessionToDatabase,
    syncCloudSessionToDatabase,
    writeRecordingMetadataToDatabase
  })
  const {
    createRecordingSessionManifest,
    persistRecordingSessionManifest,
    buildCloudSyncMetadata,
    getRecordingSessionStatus,
    createRuntimeSession
  } = stateRuntime

  const recoveryRuntime = createRecordingRecoveryRuntime({
    persistRecordingSessionManifest,
    buildCloudSyncMetadata,
    normalizeSegmentCloudSyncState,
    applyRecordingSessionManifestDefaults,
    listSessionArtifactPaths,
    deleteRecordingSessionFromDatabase,
    deleteCloudSessionFromDatabase,
    runFfmpeg,
    probeVideoDurationSec,
    buildRecordingItem,
    writeRecordingMetadata,
    listLocalRecordingSessionRowsFromDatabase,
    readRecordingSessionRowsFromDatabase,
    createLocalRuntimeSessionFromDatabase,
    listCloudSyncSessionRowsFromDatabase,
    readCloudSyncSessionRowsFromDatabase,
    createCloudSyncRuntimeSessionFromDatabase,
    createCloudSyncState,
    createRuntimeSession,
    scheduleCloudSyncProcessing
  })
  const {
    cleanupRecordingSessionArtifacts,
    mergeRecordingSession,
    recoverPendingRecordingSessions,
    resumeAllCloudSyncSessions
  } = recoveryRuntime
  const segmentsRuntime = createRecordingSegmentsRuntime({
    persistRecordingSessionManifest,
    scheduleCloudSyncProcessing,
    parseChunkPayloadToBuffer
  })
  const {
    openRecordingSessionSegment,
    finalizeCurrentRecordingSessionSegment,
    appendRecordingSessionChunk: appendRecordingSessionChunkImpl,
    rotateRecordingSessionSegment: rotateRecordingSessionSegmentImpl
  } = segmentsRuntime

  /** Returns the active in-memory session for one session id. */
  function getActiveRecordingSession(sessionId) {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!normalizedSessionId) {
      return null
    }
    return activeRecordingSessions.get(normalizedSessionId) || null
  }

  /** Serializes disk mutations per session through one promise queue.
   * @param {object} runtimeSession Active runtime session.
   * @param {() => Promise<any>} task Async task to enqueue.
   */
  async function enqueueRecordingSessionTask(runtimeSession, task) {
    runtimeSession.writeQueue = runtimeSession.writeQueue.then(task, task)
    return runtimeSession.writeQueue
  }

  /** Creates a new recording session from the renderer start payload. */
  async function createRecordingSession(payload = {}) {
    const sessionIdInput = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
    const sessionId = sessionIdInput || createRecordingSessionId()
    if (activeRecordingSessions.has(sessionId)) {
      throw new Error('Recording session is already active.')
    }

    const detectedMimeType =
      typeof payload?.mimeType === 'string' && payload.mimeType.trim()
        ? payload.mimeType
        : 'video/webm'
    const extension = getVideoExtensionFromMimeType(detectedMimeType)
    const segmentDurationMs = normalizeSegmentDurationMs(payload?.segmentDurationMs)
    const cloudSyncEnabled = normalizeCloudSyncEnabled(payload?.cloudSyncEnabled)
    const cloudSyncServerUrl = getCloudSyncServerUrl(payload)
    const sessionDir = join(getRecordingSessionsDirectoryPath(), sessionId)

    if (existsSync(sessionDir)) {
      throw new Error('Recording session directory already exists.')
    }

    await mkdir(sessionDir, { recursive: true })

    const runtimeSession = {
      id: sessionId,
      dir: sessionDir,
      writeQueue: Promise.resolve(),
      writeStream: null,
      currentSegment: null,
      manifest: createRecordingSessionManifest({
        sessionId,
        sessionDir,
        extension,
        mimeType: detectedMimeType,
        segmentDurationMs,
        cloudSyncEnabled,
        cloudSyncServerUrl
      })
    }

    activeRecordingSessions.set(sessionId, runtimeSession)

    try {
      await openRecordingSessionSegment(runtimeSession, 1)
      if (cloudSyncEnabled) {
        scheduleCloudSyncProcessing(runtimeSession)
      }
      return runtimeSession
    } catch (error) {
      activeRecordingSessions.delete(sessionId)
      throw error
    }
  }

  /** Appends one renderer chunk into the session write pipeline. */
  async function appendRecordingSessionChunk(payload = {}) {
    const runtimeSession = getActiveRecordingSession(payload?.sessionId)
    if (!runtimeSession) {
      throw new Error('Recording session not found.')
    }

    return enqueueRecordingSessionTask(runtimeSession, async () => {
      const result = await appendRecordingSessionChunkImpl(runtimeSession, payload)

      return {
        ...result,
        ...(await getRecordingSessionStatus(runtimeSession))
      }
    })
  }

  /** Explicitly rotates the current segment or upload part. */
  async function rotateRecordingSessionSegment(payload = {}) {
    const runtimeSession = getActiveRecordingSession(payload?.sessionId)
    if (!runtimeSession) {
      throw new Error('Recording session not found.')
    }

    return enqueueRecordingSessionTask(runtimeSession, async () => {
      await rotateRecordingSessionSegmentImpl(runtimeSession)

      return {
        ok: true,
        ...(await getRecordingSessionStatus(runtimeSession))
      }
    })
  }

  /** Stops recording, finalizes local output, and schedules cloud finalize if needed. */
  async function stopRecordingSession(payload = {}) {
    const runtimeSession = getActiveRecordingSession(payload?.sessionId)
    if (!runtimeSession) {
      throw new Error('Recording session not found.')
    }

    return enqueueRecordingSessionTask(runtimeSession, async () => {
      if (runtimeSession.manifest.status === 'stopped') {
        return {
          ok: true,
          ...(await getRecordingSessionStatus(runtimeSession))
        }
      }

      await finalizeCurrentRecordingSessionSegment(runtimeSession)
      runtimeSession.manifest.status = 'stopped'
      runtimeSession.manifest.stoppedAt = Date.now()

      if (runtimeSession.manifest.cloudSyncEnabled && runtimeSession.writeStream) {
        await new Promise((resolveCallback, rejectCallback) => {
          runtimeSession.writeStream.end((error) => {
            if (error) {
              rejectCallback(error)
              return
            }
            resolveCallback()
          })
        })
        runtimeSession.writeStream = null
      }

      await persistRecordingSessionManifest(runtimeSession)
      activeRecordingSessions.delete(runtimeSession.id)

      try {
        const mergeResult = await mergeRecordingSession(runtimeSession)
        if (!runtimeSession.manifest.cloudSyncEnabled) {
          await cleanupRecordingSessionArtifacts(runtimeSession)
        }
        scheduleCloudSyncFinalize(runtimeSession)
        return {
          ok: true,
          item: mergeResult.item,
          ...(await getRecordingSessionStatus(runtimeSession))
        }
      } catch (error) {
        runtimeSession.manifest.output = {
          path: '',
          status: 'failed',
          bytes: 0,
          createdAt: 0,
          message: error instanceof Error ? error.message : 'Failed to merge recording session.'
        }
        await persistRecordingSessionManifest(runtimeSession)

        return {
          ok: false,
          message: error instanceof Error ? error.message : 'Failed to merge recording session.',
          ...(await getRecordingSessionStatus(runtimeSession))
        }
      }
    })
  }

  /** Cancels the current recording and discards unfinished artifacts. */
  async function cancelRecordingSession(payload = {}) {
    const runtimeSession = getActiveRecordingSession(payload?.sessionId)
    if (!runtimeSession) {
      throw new Error('Recording session not found.')
    }

    return enqueueRecordingSessionTask(runtimeSession, async () => {
      clearCloudSyncWorker(runtimeSession.id)
      activeRecordingSessions.delete(runtimeSession.id)

      if (runtimeSession.partWriteStream) {
        await new Promise((resolveCallback) => {
          runtimeSession.partWriteStream.end(() => resolveCallback())
        }).catch(() => {})
      }

      if (runtimeSession.writeStream) {
        await new Promise((resolveCallback) => {
          runtimeSession.writeStream.end(() => resolveCallback())
        }).catch(() => {})
      }

      runtimeSession.partWriteStream = null
      runtimeSession.writeStream = null
      runtimeSession.currentSegment = null
      runtimeSession.manifest.status = 'cancelled'
      runtimeSession.manifest.stoppedAt = Date.now()

      await cleanupRecordingSessionArtifacts(runtimeSession)

      return {
        ok: true,
        sessionId: runtimeSession.id,
        status: 'cancelled'
      }
    })
  }

  async function getRuntimeSessionForCloudSync(payload = {}) {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
    if (sessionId) {
      const activeSession = getActiveRecordingSession(sessionId)
      if (activeSession) {
        return activeSession
      }

      const storedSession = readCloudSyncSessionRowsFromDatabase(sessionId)
      if (!storedSession) {
        return null
      }

      return await createCloudSyncRuntimeSessionFromDatabase(
        storedSession.sessionRow,
        storedSession.segmentRows,
        applyRecordingSessionManifestDefaults,
        createCloudSyncState,
        createRuntimeSession
      )
    }

    return null
  }

  return {
    buildCloudSyncMetadata,
    cleanupRecordingSessionArtifacts,
    createRecordingSession,
    createRuntimeSession,
    getActiveRecordingSession,
    getRecordingSessionStatus,
    persistRecordingSessionManifest,
    appendRecordingSessionChunk,
    rotateRecordingSessionSegment,
    stopRecordingSession,
    cancelRecordingSession,
    recoverPendingRecordingSessions,
    getRuntimeSessionForCloudSync,
    resumeAllCloudSyncSessions
  }
}
