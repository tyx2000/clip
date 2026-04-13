/** 文件作用：负责录屏云同步的后台上传、合并请求和重试调度。 */
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { CLOUD_SYNC_RETRY_DELAYS_MS, sha256File } from './mediaUtils'
import { cleanupRecordingSessionArtifacts } from './recordingFinalizer'
import {
  buildCloudSyncMetadata,
  persistRecordingSessionState,
  writeRecordingMetadata
} from './recordingStorage'

/** 解析云同步接口返回的 JSON 响应。 */
async function parseJsonResponse(response) {
  const text = await response.text()
  if (!text.trim()) {
    return {}
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Unexpected cloud sync response (${response.status}).`)
  }
}

/** 向配置好的云同步服务发送一次 JSON 请求。 */
async function cloudSyncFetchJson(runtimeSession, path, init = {}) {
  const serverUrl = runtimeSession.manifest.cloudSync?.serverUrl
  if (!serverUrl) {
    throw new Error('Cloud sync server URL is not configured.')
  }

  const response = await fetch(`${serverUrl}${path}`, init)
  const payload = await parseJsonResponse(response)
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.message || `Cloud sync request failed (${response.status}).`)
  }

  return payload
}

/** 获取某个会话对应的云同步 worker 状态。 */
function getCloudSyncWorkerState(cloudSyncWorkers, sessionId) {
  if (!cloudSyncWorkers.has(sessionId)) {
    cloudSyncWorkers.set(sessionId, {
      running: false,
      timer: null
    })
  }

  return cloudSyncWorkers.get(sessionId)
}

/** 返回当前仍需上传的已封存分片。 */
function getPendingCloudSyncParts(runtimeSession) {
  return runtimeSession.manifest.segments
    .filter(
      (part) =>
        part.status === 'ready' &&
        existsSync(part.path) &&
        (part.uploadStatus === 'pending' || part.uploadStatus === 'failed')
    )
    .sort((left, right) => left.index - right.index)
}

/** 返回当前已就绪且本地文件存在的分片。 */
function getReadyCloudSyncParts(runtimeSession) {
  return runtimeSession.manifest.segments
    .filter((part) => part.status === 'ready' && existsSync(part.path))
    .sort((left, right) => left.index - right.index)
}

/** 返回当前已经上传成功的分片。 */
function getUploadedCloudSyncParts(runtimeSession) {
  return getReadyCloudSyncParts(runtimeSession).filter((part) => part.uploadStatus === 'uploaded')
}

/** 更新会话的云同步状态字段。 */
function setCloudSyncStatus(runtimeSession, status, extra = {}) {
  runtimeSession.manifest.cloudSync.status = status
  Object.assign(runtimeSession.manifest.cloudSync, extra)
}

function getCloudSyncRetryDelayMs(retryCount) {
  const normalizedRetryCount = Math.max(0, Number(retryCount || 0))
  return CLOUD_SYNC_RETRY_DELAYS_MS[
    Math.min(normalizedRetryCount, CLOUD_SYNC_RETRY_DELAYS_MS.length - 1)
  ]
}

/** 停止并清理某个会话的云同步 worker。 */
export function clearCloudSyncWorker(cloudSyncWorkers, sessionId) {
  const worker = cloudSyncWorkers.get(sessionId)
  if (!worker) {
    return
  }

  if (worker.timer) {
    clearTimeout(worker.timer)
  }

  cloudSyncWorkers.delete(sessionId)
}

/** 上传一个已完成的分片文件到云同步服务。 */
async function uploadCloudSyncPart(runtimeSession, part) {
  if (!runtimeSession.manifest.cloudSyncEnabled || !part?.path || !existsSync(part.path)) {
    return
  }

  if (part.uploadStatus === 'uploaded') {
    return
  }

  part.uploadStatus = 'uploading'
  setCloudSyncStatus(runtimeSession, 'syncing', {
    lastError: '',
    lastAttemptAt: Date.now(),
    nextRetryAt: null
  })
  await persistRecordingSessionState(runtimeSession)

  try {
    const checksum = await sha256File(part.path)
    const body = await readFile(part.path)
    const payload = await cloudSyncFetchJson(
      runtimeSession,
      `/api/cloud-sync/sessions/${encodeURIComponent(runtimeSession.id)}/parts/${part.index}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-checksum-sha256': checksum,
          'x-file-size': String(body.length)
        },
        body
      }
    )

    part.checksum = checksum
    part.etag = typeof payload.etag === 'string' ? payload.etag : checksum
    part.uploadStatus = 'uploaded'
    part.uploadedAt = Date.now()
    part.retryCount = Number(part.retryCount || 0)

    const hasRemainingPendingParts = getPendingCloudSyncParts(runtimeSession).length > 0
    setCloudSyncStatus(runtimeSession, hasRemainingPendingParts ? 'syncing' : 'pending', {
      lastError: '',
      lastAttemptAt: Date.now(),
      nextRetryAt: null
    })
    await persistRecordingSessionState(runtimeSession)
  } catch (error) {
    part.uploadStatus = 'failed'
    part.retryCount = Number(part.retryCount || 0) + 1
    setCloudSyncStatus(runtimeSession, 'failed', {
      lastError: error instanceof Error ? error.message : 'Failed to upload cloud sync part.',
      lastAttemptAt: Date.now(),
      nextRetryAt: Date.now() + getCloudSyncRetryDelayMs(part.retryCount)
    })
    await persistRecordingSessionState(runtimeSession)
    throw error
  }
}

