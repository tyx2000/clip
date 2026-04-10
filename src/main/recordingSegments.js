/** 文件作用：负责录屏过程中的分段打开、写入、封段与轮转。 */
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

/** 打开当前会话的下一个可写目标文件。 */
export async function openRecordingSessionSegment(deps, runtimeSession, index) {
  const { persistRecordingSessionState } = deps
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

/** 封存当前正在写入的分段或上传分片。 */
export async function finalizeCurrentRecordingSessionSegment(deps, runtimeSession) {
  const { persistRecordingSessionState, scheduleCloudSyncProcessing } = deps
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

/** 把一个渲染进程 chunk 写入当前分段，必要时触发自动封段。 */
export async function appendRecordingSessionChunk(deps, runtimeSession, payload = {}) {
  const { persistRecordingSessionState, scheduleCloudSyncProcessing, parseChunkPayloadToBuffer } =
    deps

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
    await finalizeCurrentRecordingSessionSegment(
      { persistRecordingSessionState, scheduleCloudSyncProcessing },
      runtimeSession
    )
    const nextIndex = runtimeSession.manifest.segments.length + 1
    await openRecordingSessionSegment({ persistRecordingSessionState }, runtimeSession, nextIndex)
  }

  await persistRecordingSessionState(runtimeSession)

  return {
    ok: true,
    bytesWritten: chunk.length
  }
}

/** 显式轮转到下一段或下一片。 */
export async function rotateRecordingSessionSegment(deps, runtimeSession) {
  const { persistRecordingSessionState, scheduleCloudSyncProcessing } = deps

  if (!runtimeSession) {
    throw new Error('Recording session not found.')
  }

  if (runtimeSession.manifest.status !== 'recording') {
    throw new Error('Recording session is not recording.')
  }

  await finalizeCurrentRecordingSessionSegment(
    { persistRecordingSessionState, scheduleCloudSyncProcessing },
    runtimeSession
  )
  const nextIndex = runtimeSession.manifest.segments.length + 1
  await openRecordingSessionSegment({ persistRecordingSessionState }, runtimeSession, nextIndex)

  return { ok: true }
}
