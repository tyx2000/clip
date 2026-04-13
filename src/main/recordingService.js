/** 文件作用：录屏主业务编排层，统一协调分段写盘、状态持久化、收尾和云同步。 */
import { existsSync } from 'fs'
import { mkdir, stat } from 'fs/promises'
import { join } from 'path'
import {
  clearCloudSyncWorker,
  scheduleCloudSyncFinalize,
  scheduleCloudSyncProcessing
} from './cloudSyncRuntime'
import {
  DEFAULT_CLOUD_SYNC_SERVER_URL,
  DEFAULT_SEGMENT_DURATION_MS,
  MIN_SEGMENT_DURATION_MS,
  createRecordingCaptureTempFileName,
  createRecordingSessionId,
  getRecordingSessionsDirectoryPath,
  getVideoExtensionFromMimeType
} from './mediaUtils'
import { cleanupRecordingSessionArtifacts, mergeRecordingSession } from './recordingFinalizer'
import {
  createRuntimeSessionFromDatabase,
  createRecordingSessionState,
  deleteRecordingFile,
  getRecordingSessionStatus,
  isRecordingFilePath,
  listCloudSyncSessionRowsFromDatabase,
  listLocalRecordingSessionRowsFromDatabase,
  listRecordingItems,
  persistRecordingSessionState,
  readCloudSyncSessionRowsFromDatabase,
  readRecordingSessionRowsFromDatabase,
  saveRecordingFromDataUrl
} from './recordingStorage'
import {
  appendRecordingSessionChunk,
  finalizeCurrentRecordingSessionSegment,
  openRecordingSessionSegment,
  rotateRecordingSessionSegment
} from './recordingSegments'