/** 请求服务端把当前会话的所有已上传分片合并成远端成片。 */
async function mergeCloudSyncRecordingSession(cloudSyncWorkers, runtimeSession) {
  if (!runtimeSession.manifest.cloudSyncEnabled) {
    return false
  }

  const uploadedParts = getUploadedCloudSyncParts(runtimeSession)
  if (!uploadedParts.length) {
    return false
  }

  try {
    setCloudSyncStatus(runtimeSession, 'merging', {
      lastError: '',
      lastAttemptAt: Date.now(),
      nextRetryAt: null
    })
    await persistRecordingSessionState(runtimeSession)

    const payload = await cloudSyncFetchJson(
      runtimeSession,
      `/api/cloud-sync/sessions/${encodeURIComponent(runtimeSession.id)}/merge`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          extension: runtimeSession.manifest.extension,
          parts: uploadedParts.map((part) => ({
            index: Number(part.index || 0),
            checksum: part.checksum || ''
          }))
        })
      }
    )

    setCloudSyncStatus(runtimeSession, 'completed', {
      remoteVideoUrl: typeof payload.remoteVideoUrl === 'string' ? payload.remoteVideoUrl : '',
      completedAt: Date.now(),
      lastError: '',
      lastAttemptAt: Date.now(),
      nextRetryAt: null
    })
    await persistRecordingSessionState(runtimeSession)

    if (runtimeSession.manifest.output?.path && existsSync(runtimeSession.manifest.output.path)) {
      await writeRecordingMetadata(runtimeSession.manifest.output.path, {
        durationSec: Number(runtimeSession.manifest.output?.durationSec || 0) || null,
        cloudSync: buildCloudSyncMetadata(runtimeSession)
      })
    }

    await cleanupRecordingSessionArtifacts(runtimeSession)
    clearCloudSyncWorker(cloudSyncWorkers, runtimeSession.id)
    return true
  } catch (error) {
    setCloudSyncStatus(runtimeSession, 'failed', {
      lastError: error instanceof Error ? error.message : 'Failed to merge cloud sync session.',
      lastAttemptAt: Date.now(),
      nextRetryAt: Date.now() + getCloudSyncRetryDelayMs(0)
    })
    await persistRecordingSessionState(runtimeSession)
    return false
  }
}

/** 执行一次完整的云同步处理周期。 */
async function processCloudSyncSession(cloudSyncWorkers, runtimeSession) {
  if (!runtimeSession.manifest.cloudSyncEnabled) {
    clearCloudSyncWorker(cloudSyncWorkers, runtimeSession.id)
    return null
  }

  const pendingParts = getPendingCloudSyncParts(runtimeSession)
  for (const part of pendingParts) {
    try {
      await uploadCloudSyncPart(runtimeSession, part)
    } catch {
      return {
        retryDelayMs: getCloudSyncRetryDelayMs(part.retryCount)
      }
    }
  }

  const readyParts = getReadyCloudSyncParts(runtimeSession)
  const uploadedParts = getUploadedCloudSyncParts(runtimeSession)
  const allReadyPartsUploaded = readyParts.length > 0 && readyParts.length === uploadedParts.length

  if (
    runtimeSession.manifest.status !== 'recording' &&
    allReadyPartsUploaded &&
    ['pending', 'syncing', 'failed', 'merging'].includes(runtimeSession.manifest.cloudSync.status)
  ) {
    const merged = await mergeCloudSyncRecordingSession(cloudSyncWorkers, runtimeSession)
    if (!merged) {
      return {
        retryDelayMs: getCloudSyncRetryDelayMs(0)
      }
    }
    return null
  }

  if (runtimeSession.manifest.cloudSync.status === 'completed') {
    clearCloudSyncWorker(cloudSyncWorkers, runtimeSession.id)
    return null
  }

  return pendingParts.length > 0 ? { retryDelayMs: 500 } : { retryDelayMs: 5_000 }
}

/** 安排云同步 worker 在指定延迟后继续处理当前会话。 */
export function scheduleCloudSyncProcessing(cloudSyncWorkers, runtimeSession, delayMs = 0) {
  if (!runtimeSession?.manifest?.cloudSyncEnabled) {
    return
  }

  const worker = getCloudSyncWorkerState(cloudSyncWorkers, runtimeSession.id)
  if (worker.timer) {
    clearTimeout(worker.timer)
    worker.timer = null
  }

  worker.timer = setTimeout(
    async () => {
      if (worker.running) {
        scheduleCloudSyncProcessing(cloudSyncWorkers, runtimeSession, 1_000)
        return
      }

      worker.running = true
      worker.timer = null

      try {
        const result = await processCloudSyncSession(cloudSyncWorkers, runtimeSession)
        if (result?.retryDelayMs) {
          scheduleCloudSyncProcessing(cloudSyncWorkers, runtimeSession, result.retryDelayMs)
        }
      } catch (error) {
        setCloudSyncStatus(runtimeSession, 'failed', {
          lastError: error instanceof Error ? error.message : 'Cloud sync processing failed.',
          nextRetryAt: Date.now() + getCloudSyncRetryDelayMs(0)
        })
        await persistRecordingSessionState(runtimeSession).catch(() => {})
        scheduleCloudSyncProcessing(cloudSyncWorkers, runtimeSession, getCloudSyncRetryDelayMs(0))
      } finally {
        worker.running = false
      }
    },
    Math.max(0, Number(delayMs || 0))
  )
}

/** 在录屏停止后立即触发云同步收尾流程。 */
export function scheduleCloudSyncFinalize(cloudSyncWorkers, runtimeSession) {
  if (!runtimeSession.manifest.cloudSyncEnabled) {
    return
  }

  scheduleCloudSyncProcessing(cloudSyncWorkers, runtimeSession, 0)
}
