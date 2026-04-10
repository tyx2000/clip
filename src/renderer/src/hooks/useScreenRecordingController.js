import { useCallback, useEffect, useRef, useState } from 'react'
import { isLikelyPermissionError, sleep } from '../utils/recordingUtils'

/**
 * 文件作用：封装渲染进程侧的录屏控制流程。
 *
 * 这一个 hook 负责串起以下几条主流程：
 * 1. 页面初始化时读取录屏列表。
 * 2. 点击录制后拉起录制源弹窗，并在确认后请求屏幕流。
 * 3. 使用 MediaRecorder 连续产出 chunk，并通过 IPC 交给主进程落盘。
 * 4. 轮询主进程会话状态，把主进程统计信息同步回页面。
 * 5. 录制结束、取消、删除、重试云同步等用户操作。
 *
 * @param {object} options hook 配置对象，由页面壳层传入。
 * @param {boolean} options.isPlayerWindow 当前渲染进程是否为独立播放器窗口。
 * @param {string} options.playerName 播放器窗口展示的名称。
 * @param {string} options.preferredMimeType 优先尝试使用的录制 mime type。
 * @param {(result: any, setRecordingStats: Function) => void} options.applySessionStats
 * 把主进程状态对象映射到页面统计信息的适配函数。
 */
