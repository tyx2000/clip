/** 文件作用：录屏主业务编排层，统一协调分段写盘、状态持久化、收尾和云同步。 */
import { existsSync } from 'fs'
import { mkdir, stat } from 'fs/promises'
import { join } from 'path'
import {
  clearCloudSyncWorker as clearCloudSyncWorkerImpl,
  scheduleCloudSyncFinalize as scheduleCloudSyncFinalizeImpl,
  scheduleCloudSyncProcessing as scheduleCloudSyncProcessingImpl
} from './cloudSyncRuntime'
import {
  listSessionArtifactPaths,
  probeVideoDurationSec,
  runFfmpeg,
  sha256File
} from './mediaUtils'
import {
  cleanupRecordingSessionArtifacts as cleanupRecordingSessionArtifactsImpl,
  mergeRecordingSession as mergeRecordingSessionImpl
} from './recordingFinalizer'
import {
  createRecordingCaptureTempFileName,
  createRecordingSessionId,
  getRecordingSessionsDirectoryPath,
  getVideoExtensionFromMimeType
} from './recordingPaths'
import {
  buildCloudSyncMetadata as buildCloudSyncMetadataImpl,
  buildRecordingItem as buildRecordingItemImpl,
  createCloudSyncRuntimeSessionFromDatabase as createCloudSyncRuntimeSessionFromDatabaseImpl,
  createLocalRuntimeSessionFromDatabase as createLocalRuntimeSessionFromDatabaseImpl,
  createRecordingSessionState as createRecordingSessionStateImpl,
  deleteRecordingFile,
  deleteRecordingSessionFromDatabase,
  getRecordingSessionStatus as getRecordingSessionStatusImpl,
  isRecordingFilePath,
  listCloudSyncSessionRowsFromDatabase,
  listLocalRecordingSessionRowsFromDatabase,
  listRecordingItems as listRecordingItemsImpl,
  persistRecordingSessionState,
  readCloudSyncSessionRowsFromDatabase,
  readRecordingSessionRowsFromDatabase,
  saveRecordingFromDataUrl as saveRecordingFromDataUrlImpl,
  writeRecordingMetadata
} from './recordingStorage'
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
import {
  appendRecordingSessionChunk as appendRecordingSessionChunkImpl,
  finalizeCurrentRecordingSessionSegment as finalizeCurrentRecordingSessionSegmentImpl,
  openRecordingSessionSegment as openRecordingSessionSegmentImpl,
  rotateRecordingSessionSegment as rotateRecordingSessionSegmentImpl
} from './recordingSegments'

