import { existsSync } from 'fs'
import { readFile } from 'fs/promises'

/** Builds the background upload runtime for cloud-sync-enabled sessions. */
export function createCloudSyncRuntime({
  getCloudSyncRetryDelayMs,
  persistRecordingSessionState,
  buildCloudSyncMetadata,
  writeRecordingMetadata,
  cleanupRecordingSessionArtifacts,
  sha256File
}) {
  const cloudSyncWorkers = new Map()

  /** Parses a JSON HTTP response body into a plain object. */
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

  /** Sends one JSON request to the configured cloud-sync server.
   * @param {object} runtimeSession Cloud-sync-enabled runtime session.
   * @param {string} path Server-relative path.
   * @param {RequestInit} init Fetch init options.
   */
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

  /** Returns the timer/running state holder for one session worker. */
  function getCloudSyncWorkerState(sessionId) {
    if (!cloudSyncWorkers.has(sessionId)) {
      cloudSyncWorkers.set(sessionId, {
        running: false,
        timer: null
      })
    }

    return cloudSyncWorkers.get(sessionId)
  }

  /** Stops and removes the worker state for one cloud-sync session. */
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

  /** Returns parts that are sealed on disk and still need upload.
   * @param {object} runtimeSession Cloud-sync-enabled runtime session.
   */
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

  function getReadyCloudSyncParts(runtimeSession) {
    return runtimeSession.manifest.segments
      .filter((part) => part.status === 'ready' && existsSync(part.path))
      .sort((left, right) => left.index - right.index)
  }

  function getUploadedCloudSyncParts(runtimeSession) {
    return getReadyCloudSyncParts(runtimeSession).filter((part) => part.uploadStatus === 'uploaded')
  }

  function setCloudSyncStatus(runtimeSession, status, extra = {}) {
    runtimeSession.manifest.cloudSync.status = status
    Object.assign(runtimeSession.manifest.cloudSync, extra)
  }

  /** Uploads one completed part file to the server.
   * @param {object} runtimeSession Cloud-sync-enabled runtime session.
   * @param {object} part Ready part descriptor from the session state.
   */
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

  /** Requests the server to merge all uploaded parts for one session. */
  async function mergeCloudSyncRecordingSession(runtimeSession) {
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
      clearCloudSyncWorker(runtimeSession.id)
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

  /** Runs one upload/merge cycle for a cloud-sync session. */
  async function processCloudSyncSession(runtimeSession) {
    if (!runtimeSession.manifest.cloudSyncEnabled) {
      clearCloudSyncWorker(runtimeSession.id)
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
    const allReadyPartsUploaded =
      readyParts.length > 0 && readyParts.length === uploadedParts.length

    if (
      runtimeSession.manifest.status !== 'recording' &&
      allReadyPartsUploaded &&
      ['pending', 'syncing', 'failed', 'merging'].includes(runtimeSession.manifest.cloudSync.status)
    ) {
      const merged = await mergeCloudSyncRecordingSession(runtimeSession)
      if (!merged) {
        return {
          retryDelayMs: getCloudSyncRetryDelayMs(0)
        }
      }
      return null
    }

    if (runtimeSession.manifest.cloudSync.status === 'completed') {
      clearCloudSyncWorker(runtimeSession.id)
      return null
    }

    return pendingParts.length > 0
      ? {
          retryDelayMs: 500
        }
      : {
          retryDelayMs: 5_000
        }
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
          }
        } catch (error) {
          setCloudSyncStatus(runtimeSession, 'failed', {
            lastError: error instanceof Error ? error.message : 'Cloud sync processing failed.',
            nextRetryAt: Date.now() + getCloudSyncRetryDelayMs(0)
          })
          await persistRecordingSessionState(runtimeSession).catch(() => {})
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

    scheduleCloudSyncProcessing(runtimeSession, 0)
  }

  return {
    clearCloudSyncWorker,
    scheduleCloudSyncProcessing,
    scheduleCloudSyncFinalize
  }
}
