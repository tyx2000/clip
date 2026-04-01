import { useCallback, useEffect, useRef, useState } from 'react'
import { isLikelyPermissionError, sleep } from '../utils/recordingUtils'

const SEGMENT_DURATION_MS = 5_000

export function useScreenRecordingController({
  isPlayerWindow,
  playerName,
  preferredMimeType,
  applySessionStats
}) {
  const [recordings, setRecordings] = useState([])
  const [isLoadingList, setIsLoadingList] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerSources, setPickerSources] = useState([])
  const [pickerSelectedSourceId, setPickerSelectedSourceId] = useState('')
  const [pickerCloudSyncEnabled, setPickerCloudSyncEnabled] = useState(false)
  const [recordState, setRecordState] = useState('idle')
  const [elapsedSec, setElapsedSec] = useState(0)
  const [statusMessage, setStatusMessage] = useState('准备就绪。')
  const [recordingStats, setRecordingStats] = useState(null)
  const [liveSegmentBytes, setLiveSegmentBytes] = useState(0)
  const [, setShowPermissionSettingsAction] = useState(false)

  const mediaRecorderRef = useRef(null)
  const mediaStreamRef = useRef(null)
  const recordingSessionIdRef = useRef('')
  const isStoppingRef = useRef(false)
  const isCancellingRef = useRef(false)
  const segmentStopTimerRef = useRef(null)
  const chunkQueueRef = useRef(Promise.resolve())
  const timerRef = useRef(null)
  const startedAtRef = useRef(0)

  const isRecording = recordState === 'recording'
  const isBusy = recordState === 'starting' || recordState === 'saving'
  const displayedCurrentSegmentBytes =
    liveSegmentBytes > 0 ? liveSegmentBytes : Number(recordingStats?.currentSegmentBytes || 0)

  const syncStats = useCallback(
    (result) => {
      applySessionStats(result, setRecordingStats)
    },
    [applySessionStats]
  )

  const stopSegmentTimer = useCallback(() => {
    if (segmentStopTimerRef.current) {
      clearTimeout(segmentStopTimerRef.current)
      segmentStopTimerRef.current = null
    }
  }, [])

  const resetSessionRuntimeState = useCallback(() => {
    recordingSessionIdRef.current = ''
    isStoppingRef.current = false
    isCancellingRef.current = false
    chunkQueueRef.current = Promise.resolve()
    setLiveSegmentBytes(0)
    setRecordingStats(null)
  }, [])

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const releaseStream = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
    }
  }, [])

  const resetRecorderState = useCallback(() => {
    stopSegmentTimer()
    mediaRecorderRef.current = null
    stopTimer()
    releaseStream()
    setElapsedSec(0)
    setRecordState('idle')
  }, [releaseStream, stopSegmentTimer, stopTimer])

  const enqueueChunkTask = useCallback((task) => {
    chunkQueueRef.current = chunkQueueRef.current.then(task, task)
    return chunkQueueRef.current
  }, [])

  const stopSessionIfNeeded = useCallback(async () => {
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

  const cancelSessionIfNeeded = useCallback(async () => {
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

  const getScreenRecordingPermissionStatusSafe = useCallback(async () => {
    if (typeof window.api?.getScreenRecordingPermissionStatus !== 'function') {
      return {
        ok: false,
        message: 'Permission API unavailable. Please restart the Electron app process.'
      }
    }

    return window.api.getScreenRecordingPermissionStatus()
  }, [])

  const applyPermissionGuidance = useCallback(
    async (error) => {
      const baseMessage = `Unable to start screen recording: ${error?.message || 'Unknown error.'}`

      try {
        const permissionResult = await getScreenRecordingPermissionStatusSafe()
        if (!permissionResult?.ok) {
          setShowPermissionSettingsAction(false)
          setStatusMessage(baseMessage)
          return
        }

        const permissionStatus = permissionResult.status || 'unknown'
        const canOpenSettings = Boolean(permissionResult.canOpenSettings)
        const shouldShowSettingsAction =
          canOpenSettings &&
          (permissionStatus === 'denied' ||
            permissionStatus === 'restricted' ||
            permissionStatus === 'not-determined' ||
            Boolean(permissionResult.needsSettings))

        setShowPermissionSettingsAction(shouldShowSettingsAction)

        if (shouldShowSettingsAction) {
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
        typeof window.api?.rotateScreenRecordingSegment !== 'function' ||
        typeof window.api?.stopScreenRecordingSession !== 'function'
      ) {
        setStatusMessage('录屏分段 API 不可用，请重启 Electron 应用进程。')
        return
      }

      if (typeof window.api?.setScreenRecordingSource === 'function') {
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

        const stream = await window.navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false
        })

        const seedRecorder = preferredMimeType
          ? new window.MediaRecorder(stream, { mimeType: preferredMimeType })
          : new window.MediaRecorder(stream)

        const sessionResult = await window.api.startScreenRecordingSession({
          mimeType: seedRecorder.mimeType || preferredMimeType || 'video/webm',
          segmentDurationMs: SEGMENT_DURATION_MS,
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

        const finalizeRecording = async () => {
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

        const startSegmentRecorder = () => {
          const segmentRecorder = preferredMimeType
            ? new window.MediaRecorder(stream, { mimeType: preferredMimeType })
            : new window.MediaRecorder(stream)
          const segmentChunks = []

          mediaRecorderRef.current = segmentRecorder
          setLiveSegmentBytes(0)

          segmentRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
              segmentChunks.push(event.data)
              setLiveSegmentBytes((previous) => previous + event.data.size)
            }
          }

          segmentRecorder.onerror = (event) => {
            setStatusMessage(`录屏失败：${event?.error?.message || '未知录制错误。'}`)
          }

          segmentRecorder.onstop = async () => {
            stopSegmentTimer()

            const segmentBlob =
              segmentChunks.length > 0
                ? new Blob(segmentChunks, {
                    type: segmentRecorder.mimeType || preferredMimeType || 'video/webm'
                  })
                : null

            try {
              await enqueueChunkTask(async () => {
                const sessionId = recordingSessionIdRef.current
                if (!sessionId) {
                  return
                }

                if (segmentBlob?.size) {
                  const chunkBuffer = await segmentBlob.arrayBuffer()
                  const appendResult = await window.api.appendScreenRecordingChunk({
                    sessionId,
                    chunk: chunkBuffer
                  })
                  if (!appendResult?.ok) {
                    throw new Error(appendResult?.message || '写入录屏分片失败。')
                  }
                  syncStats(appendResult)
                }

                if (!isStoppingRef.current) {
                  const rotateResult = await window.api.rotateScreenRecordingSegment({ sessionId })
                  if (!rotateResult?.ok) {
                    throw new Error(rotateResult?.message || '切换录屏分段失败。')
                  }
                  syncStats(rotateResult)
                }
              })
            } catch (error) {
              setStatusMessage(`录屏写入失败：${error?.message || '未知错误。'}`)
              isStoppingRef.current = true
            }

            if (isStoppingRef.current) {
              await finalizeRecording()
              return
            }

            startSegmentRecorder()
          }

          segmentRecorder.start(1000)
          stopSegmentTimer()
          segmentStopTimerRef.current = window.setTimeout(() => {
            if (segmentRecorder.state === 'recording' && !isStoppingRef.current) {
              segmentRecorder.stop()
            }
          }, SEGMENT_DURATION_MS)
        }

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

        startSegmentRecorder()
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

  useEffect(() => {
    const sessionId = recordingSessionIdRef.current
    if (!sessionId || typeof window.api?.getScreenRecordingSessionStatus !== 'function') {
      return undefined
    }

    let cancelled = false

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

  useEffect(() => {
    if (isPlayerWindow) {
      return undefined
    }

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

  const handleRecordButtonClick = useCallback(() => {
    if (isRecording) {
      stopRecording()
      return
    }

    openSourcePicker()
  }, [isRecording, openSourcePicker, stopRecording])

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

  const handleCancelPicker = useCallback(() => {
    if (!isBusy) {
      setPickerOpen(false)
    }
  }, [isBusy])

  const handleOpenRecording = useCallback(async (path) => {
    const result = await window.api.openScreenRecording({ path })
    if (!result?.ok) {
      setStatusMessage(result?.message || '打开录屏失败。')
    }
  }, [])

  const handleRevealRecording = useCallback(async (path) => {
    const result = await window.api.revealScreenRecording({ path })
    if (!result?.ok) {
      setStatusMessage(result?.message || '定位文件失败。')
    }
  }, [])

  const handleDeleteRecording = useCallback(async (item) => {
    if (typeof window.api?.deleteScreenRecording !== 'function') {
      setStatusMessage('删除 API 不可用，请重启 Electron 应用进程。')
      return
    }

    const confirmed = window.confirm('确定删除这个录屏文件吗？该操作不可恢复。')
    if (!confirmed) {
      return
    }

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

  const handleDeleteRecordingWithGuard = useCallback(
    async (item) => {
      const pendingSegments = Number(item?.cloudSync?.pendingSegments || 0)
      const failedSegments = Number(item?.cloudSync?.failedSegments || 0)
      const cloudSyncIncomplete =
        item?.cloudSync?.enabled &&
        (pendingSegments > 0 ||
          failedSegments > 0 ||
          item?.cloudSync?.mergeStatus === 'merge_failed' ||
          item?.cloudSync?.mergeStatus === 'uploading')

      if (cloudSyncIncomplete) {
        const confirmed = window.confirm(
          `该视频的云同步尚未完成。\n待同步分片：${pendingSegments}\n失败分片：${failedSegments}\n删除后将无法继续补传。\n\n确定仍要删除吗？`
        )
        if (!confirmed) {
          return
        }
      }

      await handleDeleteRecording(item)
    },
    [handleDeleteRecording]
  )

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
    displayedCurrentSegmentBytes,
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
