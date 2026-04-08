import { existsSync } from 'fs'
import { copyFile, mkdir, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import {
  createRecordingCaptureTempFileName,
  createRecordingFileName,
  getRecordingsDirectoryPath
} from './recordingPaths'

/** Builds helpers for local output finalization and temp-artifact cleanup. */
export function createRecordingFinalizerRuntime({
  persistRecordingSessionState,
  buildCloudSyncMetadata,
  listSessionArtifactPaths,
  deleteRecordingSessionFromDatabase,
  deleteCloudSessionFromDatabase,
  runFfmpeg,
  probeVideoDurationSec,
  buildRecordingItem,
  writeRecordingMetadata
}) {
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

  async function writeRecordingOutput(runtimeSession, outputFilePath) {
    const outputStat = await stat(outputFilePath)
    const durationSec = await probeVideoDurationSec(outputFilePath)
    runtimeSession.manifest.output = {
      path: outputFilePath,
      status: 'ready',
      bytes: Number(outputStat.size || 0),
      createdAt: Number(outputStat.birthtimeMs || outputStat.mtimeMs || Date.now()),
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null
    }
    await persistRecordingSessionState(runtimeSession)
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

      return await writeRecordingOutput(runtimeSession, outputFilePath)
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

    return await writeRecordingOutput(runtimeSession, outputFilePath)
  }

  return {
    cleanupRecordingSessionArtifacts,
    mergeRecordingSession
  }
}
