import { createWriteStream } from 'fs'
import { rename } from 'fs/promises'
import { once } from 'node:events'
import { join } from 'path'
import {
  createCloudSyncPartFileName,
  createRecordingCaptureTempFileName,
  createRecordingSegmentFileName,
  DEFAULT_CLOUD_SYNC_PART_SIZE_BYTES
} from './recordingPaths'

/** Builds the low-level write runtime that appends chunks and seals disk-backed parts. */
export function createRecordingSegmentsRuntime({
  persistRecordingSessionState,
  scheduleCloudSyncProcessing,
  parseChunkPayloadToBuffer
}) {
  /** Opens the next writable target for the session.
   * Local sessions open one media segment file.
   * Cloud-sync sessions open the continuous local capture file plus one upload part file.
   *
   * @param {object} runtimeSession Active runtime session.
   * @param {number} index One-based segment or part index.
   */
  async function openRecordingSessionSegment(runtimeSession, index) {
    const fileName = runtimeSession.manifest.cloudSyncEnabled
      ? createCloudSyncPartFileName(index)
      : createRecordingSegmentFileName(index, runtimeSession.manifest.extension)
    const partFileName = `${fileName}.part`
    const partPath = join(runtimeSession.dir, partFileName)
    const finalPath = join(runtimeSession.dir, fileName)
    const startedAt = Date.now()

    if (runtimeSession.manifest.cloudSyncEnabled) {
      if (!runtimeSession.captureTempPath) {
        runtimeSession.captureTempPath = join(
          runtimeSession.dir,
          createRecordingCaptureTempFileName(runtimeSession.manifest.extension)
        )
      }

      if (!runtimeSession.writeStream) {
        runtimeSession.writeStream = createWriteStream(runtimeSession.captureTempPath, {
          flags: 'a'
        })
      }

      runtimeSession.partWriteStream = createWriteStream(partPath, { flags: 'w' })
    } else {
      runtimeSession.writeStream = createWriteStream(partPath, { flags: 'w' })
    }

    runtimeSession.currentSegment = {
      index,
      fileName,
      partFileName,
      partPath,
      finalPath,
      startedAt,
      bytes: 0
    }

    runtimeSession.manifest.segments.push({
      index,
      fileName,
      path: finalPath,
      startedAt,
      endedAt: null,
      bytes: 0,
      status: 'writing',
      uploadStatus: runtimeSession.manifest.cloudSyncEnabled ? 'pending' : 'disabled',
      checksum: '',
      etag: '',
      uploadedAt: null,
      retryCount: 0
    })

    await persistRecordingSessionState(runtimeSession)
  }

  /** Finalizes the currently open segment or upload part.
   * @param {object} runtimeSession Active runtime session.
   */
  async function finalizeCurrentRecordingSessionSegment(runtimeSession) {
    const currentSegment = runtimeSession.currentSegment
    const currentWriteStream = runtimeSession.manifest.cloudSyncEnabled
      ? runtimeSession.partWriteStream
      : runtimeSession.writeStream

    if (!currentSegment || !currentWriteStream) {
      return
    }

    await new Promise((resolveCallback, rejectCallback) => {
      currentWriteStream.end((error) => {
        if (error) {
          rejectCallback(error)
          return
        }
        resolveCallback()
      })
    })

    await rename(currentSegment.partPath, currentSegment.finalPath)

    const segmentItem = runtimeSession.manifest.segments.find(
      (segment) => segment.index === currentSegment.index
    )
    if (segmentItem) {
      segmentItem.bytes = currentSegment.bytes
      segmentItem.endedAt = Date.now()
      segmentItem.status = 'ready'
    }

    runtimeSession.currentSegment = null
    if (runtimeSession.manifest.cloudSyncEnabled) {
      runtimeSession.partWriteStream = null
    } else {
      runtimeSession.writeStream = null
    }
    await persistRecordingSessionState(runtimeSession)

    if (runtimeSession.manifest.cloudSyncEnabled && segmentItem) {
      scheduleCloudSyncProcessing(runtimeSession)
    }
  }

  /** Appends one renderer chunk into all required write targets.
   * For cloud sync, the same bytes are written to both the continuous local capture file
   * and the current upload part file.
   *
   * @param {object} runtimeSession Active runtime session.
   * @param {object} payload Chunk payload received from IPC.
   */
  async function appendRecordingSessionChunk(runtimeSession, payload = {}) {
    if (!runtimeSession) {
      throw new Error('Recording session not found.')
    }

    if (runtimeSession.manifest.status !== 'recording') {
      throw new Error('Recording session is not writable.')
    }

    const chunk = parseChunkPayloadToBuffer(payload)
    if (!chunk?.length) {
      throw new Error('Invalid recording chunk payload.')
    }

    const stream = runtimeSession.writeStream
    const currentSegment = runtimeSession.currentSegment
    if (!stream || !currentSegment) {
      throw new Error('Recording segment is not available.')
    }

    const writeStreams = runtimeSession.manifest.cloudSyncEnabled
      ? [runtimeSession.writeStream, runtimeSession.partWriteStream]
      : [runtimeSession.writeStream]

    for (const targetStream of writeStreams) {
      if (!targetStream) {
        throw new Error('Recording segment is not available.')
      }

      const canContinue = targetStream.write(chunk)
      if (!canContinue) {
        await once(targetStream, 'drain')
      }
    }

    currentSegment.bytes += chunk.length
    runtimeSession.manifest.totalBytes += chunk.length

    const segmentItem = runtimeSession.manifest.segments.find(
      (segment) => segment.index === currentSegment.index
    )
    if (segmentItem) {
      segmentItem.bytes = currentSegment.bytes
    }

    if (
      runtimeSession.manifest.cloudSyncEnabled &&
      currentSegment.bytes >= DEFAULT_CLOUD_SYNC_PART_SIZE_BYTES
    ) {
      await finalizeCurrentRecordingSessionSegment(runtimeSession)
      const nextIndex = runtimeSession.manifest.segments.length + 1
      await openRecordingSessionSegment(runtimeSession, nextIndex)
    }

    await persistRecordingSessionState(runtimeSession)

    return {
      ok: true,
      bytesWritten: chunk.length
    }
  }

  /** Explicitly rotates to the next segment/part.
   * @param {object} runtimeSession Active runtime session.
   */
  async function rotateRecordingSessionSegment(runtimeSession) {
    if (!runtimeSession) {
      throw new Error('Recording session not found.')
    }

    if (runtimeSession.manifest.status !== 'recording') {
      throw new Error('Recording session is not recording.')
    }

    await finalizeCurrentRecordingSessionSegment(runtimeSession)
    const nextIndex = runtimeSession.manifest.segments.length + 1
    await openRecordingSessionSegment(runtimeSession, nextIndex)

    return { ok: true }
  }

  return {
    openRecordingSessionSegment,
    finalizeCurrentRecordingSessionSegment,
    appendRecordingSessionChunk,
    rotateRecordingSessionSegment
  }
}
