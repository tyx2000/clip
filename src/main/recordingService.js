/** 文件作用：录屏主业务编排层，统一协调分段写盘、状态持久化、收尾和云同步。 */
import { existsSync } from 'fs'
import { mkdir, stat } from 'fs/promises'
import { join } from 'path'
import * as cloudSyncRuntime from './cloudSyncRuntime'
import {
  DEFAULT_CLOUD_SYNC_SERVER_URL,
  DEFAULT_SEGMENT_DURATION_MS,
  MIN_SEGMENT_DURATION_MS,
  createRecordingSessionId,
  getRecordingSessionsDirectoryPath,
  getVideoExtensionFromMimeType
} from './mediaUtils'
import * as recordingFinalizer from './recordingFinalizer'
import {
  assertRecordingStorageWritable,
  createRuntimeSessionFromDatabase,
  createRecordingSessionState,
  getRecordingSessionStatus,
  listCloudSyncSessionRowsFromDatabase,
  listLocalRecordingSessionRowsFromDatabase,
  persistRecordingSessionState,
  readCloudSyncSessionRowsFromDatabase,
  readRecordingSessionRowsFromDatabase
} from './recordingStorage'
import * as recordingSegments from './recordingSegments'

// 当前进程只允许一个活动录屏任务，所以这里直接用单个 runtimeSession 而不是 Map。
let activeRecordingSession = null
// 云同步 worker 仍然保留 Map，因为历史恢复时可能同时处理多个待上传会话。
const cloudSyncWorkers = new Map()

