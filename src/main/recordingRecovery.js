import { existsSync } from 'fs'
import { copyFile, mkdir, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import {
  createRecordingCaptureTempFileName,
  createRecordingFileName,
  getRecordingsDirectoryPath
} from './recordingPaths'

/** Builds recovery helpers for merge, cleanup, and startup restoration. */
export function createRecordingRecoveryRuntime({
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
}) {
  /** Removes one session's temp directory after local/cloud completion.
   * @param {object} runtimeSession Runtime session whose artifacts should be removed.
   */
  async function cleanupRecordingSessionArtifacts(runtimeSession) {
    if (!runtimeSession?.dir) {
      return
    }

    if (runtimeSession.writeStream) {
      await new Promise((resolveCallback) => {
        runtimeSession.writeStream.end(() => resolveCallback())
      }).catch(() => {})
      runtimeSession.writeStream = null
    }

    if (runtimeSession.partWriteStream) {
      await new Promise((resolveCallback) => {
        runtimeSession.partWriteStream.end(() => resolveCallback())
      }).catch(() => {})
      runtimeSession.partWriteStream = null
    }

    await rm(runtimeSession.dir, {
      recursive: true,
      force: true,
      maxRetries: 12,
      retryDelay: 300
    }).catch(() => {})

    if (existsSync(runtimeSession.dir)) {
      const remainingEntries = await listSessionArtifactPaths(runtimeSession.dir)
      const detail = remainingEntries.filter(Boolean).join(', ')
      throw new Error(
        detail
          ? `Failed to clean recording session artifacts: ${detail}`
          : 'Failed to clean recording session artifacts.'
      )
    }

    deleteRecordingSessionFromDatabase(runtimeSession.id)
    deleteCloudSessionFromDatabase(runtimeSession.id)
  }

  /** Produces the final local output for one session.
   * Cloud-sync sessions rename the continuous capture file.
   * Local-only sessions merge ready media segments into one output file.
   *
   * @param {object} runtimeSession Runtime session to finalize locally.
   */
  async function mergeRecordingSession(runtimeSession) {
    if (runtimeSession.manifest.cloudSyncEnabled) {
      const captureTempPath =
        runtimeSession.captureTempPath ||
        join(
          runtimeSession.dir,
          createRecordingCaptureTempFileName(runtimeSession.manifest.extension)
        )

      if (!existsSync(captureTempPath)) {
        throw new Error('Continuous recording file is missing.')
      }

      const outputFilePath = join(
        getRecordingsDirectoryPath(),
        createRecordingFileName(runtimeSession.manifest.extension)
      )
      await mkdir(dirname(outputFilePath), { recursive: true })
      await rename(captureTempPath, outputFilePath)
      runtimeSession.captureTempPath = ''

      const outputStat = await stat(outputFilePath)
      const durationSec = await probeVideoDurationSec(outputFilePath)
      runtimeSession.manifest.output = {
        path: outputFilePath,
        status: 'ready',
        bytes: Number(outputStat.size || 0),
        createdAt: Number(outputStat.birthtimeMs || outputStat.mtimeMs || Date.now()),
        durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null
      }
      await persistRecordingSessionManifest(runtimeSession)
      await writeRecordingMetadata(outputFilePath, {
        durationSec: runtimeSession.manifest.output.durationSec,
        cloudSync: buildCloudSyncMetadata(runtimeSession)
      })

      const item = await buildRecordingItem(outputFilePath, outputStat)
      return {
        item,
        outputPath: outputFilePath
      }
    }

    const readySegments = runtimeSession.manifest.segments.filter(
      (segment) => segment.status === 'ready'
    )
    if (!readySegments.length) {
      throw new Error('No completed recording segments available for merge.')
    }

    const outputFilePath = join(
      getRecordingsDirectoryPath(),
      createRecordingFileName(runtimeSession.manifest.extension)
    )
    await mkdir(dirname(outputFilePath), { recursive: true })

    if (readySegments.length === 1) {
      await copyFile(readySegments[0].path, outputFilePath)
    } else {
      const concatListPath = join(runtimeSession.dir, 'concat-inputs.txt')
      const concatListContent = readySegments
        .map((segment) => `file '${segment.path.replaceAll("'", "'\\''")}'`)
        .join('\n')
      await writeFile(concatListPath, concatListContent, 'utf8')

      try {
        await runFfmpeg([
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          concatListPath,
          '-an',
          '-c:v',
          'libvpx-vp9',
          '-pix_fmt',
          'yuv420p',
          '-row-mt',
          '1',
          '-deadline',
          'realtime',
          '-cpu-used',
          '4',
          outputFilePath
        ])
      } finally {
        if (existsSync(concatListPath)) {
          await unlink(concatListPath).catch(() => {})
        }
      }
    }

    const outputStat = await stat(outputFilePath)
    const durationSec = await probeVideoDurationSec(outputFilePath)
    runtimeSession.manifest.output = {
      path: outputFilePath,
      status: 'ready',
      bytes: Number(outputStat.size || 0),
      createdAt: Number(outputStat.birthtimeMs || outputStat.mtimeMs || Date.now()),
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null
    }
    await persistRecordingSessionManifest(runtimeSession)
    await writeRecordingMetadata(outputFilePath, {
      durationSec: runtimeSession.manifest.output.durationSec,
      cloudSync: buildCloudSyncMetadata(runtimeSession)
    })

    const item = await buildRecordingItem(outputFilePath, outputStat)

    return {
      item,
      outputPath: outputFilePath
    }
  }

  /** Normalizes recovered rows so interrupted writes become deterministic runtime state.
   * @param {object} runtimeSession Session rebuilt from SQLite.
   */
  async function normalizeRecoveredRecordingSession(runtimeSession) {
    let manifestChanged = false
    const now = Date.now()

    runtimeSession.manifest = applyRecordingSessionManifestDefaults(runtimeSession.manifest)

    for (const segment of runtimeSession.manifest.segments) {
      const normalizedSyncState = normalizeSegmentCloudSyncState(segment)
      if (
        segment.uploadStatus !== normalizedSyncState.uploadStatus ||
        segment.checksum !== normalizedSyncState.checksum ||
        segment.etag !== normalizedSyncState.etag ||
        segment.uploadedAt !== normalizedSyncState.uploadedAt
      ) {
        Object.assign(segment, normalizedSyncState)
        manifestChanged = true
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
        manifestChanged = true
        continue
      }

      const partialPath = `${segment.path}.part`
      if (existsSync(partialPath)) {
        const fileStat = await stat(partialPath)
        segment.status = 'interrupted'
        segment.bytes = Number(fileStat.size || segment.bytes || 0)
        segment.endedAt = Number(fileStat.mtimeMs || now)
        segment.partialPath = partialPath
        manifestChanged = true
        continue
      }

      segment.status = 'missing'
      segment.endedAt = Number(segment.endedAt || now)
      manifestChanged = true
    }

    if (runtimeSession.manifest.status === 'recording') {
      runtimeSession.manifest.status = 'interrupted'
      runtimeSession.manifest.stoppedAt = runtimeSession.manifest.stoppedAt || now
      manifestChanged = true
    }

    if (runtimeSession.manifest.cloudSyncEnabled) {
      runtimeSession.manifest.cloudSync.totalParts = runtimeSession.manifest.segments.length
      runtimeSession.manifest.cloudSync.uploadedParts = runtimeSession.manifest.segments.filter(
        (segment) => segment.uploadStatus === 'uploaded'
      ).length
      manifestChanged = true
    }

    if (manifestChanged) {
      await persistRecordingSessionManifest(runtimeSession)
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
          await persistRecordingSessionManifest(runtimeSession).catch(() => {})
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
    const sessionRows = listCloudSyncSessionRowsFromDatabase()
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
          applyRecordingSessionManifestDefaults,
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
