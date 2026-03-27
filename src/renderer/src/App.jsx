import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import styled from 'styled-components'
import RecordingVideoCard from './components/RecordingVideoCard'
import SourcePickerModal from './components/SourcePickerModal'
import {
  formatBytes,
  formatDuration,
  getPreferredRecorderMimeType,
  isLikelyPermissionError,
  sleep
} from './utils/recordingUtils'

const TESTING_SEGMENT_DURATION_MS = 5_000

const Page = styled.main`
  height: 100%;
  padding: 22px;
  display: grid;
  grid-template-rows: auto auto 1fr;
  gap: 14px;
`

const TopBar = styled.section`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--line-soft);
  background: var(--color-block-card-strong);
`

const TitleGroup = styled.div`
  display: grid;
  gap: 6px;
`

const Title = styled.h1`
  margin: 0;
  font-size: 22px;
  line-height: 1.2;
`

const Subtitle = styled.p`
  margin: 0;
  color: var(--color-text-soft);
  font-size: 13px;
`

const StatusText = styled.p`
  margin: 0;
  color: var(--color-text-soft);
  font-size: 12px;
`

const MetricsRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`

const MetricPill = styled.span`
  border-radius: 999px;
  padding: 5px 9px;
  border: 1px solid ${({ $warning }) => ($warning ? '#fecaca' : 'var(--line-soft)')};
  background: ${({ $warning }) => ($warning ? '#fef2f2' : 'var(--color-block-input)')};
  color: ${({ $warning }) => ($warning ? '#b91c1c' : 'var(--color-text-soft)')};
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
`

const TopActions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
`

const RecordTimeBadge = styled.span`
  min-width: 68px;
  text-align: center;
  border-radius: 10px;
  padding: 9px 12px;
  border: 1px solid ${({ $active }) => ($active ? '#fecaca' : 'var(--line-soft)')};
  background: ${({ $active }) => ($active ? '#fef2f2' : 'var(--color-block-input)')};
  color: ${({ $active }) => ($active ? '#b91c1c' : 'var(--color-text)')};
  font-weight: 700;
  font-variant-numeric: tabular-nums;
`

const Button = styled.button`
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  padding: 9px 12px;
  min-width: 112px;
  background: var(--color-block-input);
  color: var(--color-text);
  font-weight: 600;
  cursor: pointer;

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`

const RecordButton = styled(Button)`
  border: none;
  background: ${({ $active }) => ($active ? '#b42318' : 'var(--color-block-button)')};
  color: #ffffff;
`

// const StatusCard = styled.section`
//   border-radius: 12px;
//   border: 1px solid var(--line-soft);
//   background: var(--color-block-card);
//   padding: 12px 14px;
//   display: grid;
//   gap: 4px;
// `

// const StatusLine = styled.p`
//   margin: 0;
//   font-size: 13px;
// `

// const StatusActionButton = styled(Button)`
//   width: fit-content;
//   margin-top: 4px;
// `

const ListWrap = styled.section`
  border-radius: 12px;
  border: 1px solid var(--line-soft);
  background: var(--color-block-card);
  padding: 14px;
`

const ListHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
`

const VideosGrid = styled.div`
  min-height: 320px;
  display: grid;
  place-items: ${({ $hasItems }) => ($hasItems ? 'stretch' : 'center')};
`

const SectionTitle = styled.h2`
  margin: 0;
  font-size: 16px;
`

const EmptyState = styled.p`
  margin: 0;
  font-size: 13px;
  color: var(--color-text-soft);
  text-align: center;
`

const RecordingGrid = styled.div`
  width: 100%;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  align-items: start;
  gap: 12px;
`

const PlayerPage = styled.main`
  height: 100%;
  display: grid;
  grid-template-rows: auto 1fr;
  background: #0b1020;
  color: #e5e7eb;
`

const PlayerHeader = styled.header`
  padding: 10px 14px;
  border-bottom: 1px solid #1f2937;
  color: #93c5fd;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const PlayerBody = styled.section`
  padding: 12px;
  display: grid;
  place-items: center;
`

const PlayerVideo = styled.video`
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
  border-radius: 8px;