/** 归一化从数据库恢复出来的会话状态，修正中断写入和上传状态。 */
async function normalizeRecoveredRecordingSession(runtimeSession) {
  let sessionStateChanged = false
  // 用统一的 now 避免同一次恢复流程里出现多处时间戳不一致。
  const now = Date.now()

  /*
   * 输入事实：
   * - SQLite 中保存的是上次持久化时刻的 manifest / segment 快照。
   * - 进程退出可能发生在 rename、flush、upload、persist 的任意间隙。
   * - 因此数据库、磁盘文件、真实执行阶段三者可能不一致。
   *
   * 状态目标：
   * - 把“崩溃前快照”修正成“当前进程可继续恢复/上传/清理的安全状态”。
   * - 让后续逻辑面对的是完整 manifest，而不是半缺省、半过时的对象。
   *
   * 风险点：
   * - writing/uploading 这类进行中状态在重启后天然失真。
   * - session 级 cloudSync.status 可能和 part 级状态矛盾。
   * - 正式文件和 .part 文件的存在性，可能与数据库记录不一致。
   *
   * 顺序约束：
   * - 先补结构，再按 segment 粒度修正文件/上传状态，最后再推导 session 级状态。
   * - 如果顺序反过来，session 级结论会建立在脏 segment 状态上。
   *
   * 失败后果：
   * - 轻则恢复结果错误，比如本可继续上传的 part 被当成 missing。
   * - 重则后续 merge / upload / cleanup 都建立在错误状态机上，产生连锁问题。
   */
  // cloudSyncEnabled 和 serverUrl 都要在恢复时重新规整，避免数据库里残留旧值或空值。
  const cloudSyncEnabled = !!runtimeSession.manifest?.cloudSyncEnabled
  const cloudSyncServerUrlCandidate =
    typeof runtimeSession.manifest?.cloudSync?.serverUrl === 'string' &&
    runtimeSession.manifest.cloudSync.serverUrl.trim()
      ? runtimeSession.manifest.cloudSync.serverUrl.trim()
      : process.env.CLOUD_SYNC_SERVER_URL || DEFAULT_CLOUD_SYNC_SERVER_URL

  // 这一段先把 manifest 的基础结构补齐，目的是让后续恢复逻辑面对的是完整对象而不是半缺省状态。
  runtimeSession.manifest = {
    ...runtimeSession.manifest,
    version: 2,
    cloudSyncEnabled,
    cloudSync: {
      enabled: cloudSyncEnabled,
      serverUrl: cloudSyncEnabled ? cloudSyncServerUrlCandidate.replace(/\/+$/, '') : '',
      status: cloudSyncEnabled ? 'pending' : 'disabled',
      remoteVideoUrl: '',
      lastError: '',
      completedAt: null,
      lastAttemptAt: null,
      nextRetryAt: null,
      ...(runtimeSession.manifest?.cloudSync &&
      typeof runtimeSession.manifest.cloudSync === 'object'
        ? runtimeSession.manifest.cloudSync
        : {})
    },
    segments: Array.isArray(runtimeSession.manifest?.segments)
      ? runtimeSession.manifest.segments.map((segment) => ({
          ...segment,
          uploadStatus:
            typeof segment?.uploadStatus === 'string' && segment.uploadStatus
              ? segment.uploadStatus
              : 'pending',
          checksum: typeof segment?.checksum === 'string' ? segment.checksum : '',
          etag: typeof segment?.etag === 'string' ? segment.etag : '',
          uploadedAt: Number(segment?.uploadedAt || 0) || null,
          retryCount: Number(segment?.retryCount || 0)
        }))
      : []
  }

  // 然后逐段修正上传状态、文件状态和时间字节信息，尽量把“中断态”恢复成可继续处理的状态。
  for (const segment of runtimeSession.manifest.segments) {
    const normalizedSyncState = {
      uploadStatus:
        typeof segment?.uploadStatus === 'string' && segment.uploadStatus
          ? segment.uploadStatus
          : 'pending',
      checksum: typeof segment?.checksum === 'string' ? segment.checksum : '',
      etag: typeof segment?.etag === 'string' ? segment.etag : '',
      uploadedAt: Number(segment?.uploadedAt || 0) || null,
      retryCount: Number(segment?.retryCount || 0)
    }
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
      // 进程重启后不可能真的还处于 uploading，所以统一回退成 pending 以便重试。
      segment.uploadStatus = 'pending'
      sessionStateChanged = true
    }

    if (segment?.status === 'ready' && existsSync(segment.path)) {
      // ready 且文件仍在时，只补字节和 endedAt，不改变业务状态。
      const fileStat = await stat(segment.path)
      segment.bytes = Number(fileStat.size || segment.bytes || 0)
      segment.endedAt = Number(segment.endedAt || fileStat.mtimeMs || now)
      continue
    }

    if (
      runtimeSession.manifest.cloudSyncEnabled &&
      segment?.status === 'ready' &&
      segment.uploadStatus === 'uploaded' &&
      typeof segment.checksum === 'string' &&
      segment.checksum
    ) {
      // 已上传且有 checksum 的分片可能已被本地回收，仍可用于远端 merge。
      continue
    }

    if (segment?.status !== 'writing') {
      continue
    }

    if (existsSync(segment.path)) {
      // writing 但正式文件已存在，说明上次可能在 rename 之后异常退出，这里补正成 ready。
      const fileStat = await stat(segment.path)
      segment.status = 'ready'
      segment.bytes = Number(fileStat.size || 0)
      segment.endedAt = Number(fileStat.mtimeMs || now)
      sessionStateChanged = true
      continue
    }

    const partialPath = `${segment.path}.part`
    if (existsSync(partialPath)) {
      // .part 文件还在说明分段没封完，只能标记为 interrupted，等待后续恢复或清理。
      const fileStat = await stat(partialPath)
      segment.status = 'interrupted'
      segment.bytes = Number(fileStat.size || segment.bytes || 0)
      segment.endedAt = Number(fileStat.mtimeMs || now)
      segment.partialPath = partialPath
      sessionStateChanged = true
      continue
    }

    // 正式文件和 part 文件都不在时，标记 missing，避免后续把这个分段继续当作可上传内容。
    segment.status = 'missing'
    segment.endedAt = Number(segment.endedAt || now)
    sessionStateChanged = true
  }

  if (runtimeSession.manifest.status === 'recording') {
    // 应用重启后不可能仍处于 recording，所以恢复态统一改成 interrupted。
    runtimeSession.manifest.status = 'interrupted'
    runtimeSession.manifest.stoppedAt = runtimeSession.manifest.stoppedAt || now
    sessionStateChanged = true
  }

  if (runtimeSession.manifest.cloudSyncEnabled) {
    // 云同步整体状态由分段真实状态反推，避免 session 级状态和 part 级状态不一致。
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
    // 只有状态确实被修正时才刷库，避免启动恢复阶段造成无意义写入。
    await persistRecordingSessionState(runtimeSession)
  }
}

