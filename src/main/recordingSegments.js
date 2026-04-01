import { createWriteStream } from 'fs'
import { rename } from 'fs/promises'
import { once } from 'node:events'
import { join } from 'path'
import { createRecordingSegmentFileName } from './recordingPaths'

export function createRecordingSegmentsRuntime({
  persistRecordingSessionManifest,
  scheduleCloudSyncProcessing,
  parseChunkPayloadToBuffer
}) {
  async function openRecordingSessionSegment(runtimeSession, index) {
    const fileName = createRecordingSegmentFileName(index, runtimeSession.manifest.extension)
    const partFileName = `${fileName}.part`
    const partPath = join(runtimeSession.dir, partFileName)
    const finalPath = join(runtimeSession.dir, fileName)
    const startedAt = Date.now()

    runtimeSession.writeStream = createWriteStream(partPath, { flags: 'w' })
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

    await persistRecordingSessionManifest(runtimeSession)
  }

  async function finalizeCurrentRecordingSessionSegment(runtimeSession) {
    const currentSegment = runtimeSession.currentSegment
    const currentWriteStream = runtimeSession.writeStream

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
    runtimeSession.writeStream = null
    if (runtimeSession.manifest.cloudSyncEnabled && segmentItem) {
      runtimeSession.manifest.cloudSync.totalSegments = runtimeSession.manifest.segments.length
    }
    await persistRecordingSessionManifest(runtimeSession)

    if (runtimeSession.manifest.cloudSyncEnabled && segmentItem) {
      scheduleCloudSyncProcessing(runtimeSession)
    }
  }

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

    const canContinue = stream.write(chunk)
    if (!canContinue) {
      await once(stream, 'drain')
    }

    currentSegment.bytes += chunk.length
    runtimeSession.manifest.totalBytes += chunk.length

    const segmentItem = runtimeSession.manifest.segments.find(
      (segment) => segment.index === currentSegment.index
    )
    if (segmentItem) {
      segmentItem.bytes = currentSegment.bytes
    }

    await persistRecordingSessionManifest(runtimeSession)

    return {
      ok: true,
      bytesWritten: chunk.length
    }
  }

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