`

function App() {
  const playerParams = useMemo(() => new URLSearchParams(window.location.search), [])
  const playerUrl = playerParams.get('player') || ''
  const playerName = playerParams.get('name') || '录制回放'
  const isPlayerWindow = Boolean(playerUrl)

  const [recordings, setRecordings] = useState([])
  const [isLoadingList, setIsLoadingList] = useState(true)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerSources, setPickerSources] = useState([])
  const [pickerSelectedSourceId, setPickerSelectedSourceId] = useState('')

  const [recordState, setRecordState] = useState('idle')
  const [elapsedSec, setElapsedSec] = useState(0)
  const [statusMessage, setStatusMessage] = useState('准备就绪。')
  const [recordingStats, setRecordingStats] = useState(null)
  const [, setShowPermissionSettingsAction] = useState(false)

  const mediaRecorderRef = useRef(null)
  const mediaStreamRef = useRef(null)
  const recordingSessionIdRef = useRef('')
  const currentSegmentStartedAtRef = useRef(0)
  const segmentDurationMsRef = useRef(TESTING_SEGMENT_DURATION_MS)
  const chunkQueueRef = useRef(Promise.resolve())
  const timerRef = useRef(null)
  const startedAtRef = useRef(0)

  const preferredMimeType = useMemo(() => getPreferredRecorderMimeType(), [])
  const isRecording = recordState === 'recording'
  const isBusy = recordState === 'starting' || recordState === 'saving'

  const resetSessionRuntimeState = useCallback(() => {
    recordingSessionIdRef.current = ''
    currentSegmentStartedAtRef.current = 0
    segmentDurationMsRef.current = TESTING_SEGMENT_DURATION_MS
    chunkQueueRef.current = Promise.resolve()
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
    mediaRecorderRef.current = null
    stopTimer()
    releaseStream()
    setElapsedSec(0)
    setRecordState('idle')
  }, [releaseStream, stopTimer])

  const enqueueChunkTask = useCallback((task) => {
    chunkQueueRef.current = chunkQueueRef.current.then(task, task)
    return chunkQueueRef.current
  }, [])

  const applySessionStats = useCallback((result) => {
    if (!result) {
      return
    }

    setRecordingStats({
      segmentCount: Number(result.segmentCount || 0),
      currentSegmentIndex: Number(result.currentSegmentIndex || 0),
      currentSegmentBytes: Number(result.currentSegmentBytes || 0),
      totalBytes: Number(result.totalBytes || 0),
      freeBytes: Number(result.storage?.freeBytes || 0),
      lowDiskSpace: Boolean(result.storage?.lowDiskSpace)
    })
  }, [])

  const stopSessionIfNeeded = useCallback(async () => {
    const sessionId = recordingSessionIdRef.current
    if (!sessionId || typeof window.api?.stopScreenRecordingSession !== 'function') {
      resetSessionRuntimeState()
      return null
    }

    try {
      const result = await window.api.stopScreenRecordingSession({ sessionId })
      applySessionStats(result)
      return result
    } finally {
      resetSessionRuntimeState()
    }
  }, [applySessionStats, resetSessionRuntimeState])

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
    async (sourceId) => {
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

        const recorder = preferredMimeType
          ? new window.MediaRecorder(stream, { mimeType: preferredMimeType })
          : new window.MediaRecorder(stream)

        const sessionResult = await window.api.startScreenRecordingSession({
          mimeType: recorder.mimeType || preferredMimeType || 'video/webm',
          segmentDurationMs: TESTING_SEGMENT_DURATION_MS
        })
        if (!sessionResult?.ok || !sessionResult.sessionId) {
          throw new Error(sessionResult?.message || '创建录制会话失败。')
        }

        mediaStreamRef.current = stream
        mediaRecorderRef.current = recorder
        recordingSessionIdRef.current = sessionResult.sessionId
        currentSegmentStartedAtRef.current = Date.now()
        segmentDurationMsRef.current =
          Number(sessionResult.segmentDurationMs) > 0
            ? Number(sessionResult.segmentDurationMs)
            : TESTING_SEGMENT_DURATION_MS
        chunkQueueRef.current = Promise.resolve()
        applySessionStats(sessionResult)
        startedAtRef.current = Date.now()
        setElapsedSec(0)
        setRecordState('recording')
        setStatusMessage('录屏中...')

        stopTimer()
        timerRef.current = setInterval(() => {
          setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000))
        }, 1000)

        const [videoTrack] = stream.getVideoTracks()
        if (videoTrack) {
          videoTrack.addEventListener('ended', () => {
            if (recorder.state === 'recording') {
              recorder.stop()
            }
          })
        }

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            enqueueChunkTask(async () => {
              const sessionId = recordingSessionIdRef.current
              if (!sessionId) {
                return
              }

              const chunkBuffer = await event.data.arrayBuffer()
              const appendResult = await window.api.appendScreenRecordingChunk({
                sessionId,
                chunk: chunkBuffer
              })
              if (!appendResult?.ok) {
                throw new Error(appendResult?.message || '写入录屏分片失败。')
              }
              applySessionStats(appendResult)

              const now = Date.now()
              const shouldRotate =
                now - currentSegmentStartedAtRef.current >= segmentDurationMsRef.current
              if (!shouldRotate) {
                return
              }

              const rotateResult = await window.api.rotateScreenRecordingSegment({ sessionId })
              if (!rotateResult?.ok) {
                throw new Error(rotateResult?.message || '切换录屏分段失败。')
              }
              applySessionStats(rotateResult)
              currentSegmentStartedAtRef.current = Date.now()
            }).catch((error) => {
              setStatusMessage(`录屏写入失败：${error?.message || '未知错误。'}`)
              if (mediaRecorderRef.current?.state === 'recording') {
                mediaRecorderRef.current.stop()
              }
            })
          }
        }

        recorder.onerror = (event) => {
          const message = event?.error?.message || '未知录制错误。'
          setStatusMessage(`录屏失败：${message}`)
        }

        recorder.onstop = async () => {
          setRecordState('saving')
          setStatusMessage('正在落盘录屏分段...')
          stopTimer()

          try {
            await chunkQueueRef.current
            const stopResult = await stopSessionIfNeeded()
            if (!stopResult?.ok) {
              setStatusMessage(stopResult?.message || '结束录屏会话失败。')
              await loadRecordings()
              return
            }
            if (stopResult.item) {
              setRecordings((previous) => [stopResult.item, ...previous])
              setStatusMessage(`录屏已保存：${stopResult.item.name}`)
            } else {
              await loadRecordings()
              setStatusMessage(`录屏已结束：${stopResult.sessionId}`)
            }
          } catch (error) {
            setStatusMessage(`保存录屏失败：${error?.message || '未知错误。'}`)
          } finally {
            resetSessionRuntimeState()
            resetRecorderState()
          }
        }

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
      applySessionStats,
      applyPermissionGuidance,
      enqueueChunkTask,
      getScreenRecordingPermissionStatusSafe,
      loadRecordings,
      preferredMimeType,
      resetSessionRuntimeState,
      resetRecorderState,
      stopSessionIfNeeded,
      stopTimer
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
        applySessionStats(result)
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
  }, [applySessionStats, isBusy, isRecording, recordState])

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

      if (!sources.length) {
        setPickerSelectedSourceId('')
        return
      }

      const defaultSourceId = sources.find((item) => item.type === 'screen')?.id || sources[0].id
      setPickerSelectedSourceId(defaultSourceId)
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
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      resetRecorderState()
    }
  }, [isPlayerWindow, loadRecordings, playerName, resetRecorderState])

  if (isPlayerWindow) {
    return (
      <PlayerPage>
        <PlayerHeader title={playerName}>{playerName}</PlayerHeader>
        <PlayerBody>
          <PlayerVideo controls preload="metadata" src={playerUrl} />
        </PlayerBody>
      </PlayerPage>
    )
  }

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current

    if (!recorder || recorder.state !== 'recording') {
      return
    }

    setStatusMessage('正在停止录屏...')
    recorder.stop()
  }

  const handleRecordButtonClick = () => {
    if (isRecording) {
      stopRecording()
      return
    }

    openSourcePicker()
  }

  const handleConfirmSourceAndStart = async () => {
    if (!pickerSelectedSourceId || isBusy || pickerLoading) {
      return
    }

    const sourceId = pickerSelectedSourceId
    setPickerOpen(false)
    await beginRecordingWithSource(sourceId)
  }

  const handleCancelPicker = () => {
    if (isBusy) {
      return
    }
    setPickerOpen(false)
  }

  const handleOpenRecording = async (path) => {
    const result = await window.api.openScreenRecording({ path })
    if (!result?.ok) {
      setStatusMessage(result?.message || '打开录屏失败。')
    }
  }

  const handleRevealRecording = async (path) => {
    const result = await window.api.revealScreenRecording({ path })
    if (!result?.ok) {
      setStatusMessage(result?.message || '定位文件失败。')
    }
  }

  const handleDeleteRecording = async (path) => {
    if (typeof window.api?.deleteScreenRecording !== 'function') {
      setStatusMessage('删除 API 不可用，请重启 Electron 应用进程。')
      return
    }

    const confirmed = window.confirm('确定删除这个录屏文件吗？该操作不可恢复。')
    if (!confirmed) {
      return
    }

    const result = await window.api.deleteScreenRecording({ path })
    if (!result?.ok) {
      setStatusMessage(result?.message || '删除录屏失败。')
      return
    }

    setRecordings((previous) => previous.filter((item) => item.path !== path))
    setStatusMessage('录屏已删除。')
  }

  return (
    <>
      <Page>
        <TopBar>
          <TitleGroup>
            <Title>屏幕录制</Title>
            <Subtitle>点击开始录制后选择屏幕或窗口，确认后开始录制。</Subtitle>
            <StatusText>{statusMessage}</StatusText>
            {recordingStats ? (
              <MetricsRow>
                <MetricPill>已写入 {formatBytes(recordingStats.totalBytes)}</MetricPill>
                <MetricPill>
                  当前分段 #{recordingStats.currentSegmentIndex || 1} ·{' '}
                  {formatBytes(recordingStats.currentSegmentBytes)}
                </MetricPill>
                <MetricPill>分段数 {recordingStats.segmentCount}</MetricPill>
                <MetricPill $warning={recordingStats.lowDiskSpace}>
                  可用空间 {formatBytes(recordingStats.freeBytes)}
                </MetricPill>
              </MetricsRow>
            ) : null}
          </TitleGroup>
          <TopActions>
            <RecordTimeBadge $active={isRecording}>{formatDuration(elapsedSec)}</RecordTimeBadge>
            <RecordButton
              type="button"
              onClick={handleRecordButtonClick}
              disabled={isBusy}
              $active={isRecording}
            >
              {isRecording ? '停止录制' : isBusy ? '处理中...' : '开始录制'}
            </RecordButton>
          </TopActions>
        </TopBar>

        {/* <StatusCard>
          <StatusLine>
            状态：<strong>{recordState}</strong>
          </StatusLine>
          <StatusLine>时长：{formatDuration(elapsedSec)}</StatusLine>
          <StatusLine>{statusMessage}</StatusLine>
          {showPermissionSettingsAction ? (
            <StatusActionButton type="button" onClick={handleOpenPermissionSettings}>
              打开系统权限设置
            </StatusActionButton>
          ) : null}
        </StatusCard> */}

        <ListWrap>
          <ListHeader>
            <SectionTitle>已录制视频</SectionTitle>
            <Button type="button" onClick={loadRecordings} disabled={isLoadingList || isBusy}>
              {isLoadingList ? '加载中...' : '刷新列表'}
            </Button>
          </ListHeader>

          <VideosGrid $hasItems={!isLoadingList && recordings.length > 0}>
            {isLoadingList ? (
              <EmptyState>正在加载录屏列表...</EmptyState>
            ) : recordings.length === 0 ? (
              <EmptyState>暂无录屏文件</EmptyState>
            ) : (
              <RecordingGrid>
                {recordings.map((item) => (
                  <RecordingVideoCard
                    key={item.path}
                    item={item}
                    onOpen={handleOpenRecording}
                    onReveal={handleRevealRecording}
                    onDelete={handleDeleteRecording}
                  />
                ))}
              </RecordingGrid>
            )}
          </VideosGrid>
        </ListWrap>
      </Page>

      <SourcePickerModal
        open={pickerOpen}
        loading={pickerLoading}
        sources={pickerSources}
        selectedSourceId={pickerSelectedSourceId}
        isBusy={isBusy}
        onSelect={setPickerSelectedSourceId}
        onCancel={handleCancelPicker}
        onConfirm={handleConfirmSourceAndStart}
      />
    </>
  )
}

export default App