/** 判断某个恢复态会话是否仍需要继续本地恢复。 */
function shouldRecoverRecordingSession(runtimeSession) {
  const outputPath = runtimeSession.manifest.output?.path || ''
  const outputReady =
    runtimeSession.manifest.output?.status === 'ready' && outputPath && existsSync(outputPath)
  if (outputReady) {
    // 成片已经准备好时，不再走本地恢复流程，避免重复合并。
    return false
  }

  // 本地恢复只处理仍有本地文件的 ready 分片；已上传并回收的分片交给云同步恢复。
  return runtimeSession.manifest.segments.some(
    (segment) => segment.status === 'ready' && existsSync(segment.path)
  )
}

/** 启动时扫描并恢复未完成的本地录屏会话。 */
export async function recoverPendingRecordingSessions() {
  /*
   * 输入事实：
   * - 启动时数据库里可能残留一批未完成的本地录屏会话。
   * - 这些会话可能已经有成片、可能只剩 ready segment、也可能已经没有可恢复输入。
   *
   * 状态目标：
   * - 尽可能把仍可恢复的本地会话补做成片。
   * - 把已经完成或已无价值的会话从“待恢复”集合中剔除。
   *
   * 风险点：
   * - 把已完成会话再次 merge 会生成重复成片。
   * - 把没有有效输入的空会话当成失败，会污染恢复日志和状态。
   *
   * 顺序约束：
   * - 先读库恢复 runtime，再归一化状态，再判断是否值得恢复，最后才 merge/cleanup。
   *
   * 失败后果：
   * - 启动恢复会生成重复文件，或把本可恢复的历史会话留在错误状态里。
   */
  // summary 直接给启动日志用，便于判断恢复链路有没有工作、失败了多少。
  const summary = {
    scanned: 0,
    recovered: 0,
    skipped: 0,
    failed: 0
  }

  const sessionRows = listLocalRecordingSessionRowsFromDatabase()
  for (const sessionRow of sessionRows) {
    summary.scanned += 1
    // runtimeSession 放到外层是为了 catch 分支里还能把失败状态写回数据库。
    let runtimeSession = null

    try {
      const storedSession = readRecordingSessionRowsFromDatabase(sessionRow.sessionId)
      if (!storedSession) {
        summary.skipped += 1
        continue
      }

      runtimeSession = createRuntimeSessionFromDatabase(
        storedSession.sessionRow,
        storedSession.segmentRows
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
        // 成片已存在时只做临时目录清理，不再重复合并。
        await recordingFinalizer.cleanupRecordingSessionArtifacts(runtimeSession)
        summary.skipped += 1
        continue
      }

      if (!shouldRecoverRecordingSession(runtimeSession)) {
        // 没有任何可恢复内容时直接跳过，避免把空会话当成失败。
        summary.skipped += 1
        continue
      }

      // 本地恢复的核心目标是把 ready 片段重新产生成片。
      await recordingFinalizer.mergeRecordingSession(runtimeSession)
      try {
        // 合并成功后尽量把临时目录也清掉，但清理失败不该吞掉已成功恢复的结果。
        await recordingFinalizer.cleanupRecordingSessionArtifacts(runtimeSession)
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
        // 失败时显式把 output 标成 failed，方便前端或日志区分“未恢复”和“恢复失败”。
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

/** 启动时把待继续的云同步会话重新加入处理队列。 */
export async function resumeAllCloudSyncSessions() {
  /*
   * 输入事实：
   * - 启动时数据库里可能残留 pending/syncing/merging/failed 的云同步会话。
   * - 这些会话既可能已经有本地 output，也可能还需要先补做本地 merge。
   *
   * 状态目标：
   * - 把仍应继续的云同步会话重新挂回后台调度队列。
   * - 让重启后的行为尽量接近“上传在后台自动续传”。
   *
   * 风险点：
   * - 直接恢复上传但本地 output 尚未生成，最终 metadata 会不完整。
   * - 把不再有效的会话继续塞回调度队列，会导致无意义重试。
   *
   * 顺序约束：
   * - 先恢复 runtime、再归一化、必要时先补本地 merge、最后再 schedule cloud sync。
   *
   * 失败后果：
   * - 重启后云同步不会继续，或继续在错误前提下运行。
   */
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

      const runtimeSession = createRuntimeSessionFromDatabase(
        storedSession.sessionRow,
        storedSession.segmentRows
      )
      if (!runtimeSession?.manifest?.cloudSyncEnabled) {
        continue
      }

      await normalizeRecoveredRecordingSession(runtimeSession)
      const outputPath = runtimeSession.manifest.output?.path || ''
      const outputReady =
        runtimeSession.manifest.output?.status === 'ready' && outputPath && existsSync(outputPath)

      if (!outputReady && shouldRecoverRecordingSession(runtimeSession)) {
        // 云同步恢复前如果本地成片还没生成，先补做本地合并，保证 metadata 完整。
        await recordingFinalizer.mergeRecordingSession(runtimeSession)
      }

      // 然后再把会话重新挂回云同步调度队列。
      cloudSyncRuntime.scheduleCloudSyncProcessing(cloudSyncWorkers, runtimeSession)
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

/** 根据会话 id 获取当前仍在内存中的活动会话。 */
export function getActiveRecordingSession(sessionId) {
  /*
   * 输入事实：
   * - 当前进程只维护一个 activeRecordingSession。
   * - 外层 IPC 仍按 sessionId 调用，不能假设调用方总是可信。
   *
   * 状态目标：
   * - 只在 sessionId 精确命中当前活动会话时返回内存态对象。
   *
   * 风险点：
   * - 如果这里做成“有 active 就直接返回”，历史 sessionId 会误命中当前会话。
   *
   * 顺序约束：
   * - 先规范化 sessionId，再判断 active 是否存在，最后做精确匹配。
   *
   * 失败后果：
   * - IPC 层会把错误会话继续往下传，导致 chunk/stop/rotate 打到错误目标。
   */
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!activeRecordingSession || !normalizedSessionId) {
    return null
  }
  // 只有 sessionId 精确命中当前活动会话才返回，防止历史会话误被当成活跃会话。
  return activeRecordingSession.id === normalizedSessionId ? activeRecordingSession : null
}

/** 通过 Promise 队列串行化同一会话的磁盘写操作。 */
async function enqueueRecordingSessionTask(runtimeSession, task) {
  // 录屏 chunk、rotate、stop 都可能高频到达；串行化是为了避免并发写盘破坏分段状态。
  runtimeSession.writeQueue = runtimeSession.writeQueue.then(task, task)
  return runtimeSession.writeQueue
}

/** 创建一个新的录屏会话并打开首个分段。 */
export async function createRecordingSession(payload = {}) {
  /*
   * 输入事实：
   * - 当前进程只允许一个活动录屏任务。
   * - renderer 在会话创建成功后很快就会开始推 chunk。
   *
   * 状态目标：
   * - 创建一份完整 runtimeSession。
   * - 准备好首段写流，让后续 chunk 可以立即安全落盘。
   *
   * 风险点：
   * - 会话目录撞名会覆盖旧残留。
   * - active 状态如果在初始化失败后不回滚，会把后续新任务全部卡死。
   * - 首段未打开就开始接收 chunk，会直接进入“找不到可写分段”的错误路径。
   *
   * 顺序约束：
   * - 先验证单任务约束和目录安全，再创建 manifest/runtime，再打开首段，最后才暴露给外层。
   *
   * 失败后果：
   * - 新会话创建一半就留下脏目录或脏 active 状态，后续必须人工清理。
   */
  const sessionIdInput = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
  const sessionId = sessionIdInput || createRecordingSessionId()
  if (activeRecordingSession) {
    // 单任务约束在这里硬拦住，避免两个录屏任务同时竞争同一套模块级状态。
    throw new Error('Another recording session is already active.')
  }

  // MIME -> 扩展名的映射在主进程做，是为了最终文件命名和数据库状态保持一致。
  const detectedMimeType =
    typeof payload?.mimeType === 'string' && payload.mimeType.trim()
      ? payload.mimeType
      : 'video/webm'
  const cloudSyncEnabled = !!payload?.cloudSyncEnabled
  const extension = getVideoExtensionFromMimeType(detectedMimeType)
  const requestedSegmentDurationMs = Number(payload?.segmentDurationMs)
  const segmentDurationMs =
    Number.isFinite(requestedSegmentDurationMs) &&
    requestedSegmentDurationMs >= MIN_SEGMENT_DURATION_MS
      ? Math.floor(requestedSegmentDurationMs)
      : DEFAULT_SEGMENT_DURATION_MS
  const cloudSyncServerUrlCandidate =
    typeof payload?.cloudSyncServerUrl === 'string' && payload.cloudSyncServerUrl.trim()
      ? payload.cloudSyncServerUrl.trim()
      : process.env.CLOUD_SYNC_SERVER_URL || DEFAULT_CLOUD_SYNC_SERVER_URL
  const cloudSyncServerUrl = cloudSyncServerUrlCandidate.replace(/\/+$/, '')
  const sessionDir = join(getRecordingSessionsDirectoryPath(), sessionId)

  await assertRecordingStorageWritable('开始录制')

  if (existsSync(sessionDir)) {
    // 会话目录已存在通常意味着 sessionId 撞车或上次清理异常，直接阻止覆盖。
    throw new Error('Recording session directory already exists.')
  }

  await mkdir(sessionDir, { recursive: true })

  const runtimeSession = {
    // writeQueue 从 resolved Promise 开始，是为了后续统一走串行任务链。
    id: sessionId,
    dir: sessionDir,
    writeQueue: Promise.resolve(),
    writeStream: null,
    currentSegment: null,
    manifest: createRecordingSessionState({
      sessionId,
      sessionDir,
      extension,
      mimeType: detectedMimeType,
      segmentDurationMs,
      cloudSyncEnabled,
      cloudSyncServerUrl
    })
  }

  activeRecordingSession = runtimeSession

  try {
    // 会话一创建就打开首段，避免 renderer 开始推 chunk 时主进程还没准备好写流。
    await recordingSegments.openRecordingSessionSegment(runtimeSession, 1)
    if (cloudSyncEnabled) {
      cloudSyncRuntime.scheduleCloudSyncProcessing(cloudSyncWorkers, runtimeSession)
    }
    return runtimeSession
  } catch (error) {
    // 初始化失败要把模块级 active 状态回滚，否则后续新任务会被永久卡住。
    if (activeRecordingSession?.id === sessionId) {
      activeRecordingSession = null
    }
    throw error
  }
}

/** 追加一个来自渲染进程的录屏 chunk。 */
export async function appendRecordingSessionChunk(payload = {}) {
  const runtimeSession = getActiveRecordingSession(payload?.sessionId)
  if (!runtimeSession) {
    throw new Error('Recording session not found.')
  }

  return enqueueRecordingSessionTask(runtimeSession, async () => {
    await assertRecordingStorageWritable('继续录制')
    // service 层只负责串行化和补完整状态返回，真正写盘逻辑在 recordingSegments。
    const result = await recordingSegments.appendRecordingSessionChunk(
      cloudSyncWorkers,
      runtimeSession,
      payload
    )
    return {
      ...result,
      ...(await getRecordingSessionStatus(runtimeSession))
    }
  })
}

/** 显式轮转当前录屏分段。 */
export async function rotateRecordingSessionSegment(payload = {}) {
  const runtimeSession = getActiveRecordingSession(payload?.sessionId)
  if (!runtimeSession) {
    throw new Error('Recording session not found.')
  }

  return enqueueRecordingSessionTask(runtimeSession, async () => {
    // rotate 后返回完整状态，方便前端立即刷新当前段序号和统计信息。
    await recordingSegments.rotateRecordingSessionSegment(cloudSyncWorkers, runtimeSession)
    return {
      ok: true,
      ...(await getRecordingSessionStatus(runtimeSession))
    }
  })
}

/** 停止录屏、完成本地收尾，并在需要时触发云同步收尾。 */
export async function stopRecordingSession(payload = {}) {
  const runtimeSession = getActiveRecordingSession(payload?.sessionId)
  if (!runtimeSession) {
    throw new Error('Recording session not found.')
  }

  return enqueueRecordingSessionTask(runtimeSession, async () => {
    if (runtimeSession.manifest.status === 'stopped') {
      // stop 幂等化处理，避免前端重复点击导致第二次 stop 抛错。
      return {
        ok: true,
        ...(await getRecordingSessionStatus(runtimeSession))
      }
    }

    /*
     * 输入事实：
     * - 当前会话可能仍有一个 writing 段。
     * - stop 后用户通常期望能立刻开始下一次录制。
     *
     * 状态目标：
     * - 把会话从 recording 切到 stopped。
     * - 产出可 merge / 可 finalize 的稳定输入。
     * - 尽快释放模块级 active 占位。
     *
     * 风险点：
     * - 先改状态不封段，会丢最后一段。
     * - 不及时刷库，崩溃恢复会把 stopped 错判成 recording。
     * - 分段未 finalize 就 merge，最终文件可能缺最后一段数据。
     *
     * 顺序约束：
     * - 必须先 finalize 当前段，再切 stopped，再持久化，再进入 merge/finalize。
     * - activeRecordingSession 的释放要发生在持久化之后、收尾之前。
     *
     * 失败后果：
     * - 最后一段丢失、重复 stop 出错、恢复误判。
     */
    await recordingSegments.finalizeCurrentRecordingSessionSegment(cloudSyncWorkers, runtimeSession)
    // 先把业务状态改成 stopped，再做合并和云同步收尾，避免恢复时误判为录制中。
    runtimeSession.manifest.status = 'stopped'
    runtimeSession.manifest.stoppedAt = Date.now()

    await persistRecordingSessionState(runtimeSession)
    if (activeRecordingSession?.id === runtimeSession.id) {
      // 这里尽早释放 active 会话占位，保证 stop 之后用户可以立即开始下一次录制。
      activeRecordingSession = null
    }

    try {
      const mergeResult = await recordingFinalizer.mergeRecordingSession(runtimeSession)
      if (!runtimeSession.manifest.cloudSyncEnabled) {
        // 本地模式下合并成功即可清理临时目录；云同步模式要等上传链路自己处理清理。
        await recordingFinalizer.cleanupRecordingSessionArtifacts(runtimeSession)
      }
      cloudSyncRuntime.scheduleCloudSyncFinalize(cloudSyncWorkers, runtimeSession)
      return {
        ok: true,
        item: mergeResult.item,
        ...(await getRecordingSessionStatus(runtimeSession))
      }
    } catch (error) {
      // 合并失败时把错误回填到 output，便于前端展示明确失败原因。
      runtimeSession.manifest.output = {
        path: '',
        status: 'failed',
        bytes: 0,
        createdAt: 0,
        message: error instanceof Error ? error.message : 'Failed to merge recording session.'
      }
      await persistRecordingSessionState(runtimeSession)

      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to merge recording session.',
        ...(await getRecordingSessionStatus(runtimeSession))
      }
    }
  })
}

/** 取消当前录屏并删除未完成的临时产物。 */
export async function cancelRecordingSession(payload = {}) {
  /*
   * 输入事实：
   * - cancel 的业务语义不是“先停后保留”，而是彻底放弃当前录制。
   * - 当前会话可能仍持有写流、part 文件和云同步 worker。
   *
   * 状态目标：
   * - 停掉所有活动资源。
   * - 删除所有临时产物，不给恢复链路留下“这个会话还能继续”的信号。
   *
   * 风险点：
   * - 先删目录不关流，会导致清理失败或遗留句柄。
   * - 不停云同步 worker，后台可能继续对已删除文件做上传重试。
   *
   * 顺序约束：
   * - 先停 worker，再释放 active 占位，再关流，再标 cancelled，最后做目录清理。
   *
   * 失败后果：
   * - cancel 后仍有后台上传、残留 .part 文件，甚至下次启动被误当成待恢复会话。
   */
  const runtimeSession = getActiveRecordingSession(payload?.sessionId)
  if (!runtimeSession) {
    throw new Error('Recording session not found.')
  }

  return enqueueRecordingSessionTask(runtimeSession, async () => {
    // cancel 先停掉云同步 worker，避免删除临时目录后后台仍继续上传。
    cloudSyncRuntime.clearCloudSyncWorker(cloudSyncWorkers, runtimeSession.id)
    if (activeRecordingSession?.id === runtimeSession.id) {
      activeRecordingSession = null
    }

    if (runtimeSession.partWriteStream) {
      // 取消时关闭流失败也不应阻断清理，所以这里统一吞掉 end 异常。
      await new Promise((resolveCallback) => {
        runtimeSession.partWriteStream.end(() => resolveCallback())
      }).catch(() => {})
    }

    if (runtimeSession.writeStream) {
      await new Promise((resolveCallback) => {
        runtimeSession.writeStream.end(() => resolveCallback())
      }).catch(() => {})
    }

    runtimeSession.partWriteStream = null
    runtimeSession.writeStream = null
    runtimeSession.currentSegment = null
    runtimeSession.manifest.status = 'cancelled'
    runtimeSession.manifest.stoppedAt = Date.now()

    // cancel 的目标就是彻底回收临时产物，不保留中间态供恢复。
    await recordingFinalizer.cleanupRecordingSessionArtifacts(runtimeSession)

    return {
      ok: true,
      sessionId: runtimeSession.id,
      status: 'cancelled'
    }
  })
}

/** 按 sessionId 获取一个可用于云同步恢复的会话对象。 */
export async function getRuntimeSessionForCloudSync(payload = {}) {
  /*
   * 输入事实：
   * - 云同步重试/删除可能针对当前活跃会话，也可能针对已落库的历史会话。
   * - 内存态永远比数据库快照更新。
   *
   * 状态目标：
   * - 返回一份可直接用于云同步继续处理的 runtimeSession。
   *
   * 风险点：
   * - 优先读数据库会拿到落后的快照，覆盖掉当前录制中的真实状态。
   * - sessionId 为空时如果继续查库，会产生无意义查询。
   *
   * 顺序约束：
   * - 先校验 sessionId，再优先查 active 内存态，查不到时才回退到数据库恢复。
   *
   * 失败后果：
   * - 重试或删除会基于旧状态运行，出现重复上传、错误清理或状态回退。
   */
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
  if (!sessionId) {
    return null
  }

  const activeSession = getActiveRecordingSession(sessionId)
  if (activeSession) {
    // 活跃会话优先用内存态，避免数据库状态比实时状态滞后。
    return activeSession
  }

  const storedSession = readCloudSyncSessionRowsFromDatabase(sessionId)
  if (!storedSession) {
    return null
  }

  return await createRuntimeSessionFromDatabase(storedSession.sessionRow, storedSession.segmentRows)
}

/** 把失败的云同步会话重置回可重试状态。 */
export async function retryCloudSyncSession(payload = {}) {
  /*
   * 输入事实：
   * - retry 面向的是“已有会话、已有分段、只是云同步失败”的场景。
   * - 并不是所有分段都该重置，已经 uploaded 的分段不能被误改。
   *
   * 状态目标：
   * - 把会话重新推回 pending，并只重置仍需重传的失败分段。
   * - 让后台调度能在最小重试范围内继续工作。
   *
   * 风险点：
   * - 无差别重置所有分段会导致重复上传。
   * - 不清理 session 级 lastError/nextRetryAt，会让状态面板一直显示旧失败态。
   *
   * 顺序约束：
   * - 先找会话，再校验 cloudSyncEnabled，再重置 session 状态和分段状态，最后 schedule。
   *
   * 失败后果：
   * - retry 按钮看似成功，但后台不会真正恢复上传，或会重复传已经成功的分段。
   */
  const runtimeSession = await getRuntimeSessionForCloudSync(payload)
  if (!runtimeSession) {
    throw new Error('Cloud sync session not found.')
  }

  if (!runtimeSession.manifest.cloudSyncEnabled) {
    throw new Error('This recording did not enable cloud sync.')
  }

  runtimeSession.manifest.cloudSync.lastError = ''
  runtimeSession.manifest.cloudSync.status = 'pending'
  runtimeSession.manifest.cloudSync.completedAt = null
  runtimeSession.manifest.cloudSync.remoteVideoUrl = ''
  runtimeSession.manifest.cloudSync.nextRetryAt = null

  for (const segment of runtimeSession.manifest.segments) {
    if (segment.status === 'ready' && segment.uploadStatus === 'failed') {
      // 只把失败且本地仍 ready 的分段重置成 pending，避免误动已上传分段。
      segment.uploadStatus = 'pending'
    }
  }

  await persistRecordingSessionState(runtimeSession)
  cloudSyncRuntime.scheduleCloudSyncProcessing(cloudSyncWorkers, runtimeSession)

  return {
    ok: true,
    sessionId: runtimeSession.id,
    ...(await getRecordingSessionStatus(runtimeSession))
  }
}

export function clearCloudSyncWorker(sessionId) {
  // 对外暴露一个窄接口，避免其他模块直接接触内部 worker Map。
  cloudSyncRuntime.clearCloudSyncWorker(cloudSyncWorkers, sessionId)
}
