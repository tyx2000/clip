/** 文件作用：负责录屏结束后的本地合并输出和临时目录清理。 */
import { existsSync } from 'fs'
import { copyFile, mkdir, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import {
  createRecordingCaptureTempFileName,
  createRecordingFileName,
  getRecordingsDirectoryPath,
  listSessionArtifactPaths,
  probeVideoDurationSec,
  runFfmpeg
} from './mediaUtils'
import {
  buildCloudSyncMetadata,
  buildRecordingItem,
  deleteRecordingSessionFromDatabase,
  persistRecordingSessionState,
  writeRecordingMetadata
} from './recordingStorage'

/** 在最终输出文件落盘后回填 output 元数据并生成列表项。 */
async function writeRecordingOutput(runtimeSession, outputFilePath) {
  // 先读取最终文件的 stat，后面要把字节数和创建时间回填到 manifest/output。
  const outputStat = await stat(outputFilePath)
  // 再探测媒体时长；这里单独探测是为了避免只靠文件大小推断时长造成列表展示错误。
  const durationSec = await probeVideoDurationSec(outputFilePath)
  // output 字段是后续列表展示、播放器打开和云同步元数据写回的统一来源。
  runtimeSession.manifest.output = {
    path: outputFilePath,
    status: 'ready',
    bytes: Number(outputStat.size || 0),
    createdAt: Number(outputStat.birthtimeMs || outputStat.mtimeMs || Date.now()),
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null
  }
  // 先持久化会话状态，再写最终成片元数据，避免应用中途退出时数据库丢失 output 状态。
  await persistRecordingSessionState(runtimeSession)
  await writeRecordingMetadata(outputFilePath, {
    durationSec: runtimeSession.manifest.output.durationSec,
    cloudSync: buildCloudSyncMetadata(runtimeSession)
  })

  // 这里额外构造列表项，是为了 stop 后能直接把新成片返回给渲染层，避免再扫描目录一次。
  const item = await buildRecordingItem(outputFilePath, outputStat)
  return {
    item,
    outputPath: outputFilePath
  }
}

/** 删除一个会话目录及其数据库记录。 */
export async function cleanupRecordingSessionArtifacts(runtimeSession) {
  // 没有会话目录时直接返回，避免误删路径或在异常恢复链路里抛出无意义错误。
  if (!runtimeSession?.dir) {
    return
  }

  // 先关闭主写流，规避 macOS/Windows 下目录仍被占用导致 rm 失败的问题。
  if (runtimeSession.writeStream) {
    await new Promise((resolveCallback) => {
      runtimeSession.writeStream.end(() => resolveCallback())
    }).catch(() => {})
    runtimeSession.writeStream = null
  }

  // 云同步模式还有额外的 part 流，不关干净会留下 .part 文件句柄。
  if (runtimeSession.partWriteStream) {
    await new Promise((resolveCallback) => {
      runtimeSession.partWriteStream.end(() => resolveCallback())
    }).catch(() => {})
    runtimeSession.partWriteStream = null
  }

  // force + retry 用来对抗文件系统延迟释放句柄的场景，尤其是刚结束 ffmpeg 或流写入时。
  await rm(runtimeSession.dir, {
    recursive: true,
    force: true,
    maxRetries: 12,
    retryDelay: 300
  }).catch(() => {})

  if (existsSync(runtimeSession.dir)) {
    // 这里把残留项带进报错，目的是让问题定位到具体残留文件，而不是只看到笼统的清理失败。
    const remainingEntries = await listSessionArtifactPaths(runtimeSession.dir)
    const detail = remainingEntries.filter(Boolean).join(', ')
    throw new Error(
      detail
        ? `Failed to clean recording session artifacts: ${detail}`
        : 'Failed to clean recording session artifacts.'
    )
  }

  // 本地目录删干净后，再移除 SQLite 会话记录，避免数据库和磁盘状态不一致。
  deleteRecordingSessionFromDatabase(runtimeSession.id)
}

/** 把会话中的现有分段或连续录制文件合并成最终成片。 */
export async function mergeRecordingSession(runtimeSession) {
  /*
   * 输入事实：
   * - 录制结束后，真正落盘的输入可能是“一份连续文件”或“多份 ready segment”。
   * - 上层 stop / recover 都把 merge 视作“产出最终成片”的唯一出口。
   *
   * 状态目标：
   * - 把临时录制产物稳定转成最终成片。
   * - 让后续列表展示、播放器打开、元数据写回都只面对 output 文件。
   *
   * 风险点：
   * - 云同步模式和本地分段模式底层产物不同，不能混用同一套合并假设。
   * - 把中断段、缺失段当成有效输入，会得到损坏输出。
   *
   * 顺序约束：
   * - 先按录制模型选输入路径，再生成最终 output，再回填 output 元数据。
   *
   * 失败后果：
   * - 最终成片不存在、损坏，或者数据库已经记成 ready 但实际没有可播文件。
   */
  // 云同步模式并不是把分片再拼回本地，而是直接把连续录制文件转正为最终成片。
  if (runtimeSession.manifest.cloudSyncEnabled) {
    const captureTempPath =
      runtimeSession.captureTempPath ||
      join(
        runtimeSession.dir,
        createRecordingCaptureTempFileName(runtimeSession.manifest.extension)
      )

    if (!existsSync(captureTempPath)) {
      // 这里明确报错，是为了区分“没有分段可合并”和“连续录制临时文件丢失”两类问题。
      throw new Error('Continuous recording file is missing.')
    }

    // 最终输出路径统一落到 Recording 目录，避免会话临时目录被清理后成片也丢失。
    const outputFilePath = join(
      getRecordingsDirectoryPath(),
      createRecordingFileName(runtimeSession.manifest.extension)
    )
    await mkdir(dirname(outputFilePath), { recursive: true })
    // 这里用 rename 而不是 copy，目的是避免多一次大文件复制带来的额外 IO。
    await rename(captureTempPath, outputFilePath)
    runtimeSession.captureTempPath = ''

    return await writeRecordingOutput(runtimeSession, outputFilePath)
  }

  // 本地分段录制只合并 status=ready 的片段，避免把中断或缺失片段当成有效输入。
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

  // 单分段时直接 copy，避免不必要的 ffmpeg 调用和重编码。
  if (readySegments.length === 1) {
    await copyFile(readySegments[0].path, outputFilePath)
  } else {
    /*
     * 输入事实：
     * - 多段视频不是普通二进制块，不能靠应用层简单拼字节。
     *
     * 状态目标：
     * - 让输出文件在容器层面仍然合法、可播、可探测时长。
     *
     * 风险点：
     * - 裸拼字节通常会破坏索引和时间戳，得到“文件存在但播放器打不开”的坏结果。
     *
     * 顺序约束：
     * - 先生成 concat 列表，再交给 ffmpeg 按容器规则处理。
     *
     * 失败后果：
     * - 产出的是假成功文件：字节上写出来了，但媒体层面已经损坏。
     */
    // concat demuxer 需要一个显式输入列表文件，这里临时写到会话目录中，便于后续统一清理。
    const concatListPath = join(runtimeSession.dir, 'concat-inputs.txt')
    const concatListContent = readySegments
      // 路径里的单引号要手动转义，否则 ffmpeg concat 列表会解析失败。
      .map((segment) => `file '${segment.path.replaceAll("'", "'\\''")}'`)
      .join('\n')
    await writeFile(concatListPath, concatListContent, 'utf8')

    try {
      // 这里显式指定 vp9/yuv420p，是为了保证最终文件兼容性和可播放性更稳定。
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
      // 无论 ffmpeg 成功还是失败都清掉列表文件，避免污染会话目录并干扰后续清理。
      if (existsSync(concatListPath)) {
        await unlink(concatListPath).catch(() => {})
      }
    }
  }

  return await writeRecordingOutput(runtimeSession, outputFilePath)
}
