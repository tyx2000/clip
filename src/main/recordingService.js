import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { createCloudSyncRuntime } from './cloudSyncRuntime'
import { createRecordingCatalog } from './recordingCatalog'
import { createRecordingFinalizerRuntime } from './recordingFinalizer'
import {
  listSessionArtifactPaths,
  probeVideoDurationSec,
  runFfmpeg,
  sha256File
} from './mediaUtils'
import {
  createRecordingSessionId,
  getRecordingSessionsDirectoryPath,
  getVideoExtensionFromMimeType
} from './recordingPaths'
import { createRecordingRecoveryRuntime } from './recordingRecovery'
import {
  applyRecordingSessionStateDefaults,
  createCloudSyncState,
  getCloudSyncRetryDelayMs,
  getCloudSyncServerUrl,
  normalizeCloudSyncEnabled,
  normalizeSegmentCloudSyncState,
  normalizeSegmentDurationMs,
  parseChunkPayloadToBuffer,
  parseDataUrl
} from './recordingRuntimeUtils'
import { createRecordingSegmentsRuntime } from './recordingSegments'
import { createRecordingStorageRuntime } from './recordingStorage'

export function createRecordingService() {
  const activeRecordingSessions = new Map()
  const storageRuntime = createRecordingStorageRuntime({
    getCloudSyncServerUrl,
    createCloudSyncState
  })
  const {
    createRecordingSessionState,
    persistRecordingSessionState,
    buildCloudSyncMetadata,
    getRecordingSessionStatus,
    createRuntimeSession,
    readRecordingMetadata,
    writeRecordingMetadata,
    deleteRecordingMetadataFromDatabase,
    deleteRecordingSessionFromDatabase,
    deleteCloudSessionFromDatabase,
    listCloudSyncSessionRowsFromDatabase,
    listLocalRecordingSessionRowsFromDatabase,
    readCloudSyncSessionRowsFromDatabase,
    readRecordingSessionRowsFromDatabase,
    createLocalRuntimeSessionFromDatabase,
    createCloudSyncRuntimeSessionFromDatabase
  } = storageRuntime

  let recoveryRuntime = null

  function cleanupRecordingSessionArtifacts(...args) {
    return recoveryRuntime.cleanupRecordingSessionArtifacts(...args)
  }

  const cloudSyncRuntime = createCloudSyncRuntime({
    getCloudSyncRetryDelayMs,
    persistRecordingSessionState,
    buildCloudSyncMetadata,
    writeRecordingMetadata,
    cleanupRecordingSessionArtifacts,
    sha256File
  })
  const { clearCloudSyncWorker, scheduleCloudSyncProcessing, scheduleCloudSyncFinalize } =
    cloudSyncRuntime

  const recordingCatalog = createRecordingCatalog({
    readRecordingMetadata,
    writeRecordingMetadata,
    probeVideoDurationSec,
    toRecordingMediaUrl: (filePath) => `recording://media/${encodeURIComponent(filePath)}`,
    parseDataUrl,
    deleteRecordingMetadataFromDatabase
  })
  const {
    isRecordingFilePath,
    buildRecordingItem,
    listRecordingItems,
    saveRecordingFromDataUrl,
    deleteRecordingFile
  } = recordingCatalog

  const finalizerRuntime = createRecordingFinalizerRuntime({
    persistRecordingSessionState,
    buildCloudSyncMetadata,
    listSessionArtifactPaths,
    deleteRecordingSessionFromDatabase,
    deleteCloudSessionFromDatabase,
    runFfmpeg,
    probeVideoDurationSec,
    buildRecordingItem,
    writeRecordingMetadata
  })
  const {
    cleanupRecordingSessionArtifacts: cleanupRecordingSessionArtifactsImpl,
    mergeRecordingSession
  } = finalizerRuntime

  recoveryRuntime = createRecordingRecoveryRuntime({
    persistRecordingSessionState,
    normalizeSegmentCloudSyncState,
    applyRecordingSessionStateDefaults,
    listLocalRecordingSessionRowsFromDatabase,
    readRecordingSessionRowsFromDatabase,
    createLocalRuntimeSessionFromDatabase,
    listCloudSyncSessionRowsFromDatabase,
    readCloudSyncSessionRowsFromDatabase,
    createCloudSyncRuntimeSessionFromDatabase,
    createCloudSyncState,
    createRuntimeSession,
    scheduleCloudSyncProcessing,
    cleanupRecordingSessionArtifacts: cleanupRecordingSessionArtifactsImpl,
    mergeRecordingSession
  })

  const { recoverPendingRecordingSessions, resumeAllCloudSyncSessions } = recoveryRuntime

  const segmentsRuntime = createRecordingSegmentsRuntime({
    persistRecordingSessionState,
    scheduleCloudSyncProcessing,
    parseChunkPayloadToBuffer
  })
  const {
    openRecordingSessionSegment,
    finalizeCurrentRecordingSessionSegment,
    appendRecordingSessionChunk: appendRecordingSessionChunkImpl,
    rotateRecordingSessionSegment: rotateRecordingSessionSegmentImpl
  } = segmentsRuntime

  function getActiveRecordingSession(sessionId) {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!normalizedSessionId) {
      return null
    }
    return activeRecordingSessions.get(normalizedSessionId) || null
  }

  async function enqueueRecordingSessionTask(runtimeSession, task) {
    runtimeSession.writeQueue = runtimeSession.writeQueue.then(task, task)
    return runtimeSession.writeQueue
  }

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
      manifest: createRecordingSessionState({
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

      await persistRecordingSessionState(runtimeSession)
      activeRecordingSessions.delete(runtimeSession.id)

      try {
        const mergeResult = await mergeRecordingSession(runtimeSession)
        if (!runtimeSession.manifest.cloudSyncEnabled) {
          await cleanupRecordingSessionArtifactsImpl(runtimeSession)
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
        await persistRecordingSessionState(runtimeSession)

        return {
          ok: false,
          message: error instanceof Error ? error.message : 'Failed to merge recording session.',
          ...(await getRecordingSessionStatus(runtimeSession))
        }
      }
    })
  }

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

      await cleanupRecordingSessionArtifactsImpl(runtimeSession)

      return {
        ok: true,
        sessionId: runtimeSession.id,
        status: 'cancelled'
      }
    })
  }

  async function getRuntimeSessionForCloudSync(payload = {}) {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
    if (!sessionId) {
      return null
    }

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
      applyRecordingSessionStateDefaults
    )
  }

  async function retryCloudSyncSession(payload = {}) {
    const runtimeSession = await getRuntimeSessionForCloudSync(payload)
    if (!runtimeSession) {
      throw new Error('Cloud sync session not found.')
    }

    if (!runtimeSession.manifest.cloudSyncEnabled) {
      throw new Error('This recording did not enable cloud sync.')
    }

    runtimeSession.manifest.cloudSync.lastError = ''
    runtimeSession.manifest.cloudSync.status = 'pending'
    runtimeSession.manifest.cloudSync.completedAt = null
    runtimeSession.manifest.cloudSync.remoteVideoUrl = ''
    runtimeSession.manifest.cloudSync.nextRetryAt = null

    for (const segment of runtimeSession.manifest.segments) {
      if (segment.status === 'ready' && segment.uploadStatus === 'failed') {
        segment.uploadStatus = 'pending'
      }
    }

    await persistRecordingSessionState(runtimeSession)
    scheduleCloudSyncProcessing(runtimeSession)

    return {
      ok: true,
      sessionId: runtimeSession.id,
      ...(await getRecordingSessionStatus(runtimeSession))
    }
  }

  return {
    getActiveRecordingSession,
    getRecordingSessionStatus,
    createRecordingSession,
    appendRecordingSessionChunk,
    rotateRecordingSessionSegment,
    stopRecordingSession,
    cancelRecordingSession,
    retryCloudSyncSession,
    resumeAllCloudSyncSessions,
    recoverPendingRecordingSessions,
    getRuntimeSessionForCloudSync,
    clearCloudSyncWorker,
    cleanupRecordingSessionArtifacts: cleanupRecordingSessionArtifactsImpl,
    isRecordingFilePath,
    listRecordingItems,
    saveRecordingFromDataUrl,
    deleteRecordingFile
  }
}
