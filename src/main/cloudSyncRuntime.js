import { existsSync } from 'fs'
import { readFile } from 'fs/promises'

export function createCloudSyncRuntime({
  getCloudSyncRetryDelayMs,
  persistRecordingSessionManifest,
  buildCloudSyncMetadata,
  writeRecordingMetadata,
  cleanupRecordingSessionArtifacts,
  sha256File
}) {
  const cloudSyncWorkers = new Map()

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

  async function ensureCloudSyncRemoteSession(runtimeSession) {
    if (!runtimeSession.manifest.cloudSyncEnabled) {
      return
    }

    if (runtimeSession.manifest.cloudSync?.sessionCreated) {
      return
    }

    runtimeSession.manifest.cloudSync.sessionStatus = 'creating'
    runtimeSession.manifest.cloudSync.lastError = ''
    await persistRecordingSessionManifest(runtimeSession)

    try {
      await cloudSyncFetchJson(runtimeSession, '/api/cloud-sync/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sessionId: runtimeSession.id,
          mimeType: runtimeSession.manifest.mimeType,
          extension: runtimeSession.manifest.extension,
          segmentDurationMs: runtimeSession.manifest.segmentDurationMs,
          startedAt: runtimeSession.manifest.startedAt
        })
      })

      runtimeSession.manifest.cloudSync.sessionCreated = true
      runtimeSession.manifest.cloudSync.sessionStatus = 'created'
      runtimeSession.manifest.cloudSync.uploadStatus = 'pending'
      runtimeSession.manifest.cloudSync.lastError = ''
      await persistRecordingSessionManifest(runtimeSession)
    } catch (error) {
      runtimeSession.manifest.cloudSync.sessionStatus = 'failed'
      runtimeSession.manifest.cloudSync.lastError =
        error instanceof Error ? error.message : 'Failed to create cloud sync session.'
      await persistRecordingSessionManifest(runtimeSession)
      throw error
    }
  }

  function getCloudSyncWorkerState(sessionId) {
    if (!cloudSyncWorkers.has(sessionId)) {
      cloudSyncWorkers.set(sessionId, {
        running: false,
        timer: null
      })
    }

    return cloudSyncWorkers.get(sessionId)
  }

  function clearCloudSyncWorker(sessionId) {
    const worker = cloudSyncWorkers.get(sessionId)
    if (!worker) {
      return
    }

    if (worker.timer) {
      clearTimeout(worker.timer)
    }

    cloudSyncWorkers.delete(sessionId)
  }

  function getPendingCloudSyncSegments(runtimeSession) {
    return runtimeSession.manifest.segments
      .filter(
        (segment) =>
          segment.status === 'ready' &&
          existsSync(segment.path) &&
          segment.uploadStatus !== 'uploaded'
      )
      .sort((left, right) => left.index - right.index)
  }

  function updateCloudSyncStateFromRemote(runtimeSession, payload = {}) {
    if (!runtimeSession.manifest.cloudSyncEnabled) {
      return
    }

    runtimeSession.manifest.cloudSync.sessionCreated = true
    runtimeSession.manifest.cloudSync.sessionStatus = 'created'
    runtimeSession.manifest.cloudSync.uploadStatus =
      typeof payload.uploadStatus === 'string' && payload.uploadStatus
        ? payload.uploadStatus
        : runtimeSession.manifest.cloudSync.uploadStatus
    runtimeSession.manifest.cloudSync.mergeStatus =
      typeof payload.mergeStatus === 'string' && payload.mergeStatus
        ? payload.mergeStatus
        : runtimeSession.manifest.cloudSync.mergeStatus
    runtimeSession.manifest.cloudSync.uploadedSegments = Number(payload.uploadedSegments || 0)
    runtimeSession.manifest.cloudSync.totalSegments = Number(payload.totalSegments || 0)
    runtimeSession.manifest.cloudSync.remoteVideoUrl =
      typeof payload.remoteVideoUrl === 'string' ? payload.remoteVideoUrl : ''
    runtimeSession.manifest.cloudSync.remoteVideoPath =
      typeof payload.remoteVideoPath === 'string' ? payload.remoteVideoPath : ''
    runtimeSession.manifest.cloudSync.lastError =
      typeof payload.lastError === 'string' ? payload.lastError : ''
  }

  async function uploadRecordingSessionSegment(runtimeSession, segment) {
    if (!runtimeSession.manifest.cloudSyncEnabled || !segment?.path || !existsSync(segment.path)) {
      return
    }

    if (segment.uploadStatus === 'uploaded') {
      return
    }

    await ensureCloudSyncRemoteSession(runtimeSession)

    segment.uploadStatus = 'uploading'
    runtimeSession.manifest.cloudSync.uploadStatus = 'uploading'
    runtimeSession.manifest.cloudSync.lastError = ''
    runtimeSession.manifest.cloudSync.lastAttemptAt = Date.now()
    runtimeSession.manifest.cloudSync.nextRetryAt = null
    await persistRecordingSessionManifest(runtimeSession)

    try {
      const checksum = await sha256File(segment.path)
      const body = await readFile(segment.path)
      const payload = await cloudSyncFetchJson(
        runtimeSession,
        `/api/cloud-sync/sessions/${encodeURIComponent(runtimeSession.id)}/segments/${segment.index}`,
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

      segment.checksum = checksum
      segment.etag = typeof payload.etag === 'string' ? payload.etag : checksum
      segment.uploadStatus = 'uploaded'
      segment.uploadedAt = Date.now()
      segment.retryCount = Number(segment.retryCount || 0)
      runtimeSession.manifest.cloudSync.lastUploadedSegmentIndex = segment.index
      updateCloudSyncStateFromRemote(runtimeSession, {
        ...payload,
        uploadedSegments: runtimeSession.manifest.segments.filter(
          (item) => item.uploadStatus === 'uploaded'
        ).length,
        totalSegments: runtimeSession.manifest.segments.length
      })
      runtimeSession.manifest.cloudSync.lastAttemptAt = Date.now()
      runtimeSession.manifest.cloudSync.nextRetryAt = null
      await persistRecordingSessionManifest(runtimeSession)
    } catch (error) {
      segment.uploadStatus = 'failed'
      segment.retryCount = Number(segment.retryCount || 0) + 1
      runtimeSession.manifest.cloudSync.uploadStatus = 'failed'
      runtimeSession.manifest.cloudSync.lastError =
        error instanceof Error ? error.message : 'Failed to upload recording segment.'
      runtimeSession.manifest.cloudSync.lastAttemptAt = Date.now()
      runtimeSession.manifest.cloudSync.nextRetryAt =
        Date.now() + getCloudSyncRetryDelayMs(segment.retryCount)
      await persistRecordingSessionManifest(runtimeSession)
      throw error
    }
  }

  async function completeCloudSyncRecordingSession(runtimeSession) {
    if (!runtimeSession.manifest.cloudSyncEnabled) {
      return
    }

    try {
      runtimeSession.manifest.cloudSync.lastAttemptAt = Date.now()
      runtimeSession.manifest.cloudSync.nextRetryAt = null
      await persistRecordingSessionManifest(runtimeSession)
      await ensureCloudSyncRemoteSession(runtimeSession)
      const payload = await cloudSyncFetchJson(
        runtimeSession,
        `/api/cloud-sync/sessions/${encodeURIComponent(runtimeSession.id)}/complete`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            stoppedAt: runtimeSession.manifest.stoppedAt || Date.now(),
            segmentCount: runtimeSession.manifest.segments.filter(
              (segment) => segment.status === 'ready'
            ).length,
            totalBytes: runtimeSession.manifest.totalBytes
          })
        }
      )
      runtimeSession.manifest.cloudSync.completedAt = Date.now()
      updateCloudSyncStateFromRemote(runtimeSession, payload)
      runtimeSession.manifest.cloudSync.nextRetryAt = null
      await persistRecordingSessionManifest(runtimeSession)
      return true
    } catch (error) {
      runtimeSession.manifest.cloudSync.mergeStatus = 'merge_failed'
      runtimeSession.manifest.cloudSync.lastError =
        error instanceof Error ? error.message : 'Failed to complete cloud sync session.'
      runtimeSession.manifest.cloudSync.lastAttemptAt = Date.now()
      runtimeSession.manifest.cloudSync.nextRetryAt = Date.now() + getCloudSyncRetryDelayMs(0)
      await persistRecordingSessionManifest(runtimeSession)
      return false
    }
  }

  async function syncCloudRecordingSessionStatus(runtimeSession) {
    if (
      !runtimeSession.manifest.cloudSyncEnabled ||
      !runtimeSession.manifest.cloudSync?.sessionCreated
    ) {
      return false
    }

    try {
      runtimeSession.manifest.cloudSync.lastAttemptAt = Date.now()
      const payload = await cloudSyncFetchJson(
        runtimeSession,
        `/api/cloud-sync/sessions/${encodeURIComponent(runtimeSession.id)}`
      )
      updateCloudSyncStateFromRemote(runtimeSession, payload)
      runtimeSession.manifest.cloudSync.nextRetryAt = null
      await persistRecordingSessionManifest(runtimeSession)

      if (payload.mergeStatus === 'merged') {
        if (
          runtimeSession.manifest.output?.path &&
          existsSync(runtimeSession.manifest.output.path)
        ) {
          await writeRecordingMetadata(runtimeSession.manifest.output.path, {
            durationSec: Number(runtimeSession.manifest.output?.durationSec || 0) || null,
            cloudSync: buildCloudSyncMetadata(runtimeSession)
          })
        }
        await cleanupRecordingSessionArtifacts(runtimeSession)
        clearCloudSyncWorker(runtimeSession.id)
        return true
      }
    } catch (error) {
      runtimeSession.manifest.cloudSync.lastError =
        error instanceof Error ? error.message : 'Failed to refresh cloud sync status.'
      runtimeSession.manifest.cloudSync.nextRetryAt = Date.now() + getCloudSyncRetryDelayMs(0)
      await persistRecordingSessionManifest(runtimeSession)
    }

    return false
  }

  async function processCloudSyncSession(runtimeSession) {
    if (!runtimeSession.manifest.cloudSyncEnabled) {
      clearCloudSyncWorker(runtimeSession.id)
      return
    }

    const pendingSegments = getPendingCloudSyncSegments(runtimeSession)
    for (const segment of pendingSegments) {
      try {
        await uploadRecordingSessionSegment(runtimeSession, segment)
      } catch {
        return {
          retryDelayMs: getCloudSyncRetryDelayMs(segment.retryCount)
        }
      }
    }

    const allReadySegmentsUploaded = runtimeSession.manifest.segments
      .filter((segment) => segment.status === 'ready')
      .every((segment) => segment.uploadStatus === 'uploaded')

    if (
      runtimeSession.manifest.status === 'stopped' &&
      allReadySegmentsUploaded &&
      !runtimeSession.manifest.cloudSync.completedAt
    ) {
      const completed = await completeCloudSyncRecordingSession(runtimeSession)
      if (!completed) {
        return {
          retryDelayMs: getCloudSyncRetryDelayMs(0)
        }
      }
    }

    if (runtimeSession.manifest.cloudSync.completedAt) {
      const merged = await syncCloudRecordingSessionStatus(runtimeSession)
      if (!merged) {
        return {
          retryDelayMs: 5_000
        }
      }
    }

    return null
  }

  function scheduleCloudSyncProcessing(runtimeSession, delayMs = 0) {
    if (!runtimeSession?.manifest?.cloudSyncEnabled) {
      return
    }

    const worker = getCloudSyncWorkerState(runtimeSession.id)
    if (worker.timer) {
      clearTimeout(worker.timer)
      worker.timer = null
    }

    worker.timer = setTimeout(
      async () => {
        if (worker.running) {
          scheduleCloudSyncProcessing(runtimeSession, 1_000)
          return
        }

        worker.running = true
        worker.timer = null

        try {
          const result = await processCloudSyncSession(runtimeSession)
          if (result?.retryDelayMs) {
            scheduleCloudSyncProcessing(runtimeSession, result.retryDelayMs)
          } else if (runtimeSession.manifest.cloudSync.completedAt) {
            scheduleCloudSyncProcessing(runtimeSession, 5_000)
          }
        } catch (error) {
          runtimeSession.manifest.cloudSync.lastError =
            error instanceof Error ? error.message : 'Cloud sync processing failed.'
          runtimeSession.manifest.cloudSync.nextRetryAt = Date.now() + getCloudSyncRetryDelayMs(0)
          await persistRecordingSessionManifest(runtimeSession).catch(() => {})
          scheduleCloudSyncProcessing(runtimeSession, getCloudSyncRetryDelayMs(0))
        } finally {
          worker.running = false
        }
      },
      Math.max(0, Number(delayMs || 0))
    )
  }

  function scheduleCloudSyncFinalize(runtimeSession) {
    if (!runtimeSession.manifest.cloudSyncEnabled) {
      return
    }

    scheduleCloudSyncProcessing(runtimeSession)
  }

  return {
    clearCloudSyncWorker,
    scheduleCloudSyncProcessing,
    scheduleCloudSyncFinalize
  }
}
