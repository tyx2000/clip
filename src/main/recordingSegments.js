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
} from './mediaUtils'
import { scheduleCloudSyncProcessing } from './cloudSyncRuntime'
import { persistRecordingSessionState } from './recordingStorage'

// 兼容多种渲染层 chunk 传输格式，避免前后端在序列化细节上强耦合。
// 如果这里返回 null，后续会明确拒绝写盘，防止损坏分段文件。
function parseChunkPayloadToBuffer(payload = {}) {
  if (Buffer.isBuffer(payload?.chunk)) {
    return payload.chunk
  }

  if (payload?.chunk instanceof Uint8Array) {
    return Buffer.from(payload.chunk)
  }

  if (payload?.chunk instanceof ArrayBuffer) {
    return Buffer.from(payload.chunk)
  }

  if (ArrayBuffer.isView(payload?.chunk)) {
    return Buffer.from(payload.chunk.buffer, payload.chunk.byteOffset, payload.chunk.byteLength)
  }

  if (typeof payload?.chunkBase64 === 'string' && payload.chunkBase64.trim()) {
    return Buffer.from(payload.chunkBase64, 'base64')
  }

  if (typeof payload?.dataUrl !== 'string') {
    return null
  }

  const matched = payload.dataUrl.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/)
  if (!matched) {
    return null
  }

  try {
    return Buffer.from(matched[2], 'base64')
  } catch {
    return null
  }
}

/** 打开当前会话的下一个可写目标文件。 */
export async function openRecordingSessionSegment(runtimeSession, index) {
  const fileName = runtimeSession.manifest.cloudSyncEnabled
    ? createCloudSyncPartFileName(index)
    : createRecordingSegmentFileName(index, runtimeSession.manifest.extension)
  // .part 后缀表示文件仍处于写入中，只有 finalize 成功后才会转正。
  const partFileName = `${fileName}.part`
  const partPath = join(runtimeSession.dir, partFileName)
  const finalPath = join(runtimeSession.dir, fileName)
  const startedAt = Date.now()

  if (runtimeSession.manifest.cloudSyncEnabled) {
    // 云同步模式同时维护“连续录制文件”和“当前上传分片”，两者用途不同。
    if (!runtimeSession.captureTempPath) {
      runtimeSession.captureTempPath = join(
        runtimeSession.dir,
        createRecordingCaptureTempFileName(runtimeSession.manifest.extension)
      )
    }

    if (!runtimeSession.writeStream) {
      // 连续录制文件必须追加写入，否则分片轮转后会覆盖掉已有内容。
      runtimeSession.writeStream = createWriteStream(runtimeSession.captureTempPath, {
        flags: 'a'
      })
    }

    // partWriteStream 只负责当前云同步分片，便于封段后立刻上传。
    runtimeSession.partWriteStream = createWriteStream(partPath, { flags: 'w' })
  } else {
    // 本地分段模式下只需要一个当前写流。
    runtimeSession.writeStream = createWriteStream(partPath, { flags: 'w' })
  }

  // currentSegment 是当前活动分段的唯一入口，append/finalize 都依赖它。
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

  // 分段一创建就持久化，目的是让异常退出时仍能恢复出“写到一半”的状态。
  await persistRecordingSessionState(runtimeSession)
}