export function useScreenRecordingController({
  isPlayerWindow,
  playerName,
  preferredMimeType,
  applySessionStats
}) {
  /** 页面上展示的录屏列表。 */
  const [recordings, setRecordings] = useState([])
  /** 录屏列表是否正在加载，用于控制列表 loading 状态。 */
  const [isLoadingList, setIsLoadingList] = useState(true)
  /** 录制源弹窗是否打开。 */
  const [pickerOpen, setPickerOpen] = useState(false)
  /** 录制源弹窗中的数据是否仍在加载。 */
  const [pickerLoading, setPickerLoading] = useState(false)
  /** 当前可选的录制源列表。 */
  const [pickerSources, setPickerSources] = useState([])
  /** 当前在弹窗中被选中的录制源 id。 */
  const [pickerSelectedSourceId, setPickerSelectedSourceId] = useState('')
  /** 当前弹窗里是否勾选了云同步。 */
  const [pickerCloudSyncEnabled, setPickerCloudSyncEnabled] = useState(false)
  /**
   * 当前录制状态。
   * idle: 空闲
   * starting: 正在请求权限和初始化录制
   * recording: 正在录制
   * saving: 正在等待 chunk 落盘并结束会话
   */
  const [recordState, setRecordState] = useState('idle')
  /** 页面顶部展示的录制时长，单位秒。 */
  const [elapsedSec, setElapsedSec] = useState(0)
  /** 页面统一状态文案。 */
  const [statusMessage, setStatusMessage] = useState('准备就绪。')
  /** 主进程返回的录制统计信息摘要。 */
  const [recordingStats, setRecordingStats] = useState(null)
  /** 当前段在渲染进程侧累计到的实时大小，用于更及时刷新页面。 */
  const [liveSegmentBytes, setLiveSegmentBytes] = useState(0)
  /** 是否显示“去系统设置授权”的辅助按钮，仅消费 setter 来驱动页面。 */
  const [, setShowPermissionSettingsAction] = useState(false)

  /** 当前正在工作的 MediaRecorder 实例。 */
  const mediaRecorderRef = useRef(null)
  /** 当前录制使用的屏幕流。 */
  const mediaStreamRef = useRef(null)
  /** 当前主进程录制会话 id，用于后续 chunk 写入和 stop/cancel。 */
  const recordingSessionIdRef = useRef('')
  /** 标记是否已经进入“停止录制”流程，避免重复 stop。 */
  const isStoppingRef = useRef(false)
  /** 标记这次 stop 是否属于“取消录制”而非正常保存。 */
  const isCancellingRef = useRef(false)
  /** 预留的分段定时器引用，当前主要用于统一清理。 */
  const segmentStopTimerRef = useRef(null)
  /** chunk 写入串行队列，确保多个 chunk 按顺序送到主进程。 */
  const chunkQueueRef = useRef(Promise.resolve())
  /** 页面录制时长计时器。 */
  const timerRef = useRef(null)
  /** 当前录制开始时间戳，用来推导 elapsedSec。 */
  const startedAtRef = useRef(0)

  /** 页面当前是否处于真正的录制中状态。 */
  const isRecording = recordState === 'recording'
  /** 页面当前是否处于启动或保存等忙碌态。 */
  const isBusy = recordState === 'starting' || recordState === 'saving'
  /**
   * 当前段展示大小。
   * 优先使用渲染进程实时累计值；若实时值还没有，再回退到主进程统计值。
   */
  const displayedCurrentPartBytes =
    liveSegmentBytes > 0 ? liveSegmentBytes : Number(recordingStats?.currentPartBytes || 0)

  /**
   * 把一次主进程返回的状态载荷同步到页面统计状态。
   *
   * @param {object} result 主进程返回的录制会话结果或状态对象。
   */
  const syncStats = useCallback(
    (result) => {
      applySessionStats(result, setRecordingStats)
    },
    [applySessionStats]
  )

  /**
   * 清掉渲染进程侧的分段定时器。
   *
   * 当前连续录制主流程并不依赖这个定时器来切段，
   * 这里保留它主要是为了让 stop / cancel / unmount 的清理逻辑保持对称。
   */
  const stopSegmentTimer = useCallback(() => {
    if (segmentStopTimerRef.current) {
      clearTimeout(segmentStopTimerRef.current)
      segmentStopTimerRef.current = null
    }
  }, [])

  /**
   * 重置当前录制会话对应的运行时引用与临时状态。
   *
   * 这一步只清理与“主进程会话”强绑定的状态，
   * 不负责释放屏幕流或重置 MediaRecorder。
   */
  const resetSessionRuntimeState = useCallback(() => {
    recordingSessionIdRef.current = ''
    isStoppingRef.current = false
    isCancellingRef.current = false
    chunkQueueRef.current = Promise.resolve()
    setLiveSegmentBytes(0)
    setRecordingStats(null)
  }, [])

  /**
   * 停止页面顶部录制时长计时器。
   */
  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  /**
   * 释放当前屏幕流及其所有轨道。
   *
   * 这一步很关键，否则停止录制后系统层面的共享提示可能仍然存在。
   */
  const releaseStream = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
    }
  }, [])

  /**
   * 在 stop / cancel 完成后，统一重置录制器相关状态。
   *
   * 流程上它负责：
   * 1. 清理分段定时器
   * 2. 清空 MediaRecorder 引用
   * 3. 停止页面计时
   * 4. 释放屏幕流
   * 5. 恢复页面为空闲态
   */
  const resetRecorderState = useCallback(() => {
    stopSegmentTimer()
    mediaRecorderRef.current = null
    stopTimer()
    releaseStream()
    setElapsedSec(0)
    setRecordState('idle')
  }, [releaseStream, stopSegmentTimer, stopTimer])

  /**
   * 把一个异步 chunk 写入任务串到队列尾部，保证写入顺序稳定。
   *
   * @param {() => Promise<any>} task 单个 chunk 的异步写入任务。
   * @returns {Promise<any>} 当前排队后的任务 promise。
   */
  const enqueueChunkTask = useCallback((task) => {
    chunkQueueRef.current = chunkQueueRef.current.then(task, task)
    return chunkQueueRef.current
  }, [])

  /**
   * 在正常结束录制时通知主进程关闭会话。
   *
   * 流程上它只负责主进程 stop，不负责 UI 收尾；
   * 无论成功与否，最后都会清空当前 session 运行时引用。
   */
  const stopSessionIfNeeded = useCallback(async () => {
    /** 当前活跃会话 id。 */
    const sessionId = recordingSessionIdRef.current
    if (!sessionId || typeof window.api?.stopScreenRecordingSession !== 'function') {
      resetSessionRuntimeState()
      return null
    }

    try {
      const result = await window.api.stopScreenRecordingSession({ sessionId })
      syncStats(result)
      return result
    } finally {
      resetSessionRuntimeState()
    }
  }, [resetSessionRuntimeState, syncStats])

  /**
   * 在用户主动放弃录制时通知主进程取消会话。
   *
   * 与正常 stop 的区别是：主进程应丢弃这次录制，不生成最终文件。
   */
  const cancelSessionIfNeeded = useCallback(async () => {
    /** 当前活跃会话 id。 */
    const sessionId = recordingSessionIdRef.current
    if (!sessionId || typeof window.api?.cancelScreenRecordingSession !== 'function') {
      resetSessionRuntimeState()
      return null
    }

    try {
      return await window.api.cancelScreenRecordingSession({ sessionId })
    } finally {
      resetSessionRuntimeState()
    }
  }, [resetSessionRuntimeState])

  /**
   * 从主进程重新加载录屏列表。
   *
   * 这个函数会被以下场景复用：
   * 1. 页面初始化
   * 2. 录制完成后刷新列表
   * 3. 云同步重试后刷新列表
   * 4. 删除文件后刷新或兜底
   */
  const loadRecordings = useCallback(async () => {
    setIsLoadingList(true)

    try {
      const result = await window.api.listScreenRecordings()
      if (result?.ok) {
        setRecordings(Array.isArray(result.items) ? result.items : [])
      } else {
        setStatusMessage(result?.message || '读取录屏列表失败。')
      }
    } catch (error) {
      setStatusMessage(`读取录屏列表失败：${error?.message || '未知错误。'}`)
    } finally {
      setIsLoadingList(false)
    }
  }, [])

  /**
   * 安全获取系统屏幕录制权限状态。
   *
   * 之所以做一层 safe 包装，是因为 preload API 可能缺失，
   * 这里要避免直接抛错把录制启动流程打断得过于隐蔽。
   */
  const getScreenRecordingPermissionStatusSafe = useCallback(async () => {
    if (typeof window.api?.getScreenRecordingPermissionStatus !== 'function') {
      return {
        ok: false,
        message: 'Permission API unavailable. Please restart the Electron app process.'
      }
    }

    return window.api.getScreenRecordingPermissionStatus()
  }, [])

  /**
   * 当启动录制失败时，把错误转成更可执行的权限引导文案。
   *
   * @param {Error | any} error 启动录制时捕获到的原始错误。
   */
  const applyPermissionGuidance = useCallback(
    async (error) => {
      /** 启动失败时的基础错误文案。 */
      const baseMessage = `Unable to start screen recording: ${error?.message || 'Unknown error.'}`

      try {
        /** 主进程返回的权限状态结果。 */
        const permissionResult = await getScreenRecordingPermissionStatusSafe()
        if (!permissionResult?.ok) {
          setShowPermissionSettingsAction(false)
          setStatusMessage(baseMessage)
          return
        }

        /** 系统权限状态，例如 granted / denied / not-determined。 */
        const permissionStatus = permissionResult.status || 'unknown'
        /** 当前系统是否支持直接打开系统设置。 */
        const canOpenSettings = Boolean(permissionResult.canOpenSettings)
        /**
         * 是否应该展示“打开系统权限设置”动作。
         * 只有当系统支持打开设置，并且当前状态确实需要用户手动授权时才显示。
         */
        const shouldShowSettingsAction =
          canOpenSettings &&
          (permissionStatus === 'denied' ||
            permissionStatus === 'restricted' ||
            permissionStatus === 'not-determined' ||
            Boolean(permissionResult.needsSettings))

        setShowPermissionSettingsAction(shouldShowSettingsAction)

        if (shouldShowSettingsAction) {
          /** 针对权限状态拼出的用户引导文案。 */
          const guidance =
            permissionStatus === 'not-determined'
              ? '请允许系统的屏幕录制授权；若没有弹窗，请点“打开系统权限设置”，授权后重启应用。'
              : '当前系统已拒绝屏幕录制权限，请点“打开系统权限设置”授权后重启应用。'
          setStatusMessage(`${baseMessage} ${guidance}（status: ${permissionStatus}）`)
          return
        }

        setStatusMessage(`${baseMessage}（status: ${permissionStatus}）`)
      } catch {
        setShowPermissionSettingsAction(false)
        setStatusMessage(baseMessage)
      }
    },
    [getScreenRecordingPermissionStatusSafe]
  )

  /**
   * 使用选定录制源启动一次录屏。
   *
   * 控制流程：
   * 1. 校验浏览器能力与 preload API。
   * 2. 把当前选中的源 id 写给主进程。
   * 3. 先检查权限状态，必要时直接引导用户授权。
   * 4. 调 getDisplayMedia 拿到屏幕流。
   * 5. 向主进程创建录制会话。
   * 6. 启动 MediaRecorder，持续把 chunk 送到主进程。
   * 7. 监听 stop / cancel / track ended，完成收尾。
   *
   * @param {string} sourceId 用户在弹窗中选中的桌面源 id。
   * @param {boolean} cloudSyncEnabled 是否同时启用云同步。
   */
  const beginRecordingWithSource = useCallback(
    async (sourceId, cloudSyncEnabled) => {
      if (!sourceId) {
        setStatusMessage('请先选择要录制的屏幕或窗口。')
        return
      }

      if (!window.navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
        setStatusMessage('当前环境不支持录屏，请确认 Electron 录屏权限配置。')
        return
      }

      if (
        typeof window.api?.startScreenRecordingSession !== 'function' ||
        typeof window.api?.appendScreenRecordingChunk !== 'function' ||
        typeof window.api?.stopScreenRecordingSession !== 'function'
      ) {
        setStatusMessage('录屏分段 API 不可用，请重启 Electron 应用进程。')
        return
      }

      if (typeof window.api?.setScreenRecordingSource === 'function') {
        /** 把当前选中的录制源同步给主进程，便于后续源选择保持一致。 */
        const setResult = await window.api.setScreenRecordingSource({ sourceId })
        if (!setResult?.ok) {
          setStatusMessage(setResult?.message || '设置录制源失败。')
          return
        }
      }

      setShowPermissionSettingsAction(false)
      setRecordState('starting')
      setStatusMessage('正在请求屏幕权限...')

      try {
        /** 当前系统的屏幕录制权限状态。 */
        const permissionResult = await getScreenRecordingPermissionStatusSafe()
        if (
          permissionResult?.ok &&
          permissionResult.canOpenSettings &&
          (permissionResult.status === 'denied' || permissionResult.status === 'restricted')
        ) {
          setRecordState('idle')
          setShowPermissionSettingsAction(true)
          setStatusMessage(
            `系统屏幕录制权限为 ${permissionResult.status}，请先打开系统权限设置授权，再重新开始录屏。`
          )
          return
        }

        /** 真实的屏幕流，后续 MediaRecorder 与 track ended 都依赖它。 */
        const stream = await window.navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false
        })

        /** 真正用于录制的 MediaRecorder，同时复用它返回浏览器最终接受的 mimeType。 */
        const recorder = preferredMimeType
          ? new window.MediaRecorder(stream, { mimeType: preferredMimeType })
          : new window.MediaRecorder(stream)

        /** 主进程创建录制会话的结果。 */
        const sessionResult = await window.api.startScreenRecordingSession({
          mimeType: recorder.mimeType || preferredMimeType || 'video/webm',
          segmentDurationMs: 0,
          cloudSyncEnabled
        })
        if (!sessionResult?.ok || !sessionResult.sessionId) {
          throw new Error(sessionResult?.message || '创建录制会话失败。')
        }

        mediaStreamRef.current = stream
        recordingSessionIdRef.current = sessionResult.sessionId
        isStoppingRef.current = false
        chunkQueueRef.current = Promise.resolve()
        syncStats(sessionResult)
        startedAtRef.current = Date.now()
        setElapsedSec(0)
        setRecordState('recording')
        setStatusMessage('录屏中...')

        stopTimer()
        timerRef.current = setInterval(() => {
          setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000))
        }, 1000)

        /**
         * 当 MediaRecorder 停止后，统一执行结束逻辑。
         *
         * 流程上分两支：
         * 1. cancel: 等待已排队 chunk 写完，然后让主进程取消会话。
         * 2. normal stop: 等待已排队 chunk 写完，然后让主进程封口并生成结果。
         */
        const finalizeRecording = async () => {
          /** 这次 stop 是否是用户主动取消。 */
          const isCancelling = isCancellingRef.current
          setRecordState('saving')
          setStatusMessage(isCancelling ? '正在取消录屏...' : '正在落盘录屏分段...')
          stopTimer()

          try {
            await chunkQueueRef.current

            if (isCancelling) {
              const cancelResult = await cancelSessionIfNeeded()
              if (!cancelResult?.ok) {
                setStatusMessage(cancelResult?.message || '取消录屏失败。')
                await loadRecordings()
                return
              }

              setStatusMessage('已取消录屏。')
              return
            }

            const stopResult = await stopSessionIfNeeded()
            if (!stopResult?.ok) {
              setStatusMessage(stopResult?.message || '结束录屏会话失败。')
              await loadRecordings()
              return
            }

            if (stopResult.item) {
              setStatusMessage(`录屏已保存：${stopResult.item.name}`)
            } else {
              setStatusMessage(`录屏已结束：${stopResult.sessionId}`)
            }
            await loadRecordings()
          } catch (error) {
            setStatusMessage(`保存录屏失败：${error?.message || '未知错误。'}`)
          } finally {
            resetSessionRuntimeState()
            resetRecorderState()
          }
        }

        mediaRecorderRef.current = recorder
        setLiveSegmentBytes(0)

        recorder.ondataavailable = (event) => {
          if (!event.data || event.data.size <= 0) {
            return
          }

          setLiveSegmentBytes((previous) => previous + event.data.size)
          enqueueChunkTask(async () => {
            /** 当前仍然有效的录制会话 id。 */
            const sessionId = recordingSessionIdRef.current
            if (!sessionId) {
              return
            }

            /** 当前 chunk 的二进制内容，会通过 IPC 送到主进程。 */
            const chunkBuffer = await event.data.arrayBuffer()
            const appendResult = await window.api.appendScreenRecordingChunk({
              sessionId,
              chunk: chunkBuffer
            })
            if (!appendResult?.ok) {
              throw new Error(appendResult?.message || '写入录屏分片失败。')
            }
            syncStats(appendResult)
          }).catch((error) => {
            setStatusMessage(`录屏写入失败：${error?.message || '未知错误。'}`)
            isStoppingRef.current = true
            stopSegmentTimer()
            if (mediaRecorderRef.current?.state === 'recording') {
              mediaRecorderRef.current.stop()
            }
          })
        }

        recorder.onerror = (event) => {
          setStatusMessage(`录屏失败：${event?.error?.message || '未知录制错误。'}`)
        }

        recorder.onstop = async () => {
          stopSegmentTimer()
          await finalizeRecording()
        }

        /** 当前屏幕流中的主视频轨道，用于监听系统层面的共享结束。 */
        const [videoTrack] = stream.getVideoTracks()
        if (videoTrack) {
          videoTrack.addEventListener('ended', () => {
            isStoppingRef.current = true
            stopSegmentTimer()
            if (mediaRecorderRef.current?.state === 'recording') {
              mediaRecorderRef.current.stop()
            }
          })
        }

        /**
         * 每秒吐一次 chunk。
         * 这样主进程能更稳定地持续落盘，同时也利于长录制降低内存堆积。
         */
        recorder.start(1000)
      } catch (error) {
        await stopSessionIfNeeded()
        resetRecorderState()
        if (isLikelyPermissionError(error)) {
          await applyPermissionGuidance(error)
          return
        }

        setShowPermissionSettingsAction(false)
        setStatusMessage(`Unable to start screen recording: ${error?.message || 'Unknown error.'}`)
      }
    },
    [
      applyPermissionGuidance,
      cancelSessionIfNeeded,
      enqueueChunkTask,
      getScreenRecordingPermissionStatusSafe,
      loadRecordings,
      preferredMimeType,
      resetRecorderState,
      resetSessionRuntimeState,
      stopSegmentTimer,
      stopSessionIfNeeded,
      stopTimer,
      syncStats
    ]
  )

  /**
   * 在录制进行中轮询主进程会话状态。
   *
   * 目的有两个：
   * 1. 刷新主进程统计信息，例如当前分段大小、已写入总量等。
   * 2. 让页面状态跟主进程真实会话保持一致，而不是只依赖本地乐观状态。
   */
  useEffect(() => {
    /** 当前录制会话 id。 */
    const sessionId = recordingSessionIdRef.current
    if (!sessionId || typeof window.api?.getScreenRecordingSessionStatus !== 'function') {
      return undefined
    }

    /** 标记 effect 是否已清理，避免异步返回后继续 setState。 */
    let cancelled = false

    /**
     * 单次拉取主进程会话状态。
     */
    const pollSessionStatus = async () => {
      const result = await window.api.getScreenRecordingSessionStatus({ sessionId })
      if (!cancelled && result?.ok) {
        syncStats(result)
      }
    }

    pollSessionStatus().catch(() => {})
    const timer = window.setInterval(() => {
      pollSessionStatus().catch(() => {})
    }, 2000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [recordState, syncStats])

  /**
   * 打开录制源选择弹窗，并读取可用的桌面源列表。
   *
   * 流程上它只负责“准备选择源”，不直接开始录制。
   */
  const openSourcePicker = useCallback(async () => {
    if (isBusy || isRecording) {
      return
    }

    if (typeof window.api?.getScreenRecordingSources !== 'function') {
      setStatusMessage('录制源 API 不可用，请重启 Electron 应用进程。')
      return
    }

    setPickerOpen(true)
    setPickerLoading(true)
    setPickerSources([])
    /** 为了避免弹窗闪烁，列表加载至少维持一段最小时间。 */
    const minimumLoading = sleep(1500)

    try {
      const result = await window.api.getScreenRecordingSources()
      await minimumLoading
      if (!result?.ok) {
        setStatusMessage(result?.message || '读取录制源失败。')
        setPickerSources([])
        setPickerSelectedSourceId('')
        return
      }

      /** 主进程返回的原始桌面源列表。 */
      const sources = Array.isArray(result.sources) ? result.sources : []
      setPickerSources(sources)
      setPickerSelectedSourceId(
        sources.find((item) => item.type === 'screen')?.id || sources[0]?.id || ''
      )
    } catch (error) {
      await minimumLoading
      setStatusMessage(`读取录制源失败：${error?.message || '未知错误。'}`)
      setPickerSources([])
      setPickerSelectedSourceId('')
    } finally {
      setPickerLoading(false)
    }
  }, [isBusy, isRecording])

  /**
   * 页面初始化与卸载清理逻辑。
   *
   * - 如果当前窗口是播放器窗口，只负责设置标题。
   * - 如果是主页面，则初始化录屏列表，并在卸载时兜底停止正在录制的 recorder。
   */
  useEffect(() => {
    if (isPlayerWindow) {
      document.title = `录制回放 - ${playerName}`
      return undefined
    }

    document.title = 'Clip Recorder'
    loadRecordings()

    return () => {
      isStoppingRef.current = true
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      resetRecorderState()
    }
  }, [isPlayerWindow, loadRecordings, playerName, resetRecorderState])

  /**
   * 当网络恢复时，通知主进程尝试继续处理待完成的云同步会话。
   *
   * 这样用户在离线录制后恢复网络，无需手动点击每一条重试。
   */
  useEffect(() => {
    if (isPlayerWindow) {
      return undefined
    }

    /**
     * 恢复所有待继续的云同步会话。
     */
    const resumeCloudSync = async () => {
      if (typeof window.api?.resumeAllCloudSyncSessions !== 'function') {
        return
      }

      const result = await window.api.resumeAllCloudSyncSessions().catch(() => null)
      if (!result?.ok || Number(result.resumed || 0) <= 0) {
        return
      }

      setStatusMessage(`网络可用，已恢复 ${Number(result.resumed)} 个云同步会话。`)
      await loadRecordings()
    }

    window.addEventListener('online', resumeCloudSync)
    if (window.navigator.onLine) {
      resumeCloudSync()
    }

    return () => {
      window.removeEventListener('online', resumeCloudSync)
    }
  }, [isPlayerWindow, loadRecordings])

  /**
   * 用户点击“停止录制”时触发的入口。
   *
   * 这里不直接和主进程交互，而是先停止 MediaRecorder；
   * 真正的主进程 stop 会在 recorder.onstop -> finalizeRecording 中执行。
   */
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state !== 'recording') {
      return
    }

    isCancellingRef.current = false
    isStoppingRef.current = true
    stopSegmentTimer()
    setStatusMessage('正在停止录屏...')
    mediaRecorderRef.current.stop()
  }, [stopSegmentTimer])

  /**
   * 用户点击“取消录制”时触发的入口。
   *
   * 和 stop 的区别是先打上 cancelling 标记，
   * 之后 finalizeRecording 会走 cancel 分支。
   */
  const cancelRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state !== 'recording') {
      return
    }

    isCancellingRef.current = true
    isStoppingRef.current = true
    stopSegmentTimer()
    setStatusMessage('正在取消录屏...')
    mediaRecorderRef.current.stop()
  }, [stopSegmentTimer])

  /**
   * 处理顶部主按钮点击。
   *
   * - 正在录制时：按钮语义是停止。
   * - 空闲时：按钮语义是打开录制源选择弹窗。
   */
  const handleRecordButtonClick = useCallback(() => {
    if (isRecording) {
      stopRecording()
      return
    }

    openSourcePicker()
  }, [isRecording, openSourcePicker, stopRecording])

  /**
   * 在录制源弹窗里点击“确定开始录制”后的处理函数。
   *
   * 流程上先关闭弹窗，再进入真正的 beginRecordingWithSource。
   */
  const handleConfirmSourceAndStart = useCallback(async () => {
    if (!pickerSelectedSourceId || isBusy || pickerLoading) {
      return
    }

    setPickerOpen(false)
    await beginRecordingWithSource(pickerSelectedSourceId, pickerCloudSyncEnabled)
  }, [
    beginRecordingWithSource,
    isBusy,
    pickerCloudSyncEnabled,
    pickerLoading,
    pickerSelectedSourceId
  ])

  /**
   * 取消并关闭录制源弹窗。
   *
   * 忙碌态时不允许关闭，避免在启动录制过程中把 UI 状态打乱。
   */
  const handleCancelPicker = useCallback(() => {
    if (!isBusy) {
      setPickerOpen(false)
    }
  }, [isBusy])

  /**
   * 打开录屏文件，通常会进入应用内播放器窗口。
   *
   * @param {string} path 目标录屏文件路径。
   */
  const handleOpenRecording = useCallback(async (path) => {
    const result = await window.api.openScreenRecording({ path })
    if (!result?.ok) {
      setStatusMessage(result?.message || '打开录屏失败。')
    }
  }, [])

  /**
   * 在系统文件管理器中定位录屏文件。
   *
   * @param {string} path 目标录屏文件路径。
   */
  const handleRevealRecording = useCallback(async (path) => {
    const result = await window.api.revealScreenRecording({ path })
    if (!result?.ok) {
      setStatusMessage(result?.message || '定位文件失败。')
    }
  }, [])

  /**
   * 删除一条录屏记录及其文件。
   *
   * @param {object} item 当前录屏卡片对应的数据项。
   */
  const handleDeleteRecording = useCallback(async (item) => {
    if (typeof window.api?.deleteScreenRecording !== 'function') {
      setStatusMessage('删除 API 不可用，请重启 Electron 应用进程。')
      return
    }

    const confirmed = window.confirm('确定删除这个录屏文件吗？该操作不可恢复。')
    if (!confirmed) {
      return
    }

    /** 当前要删除的录屏文件路径。 */
    const path = item?.path || ''
    const result = await window.api.deleteScreenRecording({
      path,
      sessionId: item?.cloudSync?.sessionId || ''
    })
    if (!result?.ok) {
      setStatusMessage(result?.message || '删除录屏失败。')
      return
    }

    setRecordings((previous) => previous.filter((item) => item.path !== path))
    setStatusMessage('录屏已删除。')
  }, [])

  /**
   * 将某条失败或中断的云同步会话重新加入上传队列。
   *
   * @param {object} item 当前录屏卡片对应的数据项。
   */
  const handleRetryCloudSync = useCallback(
    async (item) => {
      if (typeof window.api?.retryCloudSyncSession !== 'function') {
        setStatusMessage(
          'Cloud sync retry API unavailable. Please restart the Electron app process.'
        )
        return
      }

      const result = await window.api.retryCloudSyncSession({
        sessionId: item.cloudSync?.sessionId
      })
      if (!result?.ok) {
        setStatusMessage(result?.message || '重试云同步失败。')
        return
      }

      setStatusMessage('已重新加入云同步队列。')
      await loadRecordings()
    },
    [loadRecordings]
  )

  /**
   * 在真正删除前，对“云同步尚未完成”的录屏做一次额外确认。
   *
   * @param {object} item 当前录屏卡片对应的数据项。
   */
  const handleDeleteRecordingWithGuard = useCallback(
    async (item) => {
      /** 尚未上传完成的分片数量。 */
      const pendingParts = Number(item?.cloudSync?.pendingParts || 0)
      /** 上传失败的分片数量。 */
      const failedParts = Number(item?.cloudSync?.failedParts || 0)
      /**
       * 当前是否属于“云同步尚未完成”的状态。
       * 只要还有待传、失败、同步中或合并中，都要加一道确认。
       */
      const cloudSyncIncomplete =
        item?.cloudSync?.enabled &&
        (pendingParts > 0 ||
          failedParts > 0 ||
          item?.cloudSync?.status === 'failed' ||
          item?.cloudSync?.status === 'syncing' ||
          item?.cloudSync?.status === 'merging' ||
          item?.cloudSync?.status === 'pending')

      if (cloudSyncIncomplete) {
        const confirmed = window.confirm(
          `该视频的云同步尚未完成。\n待同步分片：${pendingParts}\n失败分片：${failedParts}\n删除后将无法继续补传。\n\n确定仍要删除吗？`
        )
        if (!confirmed) {
          return
        }
      }

      await handleDeleteRecording(item)
    },
    [handleDeleteRecording]
  )

  /**
   * 对外暴露给页面组件的状态和操作集合。
   *
   * 页面只需要消费这里返回的数据，不需要直接接触 MediaRecorder、stream 或 IPC 细节。
   */
  return {
    recordings,
    isLoadingList,
    pickerOpen,
    pickerLoading,
    pickerSources,
    pickerSelectedSourceId,
    pickerCloudSyncEnabled,
    setPickerSelectedSourceId,
    setPickerCloudSyncEnabled,
    recordState,
    elapsedSec,
    statusMessage,
    recordingStats,
    displayedCurrentPartBytes,
    isRecording,
    isBusy,
    loadRecordings,
    handleRecordButtonClick,
    cancelRecording,
    handleConfirmSourceAndStart,
    handleCancelPicker,
    handleOpenRecording,
    handleRevealRecording,
    handleDeleteRecordingWithGuard,
    handleRetryCloudSync
  }
}