/** 创建录屏服务实例，向 IPC 层暴露统一的业务方法。 */
export function createRecordingService() {
  const activeRecordingSessions = new Map()
  const cloudSyncWorkers = new Map()

  /** 归一化从数据库恢复出来的会话状态，修正中断写入和上传状态。 */
  async function normalizeRecoveredRecordingSession(runtimeSession) {
    let sessionStateChanged = false
    const now = Date.now()

    const cloudSyncEnabled = !!runtimeSession.manifest?.cloudSyncEnabled
    const cloudSyncServerUrlCandidate =
      typeof runtimeSession.manifest?.cloudSync?.serverUrl === 'string' &&
      runtimeSession.manifest.cloudSync.serverUrl.trim()
        ? runtimeSession.manifest.cloudSync.serverUrl.trim()
        : process.env.CLOUD_SYNC_SERVER_URL || DEFAULT_CLOUD_SYNC_SERVER_URL

    runtimeSession.manifest = {
      ...runtimeSession.manifest,
      version: 2,
      cloudSyncEnabled,
      cloudSync: {
        enabled: cloudSyncEnabled,
        serverUrl: cloudSyncEnabled ? cloudSyncServerUrlCandidate.replace(/\/+$/, '') : '',
        status: cloudSyncEnabled ? 'pending' : 'disabled',
        remoteVideoUrl: '',
        lastError: '',
        completedAt: null,
        lastAttemptAt: null,
        nextRetryAt: null,
        ...(runtimeSession.manifest?.cloudSync &&
        typeof runtimeSession.manifest.cloudSync === 'object'
          ? runtimeSession.manifest.cloudSync
          : {})
      },
      segments: Array.isArray(runtimeSession.manifest?.segments)
        ? runtimeSession.manifest.segments.map((segment) => ({
            ...segment,
            uploadStatus:
              typeof segment?.uploadStatus === 'string' && segment.uploadStatus
                ? segment.uploadStatus
                : 'pending',
            checksum: typeof segment?.checksum === 'string' ? segment.checksum : '',
            etag: typeof segment?.etag === 'string' ? segment.etag : '',
            uploadedAt: Number(segment?.uploadedAt || 0) || null,
            retryCount: Number(segment?.retryCount || 0)
          }))
        : []
    }

    for (const segment of runtimeSession.manifest.segments) {
      const normalizedSyncState = {
        uploadStatus:
          typeof segment?.uploadStatus === 'string' && segment.uploadStatus
            ? segment.uploadStatus
            : 'pending',
        checksum: typeof segment?.checksum === 'string' ? segment.checksum : '',
        etag: typeof segment?.etag === 'string' ? segment.etag : '',
        uploadedAt: Number(segment?.uploadedAt || 0) || null,
        retryCount: Number(segment?.retryCount || 0)
      }
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

        runtimeSession = createRuntimeSessionFromDatabase(
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
          await cleanupRecordingSessionArtifacts(runtimeSession)
          summary.skipped += 1
          continue
        }

        if (!shouldRecoverRecordingSession(runtimeSession)) {
          summary.skipped += 1
          continue
        }

        await mergeRecordingSession(runtimeSession)
        try {
          await cleanupRecordingSessionArtifacts(runtimeSession)
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

        const runtimeSession = createRuntimeSessionFromDatabase(
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
          await mergeRecordingSession(runtimeSession)
        }

        scheduleCloudSyncProcessing(cloudSyncWorkers, runtimeSession)
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
    const cloudSyncEnabled = !!payload?.cloudSyncEnabled
    const extension = getVideoExtensionFromMimeType(detectedMimeType)
    const requestedSegmentDurationMs = Number(payload?.segmentDurationMs)
    const segmentDurationMs =
      Number.isFinite(requestedSegmentDurationMs) &&
      requestedSegmentDurationMs >= MIN_SEGMENT_DURATION_MS
        ? Math.floor(requestedSegmentDurationMs)
        : DEFAULT_SEGMENT_DURATION_MS
    const cloudSyncServerUrlCandidate =
      typeof payload?.cloudSyncServerUrl === 'string' && payload.cloudSyncServerUrl.trim()
        ? payload.cloudSyncServerUrl.trim()
        : process.env.CLOUD_SYNC_SERVER_URL || DEFAULT_CLOUD_SYNC_SERVER_URL
    const cloudSyncServerUrl = cloudSyncServerUrlCandidate.replace(/\/+$/, '')
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
        scheduleCloudSyncProcessing(cloudSyncWorkers, runtimeSession)
      }
      return runtimeSession
    } catch (error) {
      activeRecordingSessions.delete(sessionId)
      throw error
    }
  }

  /** 追加一个来自渲染进程的录屏 chunk。 */
  async function handleAppendRecordingSessionChunk(payload = {}) {
    const runtimeSession = getActiveRecordingSession(payload?.sessionId)
    if (!runtimeSession) {
      throw new Error('Recording session not found.')
    }

    return enqueueRecordingSessionTask(runtimeSession, async () => {
      const result = await appendRecordingSessionChunk(cloudSyncWorkers, runtimeSession, payload)
      return {
        ...result,
        ...(await getRecordingSessionStatus(runtimeSession))
      }
    })
  }

  /** 显式轮转当前录屏分段。 */
  async function handleRotateRecordingSessionSegment(payload = {}) {
    const runtimeSession = getActiveRecordingSession(payload?.sessionId)
    if (!runtimeSession) {
      throw new Error('Recording session not found.')
    }

    return enqueueRecordingSessionTask(runtimeSession, async () => {
      await rotateRecordingSessionSegment(cloudSyncWorkers, runtimeSession)
      return {
        ok: true,
        ...(await getRecordingSessionStatus(runtimeSession))
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
          ...(await getRecordingSessionStatus(runtimeSession))
        }
      }

      await finalizeCurrentRecordingSessionSegment(cloudSyncWorkers, runtimeSession)
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
          await cleanupRecordingSessionArtifacts(runtimeSession)
        }
        scheduleCloudSyncFinalize(cloudSyncWorkers, runtimeSession)
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

  /** 取消当前录屏并删除未完成的临时产物。 */
  async function cancelRecordingSession(payload = {}) {
    const runtimeSession = getActiveRecordingSession(payload?.sessionId)
    if (!runtimeSession) {
      throw new Error('Recording session not found.')
    }

    return enqueueRecordingSessionTask(runtimeSession, async () => {
      clearCloudSyncWorker(cloudSyncWorkers, runtimeSession.id)
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

    return await createRuntimeSessionFromDatabase(
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
    scheduleCloudSyncProcessing(cloudSyncWorkers, runtimeSession)

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
    appendRecordingSessionChunk: handleAppendRecordingSessionChunk,
    rotateRecordingSessionSegment: handleRotateRecordingSessionSegment,
    stopRecordingSession,
    cancelRecordingSession,
    retryCloudSyncSession,
    resumeAllCloudSyncSessions,
    recoverPendingRecordingSessions,
    getRuntimeSessionForCloudSync,
    clearCloudSyncWorker: (sessionId) => clearCloudSyncWorker(cloudSyncWorkers, sessionId),
    cleanupRecordingSessionArtifacts,
    isRecordingFilePath,
    listRecordingItems,
    saveRecordingFromDataUrl,
    deleteRecordingFile
  }
}