/** 封存当前正在写入的分段或上传分片。 */
export async function finalizeCurrentRecordingSessionSegment(cloudSyncWorkers, runtimeSession) {
  const currentSegment = runtimeSession.currentSegment
  const currentWriteStream = runtimeSession.manifest.cloudSyncEnabled
    ? runtimeSession.partWriteStream
    : runtimeSession.writeStream

  /*
   * 输入事实：
   * - 当前分段还处于 writing，底层文件可能尚未 flush 完。
   * - 上层 stop / rotate / upload 都会把 finalize 后的结果当成正式可用分段。
   *
   * 状态目标：
   * - 把“临时写入段”安全地转成“正式 ready 段”。
   * - 让磁盘文件、manifest 状态、持久化快照三者保持一致。
   *
   * 风险点：
   * - 未 flush 就 rename，文件可能缺尾部数据。
   * - rename 成功但 manifest 还没改 ready，恢复时会误判。
   * - manifest 改 ready 但文件仍是 .part，也会让后续上传/合并建立在错输入上。
   *
   * 顺序约束：
   * - 必须先 end 流，再 rename，再改 manifest，再持久化。
   *
   * 失败后果：
   * - 半成品分段被错当成完整分段，后续 merge / upload 都会继续放大错误。
   */
  // 没有活动分段时直接返回，避免 stop/rotate 重入时报伪错误。
  if (!currentSegment || !currentWriteStream) {
    return
  }

  // 先结束写流，再 rename 成正式文件，避免文件系统仍占用句柄导致失败。
  await new Promise((resolveCallback, rejectCallback) => {
    currentWriteStream.end((error) => {
      if (error) {
        rejectCallback(error)
        return
      }
      resolveCallback()
    })
  })

  // rename 成正式文件后，这个分段才可以被视为 ready 并参与上传或合并。
  await rename(currentSegment.partPath, currentSegment.finalPath)

  const segmentItem = runtimeSession.manifest.segments.find(
    (segment) => segment.index === currentSegment.index
  )
  if (segmentItem) {
    // 这里把最终字节数和结束时间回填到 manifest，确保恢复时不只依赖内存态。
    segmentItem.bytes = currentSegment.bytes
    segmentItem.endedAt = Date.now()
    segmentItem.status = 'ready'
  }

  // 清空 currentSegment 后，后续追加写入会被显式拒绝，避免写到旧分段上。
  runtimeSession.currentSegment = null
  if (runtimeSession.manifest.cloudSyncEnabled) {
    runtimeSession.partWriteStream = null
  } else {
    runtimeSession.writeStream = null
  }
  await persistRecordingSessionState(runtimeSession)

  if (runtimeSession.manifest.cloudSyncEnabled && segmentItem) {
    // 云同步模式下分段一 ready 就调度上传，减少 stop 后集中等待的时间。
    scheduleCloudSyncProcessing(cloudSyncWorkers, runtimeSession)
  }
}

/** 把一个渲染进程 chunk 写入当前分段，必要时触发自动封段。 */
export async function appendRecordingSessionChunk(cloudSyncWorkers, runtimeSession, payload = {}) {
  if (!runtimeSession) {
    throw new Error('Recording session not found.')
  }

  if (runtimeSession.manifest.status !== 'recording') {
    throw new Error('Recording session is not writable.')
  }

  // 先校验 chunk 载荷，避免把空数据或坏数据写进当前分段。
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

  /*
   * 输入事实：
   * - 云同步模式下，同一份 chunk 同时服务两个目标：最终本地成片和边录边上传分片。
   * - 高帧率录制时 chunk 写入频率很高，背压问题会真实出现。
   *
   * 状态目标：
   * - 保证两个目标文件都收到同样的数据。
   * - 在高吞吐情况下仍保持可控内存占用。
   *
   * 风险点：
   * - 只写成功一个流会导致本地成片和上传分片内容不一致。
   * - 忽略背压会让内部缓冲持续膨胀，最终拖垮进程。
   *
   * 顺序约束：
   * - 必须逐个流写入，并在 write=false 时等待 drain，再继续后续逻辑。
   *
   * 失败后果：
   * - 可能得到“本地可播但云端坏掉”或“云端完整但本地缺数据”的难排查问题。
   */
  for (const targetStream of writeStreams) {
    if (!targetStream) {
      throw new Error('Recording segment is not available.')
    }

    // write 返回 false 时等待 drain，目的是控制高频录制时的内存背压。
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
    // 云同步分片按体积轮转，能降低单片上传失败后的重试成本。
    await finalizeCurrentRecordingSessionSegment(cloudSyncWorkers, runtimeSession)
    const nextIndex = runtimeSession.manifest.segments.length + 1
    await openRecordingSessionSegment(runtimeSession, nextIndex)
  }

  // 每次 append 后都持久化，是为了最大化崩溃恢复时的进度完整性。
  await persistRecordingSessionState(runtimeSession)

  return {
    ok: true,
    bytesWritten: chunk.length
  }
}

/** 显式轮转到下一段或下一片。 */
export async function rotateRecordingSessionSegment(cloudSyncWorkers, runtimeSession) {
  if (!runtimeSession) {
    throw new Error('Recording session not found.')
  }

  if (runtimeSession.manifest.status !== 'recording') {
    throw new Error('Recording session is not recording.')
  }

  // 显式轮转表示“结束当前段并立刻开启下一段”，不是停止整个录制会话。
  await finalizeCurrentRecordingSessionSegment(cloudSyncWorkers, runtimeSession)
  const nextIndex = runtimeSession.manifest.segments.length + 1
  await openRecordingSessionSegment(runtimeSession, nextIndex)

  return { ok: true }
}