/** 创建录屏服务实例，向 IPC 层暴露统一的业务方法。 */
export function createRecordingService() {
  const activeRecordingSessions = new Map()
  const storageDeps = {
    getCloudSyncServerUrl,
    createCloudSyncState,
    probeVideoDurationSec,
    parseDataUrl
  }

  const cloudSyncWorkers = new Map()

  const finalizerDeps = {
    persistRecordingSessionState,
    buildCloudSyncMetadata: buildCloudSyncMetadataImpl,
    listSessionArtifactPaths,
    deleteRecordingSessionFromDatabase,
    runFfmpeg,
    probeVideoDurationSec,
    buildRecordingItem: (filePath, fileStat) =>
      buildRecordingItemImpl(storageDeps, filePath, fileStat),
    writeRecordingMetadata
  }

  const cloudSyncDeps = {
    getCloudSyncRetryDelayMs,
    persistRecordingSessionState,
    buildCloudSyncMetadata: buildCloudSyncMetadataImpl,
    writeRecordingMetadata,
    cleanupRecordingSessionArtifacts: (runtimeSession) =>
      cleanupRecordingSessionArtifactsImpl(finalizerDeps, runtimeSession),
    sha256File
  }

  const segmentDeps = {
    persistRecordingSessionState,
    scheduleCloudSyncProcessing: (runtimeSession, delayMs = 0) =>
      scheduleCloudSyncProcessingImpl(cloudSyncDeps, cloudSyncWorkers, runtimeSession, delayMs),
    parseChunkPayloadToBuffer
  }

  /** 归一化从数据库恢复出来的会话状态，修正中断写入和上传状态。 */
  async function normalizeRecoveredRecordingSession(runtimeSession) {
    let sessionStateChanged = false
    const now = Date.now()

    runtimeSession.manifest = applyRecordingSessionStateDefaults(runtimeSession.manifest)

    for (const segment of runtimeSession.manifest.segments) {
      const normalizedSyncState = normalizeSegmentCloudSyncState(segment)
      if (
        segment.uploadStatus !== normalizedSyncState.uploadStatus ||
        segment.checksum !== normalizedSyncState.checksum ||
        segment.etag !== normalizedSyncState.etag ||
        segment.uploadedAt !== normalizedSyncState.uploadedAt
      ) {
        Object.assign(segment, normalizedSyncState)
        sessionStateChanged = true
      }

      if (segment.uploadStatus === 'uploading') {
        segment.uploadStatus = 'pending'
        sessionStateChanged = true
      }

      if (segment?.status === 'ready' && existsSync(segment.path)) {
        const fileStat = await stat(segment.path)
        segment.bytes = Number(fileStat.size || segment.bytes || 0)
        segment.endedAt = Number(segment.endedAt || fileStat.mtimeMs || now)
        continue
      }

      if (segment?.status !== 'writing') {
        continue
      }

      if (existsSync(segment.path)) {
        const fileStat = await stat(segment.path)
        segment.status = 'ready'
        segment.bytes = Number(fileStat.size || 0)
        segment.endedAt = Number(fileStat.mtimeMs || now)
        sessionStateChanged = true
        continue
      }

      const partialPath = `${segment.path}.part`
      if (existsSync(partialPath)) {
        const fileStat = await stat(partialPath)
        segment.status = 'interrupted'
        segment.bytes = Number(fileStat.size || segment.bytes || 0)
        segment.endedAt = Number(fileStat.mtimeMs || now)
        segment.partialPath = partialPath
        sessionStateChanged = true
        continue
      }

      segment.status = 'missing'
      segment.endedAt = Number(segment.endedAt || now)
      sessionStateChanged = true
    }

    if (runtimeSession.manifest.status === 'recording') {
      runtimeSession.manifest.status = 'interrupted'
      runtimeSession.manifest.stoppedAt = runtimeSession.manifest.stoppedAt || now
      sessionStateChanged = true
    }

    if (runtimeSession.manifest.cloudSyncEnabled) {
      const hasFailedSegments = runtimeSession.manifest.segments.some(
        (segment) => segment.uploadStatus === 'failed'
      )
      const hasPendingSegments = runtimeSession.manifest.segments.some(
        (segment) =>
          segment.status === 'ready' &&
          segment.uploadStatus !== 'uploaded' &&
          segment.uploadStatus !== 'disabled'
      )

      const nextCloudStatus = hasFailedSegments
        ? 'failed'
        : hasPendingSegments
          ? 'pending'
          : runtimeSession.manifest.cloudSync.status === 'completed'
            ? 'completed'
            : 'merging'

      if (runtimeSession.manifest.cloudSync.status !== nextCloudStatus) {
        runtimeSession.manifest.cloudSync.status = nextCloudStatus
        sessionStateChanged = true
      }
    }

    if (sessionStateChanged) {
      await persistRecordingSessionState(runtimeSession)
    }
  }

  /** 判断某个恢复态会话是否仍需要继续本地恢复。 */
  function shouldRecoverRecordingSession(runtimeSession) {
    const outputPath = runtimeSession.manifest.output?.path || ''
    const outputReady =
      runtimeSession.manifest.output?.status === 'ready' && outputPath && existsSync(outputPath)
    if (outputReady) {
      return false
    }

    if (runtimeSession.manifest.cloudSyncEnabled) {
      const captureTempPath =
        runtimeSession.captureTempPath ||
        join(
          runtimeSession.dir,
          createRecordingCaptureTempFileName(runtimeSession.manifest.extension)
        )
      if (existsSync(captureTempPath)) {
        return true
      }
    }

    return runtimeSession.manifest.segments.some((segment) => segment.status === 'ready')
  }

  /** 启动时扫描并恢复未完成的本地录屏会话。 */
  async function recoverPendingRecordingSessions() {
    const summary = {
      scanned: 0,
      recovered: 0,
      skipped: 0,
      failed: 0
    }

    const sessionRows = listLocalRecordingSessionRowsFromDatabase()
    for (const sessionRow of sessionRows) {
      summary.scanned += 1
      let runtimeSession = null

      try {
        const storedSession = readRecordingSessionRowsFromDatabase(sessionRow.sessionId)
        if (!storedSession) {
          summary.skipped += 1
          continue
        }

        runtimeSession = createLocalRuntimeSessionFromDatabaseImpl(
          storageDeps,
          storedSession.sessionRow,
          storedSession.segmentRows
        )
        if (!runtimeSession) {
          summary.skipped += 1
          continue
        }

        await normalizeRecoveredRecordingSession(runtimeSession)

        const outputPath = runtimeSession.manifest.output?.path || ''
        const outputReady =
          runtimeSession.manifest.output?.status === 'ready' && outputPath && existsSync(outputPath)
        if (outputReady) {
          await cleanupRecordingSessionArtifactsImpl(finalizerDeps, runtimeSession)
          summary.skipped += 1
          continue
        }

        if (!shouldRecoverRecordingSession(runtimeSession)) {
          summary.skipped += 1
          continue
        }

        await mergeRecordingSessionImpl(finalizerDeps, runtimeSession)
        try {
          await cleanupRecordingSessionArtifactsImpl(finalizerDeps, runtimeSession)
        } catch (error) {
          console.warn(
            '[recording] failed to clean recovered local session:',
            runtimeSession.id,
            error instanceof Error ? error.message : error
          )
        }
        summary.recovered += 1
      } catch (error) {
        summary.failed += 1
        if (runtimeSession) {
          runtimeSession.manifest.output = {
            path: '',
            status: 'failed',
            bytes: 0,
            createdAt: 0,
            message: error instanceof Error ? error.message : 'Failed to recover recording session.'
          }
          await persistRecordingSessionState(runtimeSession).catch(() => {})
        }
        console.warn(
          '[recording] failed to recover session:',
          sessionRow.sessionId,
          error instanceof Error ? error.message : error
        )
      }
    }

    return summary
  }

  /** 启动时把待继续的云同步会话重新加入处理队列。 */
  async function resumeAllCloudSyncSessions() {
    const sessionRows = listCloudSyncSessionRowsFromDatabase().filter((sessionRow) =>
      ['pending', 'syncing', 'merging', 'failed'].includes(sessionRow.cloudSyncStatus || '')
    )
    let resumed = 0

    for (const sessionRow of sessionRows) {
      try {
        const storedSession = readCloudSyncSessionRowsFromDatabase(sessionRow.sessionId)
        if (!storedSession) {
          continue
        }

        const runtimeSession = createCloudSyncRuntimeSessionFromDatabaseImpl(
          storageDeps,
          storedSession.sessionRow,
          storedSession.segmentRows
        )
        if (!runtimeSession?.manifest?.cloudSyncEnabled) {
          continue
        }

        await normalizeRecoveredRecordingSession(runtimeSession)
        const outputPath = runtimeSession.manifest.output?.path || ''
        const outputReady =
          runtimeSession.manifest.output?.status === 'ready' && outputPath && existsSync(outputPath)

        if (!outputReady && shouldRecoverRecordingSession(runtimeSession)) {
          await mergeRecordingSessionImpl(finalizerDeps, runtimeSession)
        }

        scheduleCloudSyncProcessingImpl(cloudSyncDeps, cloudSyncWorkers, runtimeSession)
        resumed += 1
      } catch {
        continue
      }
    }

    return {
      ok: true,
      resumed
    }
  }

  /** 根据会话 id 获取当前仍在内存中的活动会话。 */
  function getActiveRecordingSession(sessionId) {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!normalizedSessionId) {
      return null
    }
    return activeRecordingSessions.get(normalizedSessionId) || null
  }

  /** 通过 Promise 队列串行化同一会话的磁盘写操作。 */
  async function enqueueRecordingSessionTask(runtimeSession, task) {
    runtimeSession.writeQueue = runtimeSession.writeQueue.then(task, task)
    return runtimeSession.writeQueue
  }

  /** 创建一个新的录屏会话并打开首个分段。 */
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
      manifest: createRecordingSessionStateImpl(storageDeps, {
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
      await openRecordingSessionSegmentImpl(segmentDeps, runtimeSession, 1)
      if (cloudSyncEnabled) {
        scheduleCloudSyncProcessingImpl(cloudSyncDeps, cloudSyncWorkers, runtimeSession)
      }
      return runtimeSession
    } catch (error) {
      activeRecordingSessions.delete(sessionId)
      throw error
    }
  }

  /** 追加一个来自渲染进程的录屏 chunk。 */
  async function appendRecordingSessionChunk(payload = {}) {
    const runtimeSession = getActiveRecordingSession(payload?.sessionId)
    if (!runtimeSession) {
      throw new Error('Recording session not found.')
    }

    return enqueueRecordingSessionTask(runtimeSession, async () => {
      const result = await appendRecordingSessionChunkImpl(segmentDeps, runtimeSession, payload)
      return {
        ...result,
        ...(await getRecordingSessionStatusImpl(runtimeSession))
      }
    })
  }

  /** 显式轮转当前录屏分段。 */
  async function rotateRecordingSessionSegment(payload = {}) {
    const runtimeSession = getActiveRecordingSession(payload?.sessionId)
    if (!runtimeSession) {
      throw new Error('Recording session not found.')
    }

    return enqueueRecordingSessionTask(runtimeSession, async () => {
      await rotateRecordingSessionSegmentImpl(segmentDeps, runtimeSession)
      return {
        ok: true,
        ...(await getRecordingSessionStatusImpl(runtimeSession))
      }
    })
  }

  /** 停止录屏、完成本地收尾，并在需要时触发云同步收尾。 */
  async function stopRecordingSession(payload = {}) {
    const runtimeSession = getActiveRecordingSession(payload?.sessionId)
    if (!runtimeSession) {
      throw new Error('Recording session not found.')
    }

    return enqueueRecordingSessionTask(runtimeSession, async () => {
      if (runtimeSession.manifest.status === 'stopped') {
        return {
          ok: true,
          ...(await getRecordingSessionStatusImpl(runtimeSession))
        }
      }

      await finalizeCurrentRecordingSessionSegmentImpl(segmentDeps, runtimeSession)
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
        const mergeResult = await mergeRecordingSessionImpl(finalizerDeps, runtimeSession)
        if (!runtimeSession.manifest.cloudSyncEnabled) {
          await cleanupRecordingSessionArtifactsImpl(finalizerDeps, runtimeSession)
        }
        scheduleCloudSyncFinalizeImpl(cloudSyncDeps, cloudSyncWorkers, runtimeSession)
        return {
          ok: true,
          item: mergeResult.item,
          ...(await getRecordingSessionStatusImpl(runtimeSession))
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
          ...(await getRecordingSessionStatusImpl(runtimeSession))
        }
      }
    })
  }

  /** 取消当前录屏并删除未完成的临时产物。 */
  async function cancelRecordingSession(payload = {}) {
    const runtimeSession = getActiveRecordingSession(payload?.sessionId)
    if (!runtimeSession) {
      throw new Error('Recording session not found.')
    }

    return enqueueRecordingSessionTask(runtimeSession, async () => {
      clearCloudSyncWorkerImpl(cloudSyncWorkers, runtimeSession.id)
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

      await cleanupRecordingSessionArtifactsImpl(finalizerDeps, runtimeSession)

      return {
        ok: true,
        sessionId: runtimeSession.id,
        status: 'cancelled'
      }
    })
  }

  /** 按 sessionId 获取一个可用于云同步恢复的会话对象。 */
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

    return await createCloudSyncRuntimeSessionFromDatabaseImpl(
      storageDeps,
      storedSession.sessionRow,
      storedSession.segmentRows
    )
  }

  /** 把失败的云同步会话重置回可重试状态。 */
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
    scheduleCloudSyncProcessingImpl(cloudSyncDeps, cloudSyncWorkers, runtimeSession)

    return {
      ok: true,
      sessionId: runtimeSession.id,
      ...(await getRecordingSessionStatusImpl(runtimeSession))
    }
  }

  return {
    getActiveRecordingSession,
    getRecordingSessionStatus: getRecordingSessionStatusImpl,
    createRecordingSession,
    appendRecordingSessionChunk,
    rotateRecordingSessionSegment,
    stopRecordingSession,
    cancelRecordingSession,
    retryCloudSyncSession,
    resumeAllCloudSyncSessions,
    recoverPendingRecordingSessions,
    getRuntimeSessionForCloudSync,
    clearCloudSyncWorker: (sessionId) => clearCloudSyncWorkerImpl(cloudSyncWorkers, sessionId),
    cleanupRecordingSessionArtifacts: (runtimeSession) =>
      cleanupRecordingSessionArtifactsImpl(finalizerDeps, runtimeSession),
    isRecordingFilePath,
    listRecordingItems: () => listRecordingItemsImpl(storageDeps),
    saveRecordingFromDataUrl: (payload) => saveRecordingFromDataUrlImpl(storageDeps, payload),
    deleteRecordingFile
  }
}
