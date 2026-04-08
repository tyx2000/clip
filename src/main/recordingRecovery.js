import { existsSync } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'
import { createRecordingCaptureTempFileName } from './recordingPaths'

/** Builds recovery helpers for merge, cleanup, and startup restoration. */
export function createRecordingRecoveryRuntime({
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
  cleanupRecordingSessionArtifacts,
  mergeRecordingSession
}) {
  /** Normalizes recovered rows so interrupted writes become deterministic runtime state.
   * @param {object} runtimeSession Session rebuilt from SQLite.
   */
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

  /** Decides whether a recovered session still needs local recovery work.
   * @param {object} runtimeSession Session rebuilt from SQLite.
   */
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

  /** Restores unfinished local sessions on app startup. */
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

        runtimeSession = createLocalRuntimeSessionFromDatabase(
          storedSession.sessionRow,
          storedSession.segmentRows,
          createRuntimeSession
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

  /** Requeues unfinished cloud-sync sessions on app startup. */
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

        const runtimeSession = await createCloudSyncRuntimeSessionFromDatabase(
          storedSession.sessionRow,
          storedSession.segmentRows,
          applyRecordingSessionStateDefaults,
          createCloudSyncState,
          createRuntimeSession
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

        scheduleCloudSyncProcessing(runtimeSession)
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

  return {
    cleanupRecordingSessionArtifacts,
    mergeRecordingSession,
    normalizeRecoveredRecordingSession,
    shouldRecoverRecordingSession,
    recoverPendingRecordingSessions,
    resumeAllCloudSyncSessions
  }
}
