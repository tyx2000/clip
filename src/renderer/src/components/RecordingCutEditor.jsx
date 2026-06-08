import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import styled from 'styled-components'

const MIN_CLIP_DURATION = 0.2
const HISTORY_LIMIT = 80
const TIMELINE_ZOOM_MIN = 14
const TIMELINE_ZOOM_MAX = 90
const DEFAULT_EXPORT = {
  bitrate: 4_000_000,
  fps: 30,
  height: 0,
  width: 0
}

const TRACKS = [
  { id: 'video', label: '视频', kind: 'video' },
  { id: 'audio', label: '音频', kind: 'audio' },
  { id: 'image', label: '叠图', kind: 'image' },
  { id: 'text', label: '字幕', kind: 'text' }
]

const TOOLS = [
  { id: 'select', label: '选择', kind: 'video' },
  { id: 'split', label: '分割', kind: 'video' },
  { id: 'text', label: '文本', kind: 'text' },
  { id: 'image', label: '贴图', kind: 'image' },
  { id: 'audio', label: '音频', kind: 'audio' },
  { id: 'importVideo', label: '导入视频', kind: 'video' },
  { id: 'export', label: '导出', kind: 'video' }
]

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]

const Shell = styled.main`
  height: 100%;
  display: grid;
  grid-template-rows: minmax(0, 1fr) 318px;
  background: #111418;
  color: #f5f7fb;
`

const SubTitle = styled.p`
  margin: 0;
  color: #9aa4b2;
  font-size: 12px;
`

const IconButton = styled.button`
  width: 24px;
  height: 24px;
  min-width: 24px;
  border: 1px solid ${({ $active }) => ($active ? '#5aa7ff' : '#303743')};
  border-radius: 6px;
  padding: 0;
  background: ${({ $active, $primary }) =>
    $primary ? '#2f7df6' : $active ? '#1f3557' : '#20252d'};
  color: #f5f7fb;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;

  svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
`

const Workspace = styled.section`
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 318px;
  border-bottom: 1px solid #252b34;
`

const PreviewColumn = styled.section`
  min-height: 0;
  display: grid;
  grid-template-rows: 38px minmax(0, 1fr);
  background: #101318;
`

const PreviewHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px;
  border-bottom: 1px solid #252b34;
  color: #a9b2c0;
  font-size: 12px;
`

const PreviewStage = styled.div`
  min-height: 0;
  display: grid;
  place-items: center;
  padding: 14px;
  background:
    linear-gradient(45deg, #0c0f14 25%, transparent 25%),
    linear-gradient(-45deg, #0c0f14 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #0c0f14 75%),
    linear-gradient(-45deg, transparent 75%, #0c0f14 75%);
  background-color: #090b0f;
  background-position:
    0 0,
    0 10px,
    10px -10px,
    -10px 0;
  background-size: 20px 20px;
`

const PreviewFrame = styled.div`
  width: min(100%, 920px);
  aspect-ratio: 16 / 9;
  border: 1px solid #343c49;
  border-radius: 8px;
  background: #000000;
  overflow: hidden;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.36);
`

const Video = styled.video`
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000000;
`

const TimeCode = styled.span`
  color: #cbd3df;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  font-variant-numeric: tabular-nums;
  font-size: 14px;
  text-align: right;
  white-space: nowrap;
`

const Range = styled.input`
  width: 100%;
  accent-color: #4b9cff;
`

const Inspector = styled.aside`
  min-height: 0;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: 10px;
  padding: 12px;
  border-left: 1px solid #252b34;
  background: #15191f;
`

const Panel = styled.section`
  border: 1px solid #2a303a;
  border-radius: 8px;
  background: #1b2028;
  padding: 10px;
  display: grid;
  gap: 10px;
`

const PanelTitle = styled.h2`
  margin: 0;
  color: #f5f7fb;
  font-size: 13px;
  line-height: 1.2;
`

const FieldGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
`

const Field = styled.label`
  display: grid;
  gap: 5px;
  color: #a9b2c0;
  font-size: 11px;
`

const Input = styled.input`
  width: 100%;
  height: 30px;
  border: 1px solid #303743;
  border-radius: 7px;
  padding: 0 8px;
  background: #11161d;
  color: #f5f7fb;
`

const Select = styled.select`
  width: 100%;
  height: 30px;
  border: 1px solid #303743;
  border-radius: 7px;
  padding: 0 8px;
  background: #11161d;
  color: #f5f7fb;
`

const TodoList = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 7px;
  overflow: auto;
`

const TodoItem = styled.li`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: #a9b2c0;
  font-size: 12px;
`

const TodoState = styled.span`
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 2px 7px;
  background: ${({ $done }) => ($done ? '#163b2c' : '#352d1d')};
  color: ${({ $done }) => ($done ? '#8ce2b5' : '#f0c36a')};
  font-size: 11px;
`

const Timeline = styled.section`
  min-height: 0;
  display: grid;
  grid-template-rows: 36px 24px minmax(0, 1fr);
  background: #111418;
`

const TimelineTop = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 0 10px;
  border-bottom: 1px solid #252b34;
`

const TimelineActions = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
`

const TimelineEditActions = styled(TimelineActions)`
  justify-content: flex-end;
`

const TimelineTransport = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`

const ZoomLabel = styled.span`
  color: #a9b2c0;
  font-size: 12px;
`

const ToolAction = styled(IconButton)`
  width: 24px;
`

const HiddenInput = styled.input`
  display: none;
`

const RulerViewport = styled.div`
  overflow: hidden;
  border-bottom: 1px solid #252b34;
`

const Ruler = styled.div`
  position: relative;
  height: 24px;
  margin-left: 92px;
`

const Tick = styled.span`
  position: absolute;
  left: ${({ $left }) => `${$left}px`};
  top: 0;
  height: 24px;
  color: #7e8998;
  font-size: 10px;
  min-width: 48px;
  transform: translateX(-1px);
  white-space: nowrap;

  &::before {
    content: '';
    display: block;
    width: 1px;
    height: 8px;
    margin-bottom: 2px;
    background: #3a424f;
  }
`

const TrackViewport = styled.div`
  position: relative;
  overflow: auto;
`

const TrackContent = styled.div`
  position: relative;
  min-height: 100%;
  min-width: 100%;
`

const TrackRow = styled.div`
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  min-height: 56px;
  border-bottom: 1px solid #252b34;
`

const TrackLabel = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  border-right: 1px solid #252b34;
  background: #15191f;
  color: #a9b2c0;
  font-size: 12px;
  font-weight: 700;
`

const Lane = styled.div`
  position: relative;
  min-height: 56px;
  background: ${({ $kind }) =>
    $kind === 'video'
      ? '#121b25'
      : $kind === 'audio'
        ? '#111d19'
        : $kind === 'text'
          ? '#1a1825'
          : '#1c1a12'};
`

const Clip = styled.div`
  position: absolute;
  top: 8px;
  left: ${({ $left }) => `${$left}px`};
  width: ${({ $width }) => `${$width}px`};
  min-width: 28px;
  height: 40px;
  border: 1px solid ${({ $selected }) => ($selected ? '#ffffff' : 'rgba(255, 255, 255, 0.22)')};
  border-radius: 8px;
  background: ${({ $kind }) =>
    $kind === 'video'
      ? '#24598f'
      : $kind === 'audio'
        ? '#1f7a53'
        : $kind === 'text'
          ? '#6f4db7'
          : '#8a6a24'};
  box-shadow: ${({ $selected }) => ($selected ? '0 0 0 2px #4b9cff' : 'none')};
  cursor: grab;
  overflow: hidden;
  user-select: none;
`

const ClipThumbs = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  opacity: 0.82;
  pointer-events: none;
`

const ClipThumb = styled.img`
  width: 54px;
  height: 100%;
  object-fit: cover;
  flex: 0 0 auto;
`

const ClipLabel = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  color: #ffffff;
  font-size: 12px;
  font-weight: 700;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.48);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const EdgeHandle = styled.span`
  position: absolute;
  top: 0;
  bottom: 0;
  width: 14px;
  ${({ $side }) => ($side === 'left' ? 'left: 0;' : 'right: 0;')}
  cursor: ew-resize;
  background: linear-gradient(
    ${({ $side }) => ($side === 'left' ? '90deg' : '270deg')},
    rgba(255, 255, 255, 0.28),
    rgba(255, 255, 255, 0)
  );
  z-index: 2;
`

const Playhead = styled.div`
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--playhead-left, 92px);
  width: 12px;
  transform: translateX(-5px);
  background: transparent;
  cursor: ew-resize;
  pointer-events: auto;
  z-index: 10;

  &::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 5px;
    width: 2px;
    background: #ffdf5d;
    box-shadow: 0 0 12px rgba(255, 223, 93, 0.62);
  }
`

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function roundTime(value) {
  return Math.round(value * 100) / 100
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function cloneClips(clips) {
  return clips.map((clip) => ({ ...clip }))
}

function formatEditorTime(value) {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0
  const totalMilliseconds = Math.floor(safeValue * 1000)
  const milliseconds = totalMilliseconds % 1000
  const totalSeconds = Math.floor(totalMilliseconds / 1000)
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  const secondText = String(seconds).padStart(2, '0')
  const millisecondText = String(milliseconds).padStart(3, '0')

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${secondText}.${millisecondText}`
  }

  return `${String(minutes).padStart(2, '0')}:${secondText}.${millisecondText}`
}

function formatRulerTime(value) {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0
  const totalSeconds = Math.floor(safeValue)
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  const secondText = String(seconds).padStart(2, '0')

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${secondText}`
  }

  return `${String(minutes).padStart(2, '0')}:${secondText}`
}

function getTimelineEnd(clips, fallbackDuration) {
  return Math.max(
    fallbackDuration,
    1,
    ...clips.map((clip) => Number(clip.startTime || 0) + Number(clip.duration || 0))
  )
}

function applySeek(nextTime, { duration, onTimeChange, setCurrentTime, timelineDuration, video }) {
  const clamped = clamp(nextTime, 0, Math.max(duration, timelineDuration))

  onTimeChange?.(clamped)
  setCurrentTime(clamped)
  if (video) {
    video.currentTime = clamp(clamped, 0, duration || clamped)
  }
}

function getRulerStep(zoom) {
  const minStep = 88 / Math.max(zoom, 1)
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800]
  return steps.find((step) => step >= minStep) || 3600
}

function createVideoClip(duration, name) {
  return {
    duration,
    id: createId('video'),
    kind: 'video',
    label: name || 'Video',
    muted: false,
    sourceStart: 0,
    startTime: 0,
    trackId: 'video',
    volume: 1
  }
}

function ToolIcon({ toolId }) {
  if (toolId === 'image') {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="4" y="5" width="16" height="14" rx="2" />
        <circle cx="9" cy="10" r="1.5" />
        <path d="M5 17l4.2-4.2 3.2 3.2 2.1-2.1L19 18" />
      </svg>
    )
  }

  if (toolId === 'importVideo') {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="4" y="6" width="12" height="12" rx="2" />
        <path d="M16 10l4-2.5v9L16 14" />
        <path d="M9 9v6M6 12h6" />
      </svg>
    )
  }

  if (toolId === 'select') return '↖'
  if (toolId === 'split') return '✂'
  if (toolId === 'text') return 'T'
  if (toolId === 'audio') return '♪'
  return '⇩'
}

ToolIcon.propTypes = {
  toolId: PropTypes.string.isRequired
}

function RecordingCutEditor({ videoUrl, fileUrl, sourcePath, displayName }) {
  const videoRef = useRef(null)
  const playheadRef = useRef(null)
  const timeCodeRef = useRef(null)
  const dragRef = useRef(null)
  const scrubDragRef = useRef(null)
  const wasPlayingBeforeScrubRef = useRef(false)
  const audioInputRef = useRef(null)
  const videoInputRef = useRef(null)
  const objectVideoUrlRef = useRef('')
  const animationFrameRef = useRef(0)
  const currentTimeRef = useRef(0)
  const durationRef = useRef(0)
  const timelineDurationRef = useRef(1)
  const zoomRef = useRef(34)
  const [activeTool, setActiveTool] = useState('select')
  const [duration, setDuration] = useState(0)
  const [, setCurrentTime] = useState(0)
  const [clips, setClips] = useState([])
  const [selectedClipId, setSelectedClipId] = useState('')
  const [playbackRate, setPlaybackRate] = useState(1)
  const [volume, setVolume] = useState(1)
  const [zoom, setZoom] = useState(34)
  const [isPlaying, setIsPlaying] = useState(false)
  const [history, setHistory] = useState([])
  const [redoStack, setRedoStack] = useState([])
  const [thumbnails, setThumbnails] = useState([])
  const [thumbStatus, setThumbStatus] = useState('idle')
  const [exportSettings, setExportSettings] = useState(DEFAULT_EXPORT)
  const [exportStatus, setExportStatus] = useState('')
  const [playbackStatus, setPlaybackStatus] = useState('')
  const [mediaUrl, setMediaUrl] = useState(fileUrl || videoUrl)
  const [mediaName, setMediaName] = useState(displayName)

  const selectedClip = useMemo(
    () => clips.find((clip) => clip.id === selectedClipId) || null,
    [clips, selectedClipId]
  )
  const timelineDuration = getTimelineEnd(clips, duration)
  const timelineWidth = Math.max(820, Math.ceil(timelineDuration * zoom) + 160)

  const rulerTicks = useMemo(() => {
    const step = getRulerStep(zoom)
    const count = Math.ceil(timelineDuration / step) + 1
    return Array.from({ length: count }, (_, index) => {
      const time = index * step
      return {
        label: formatRulerTime(time),
        left: time * zoom
      }
    })
  }, [timelineDuration, zoom])

  const videoClips = useMemo(
    () => clips.filter((clip) => clip.kind === 'video').sort((a, b) => a.startTime - b.startTime),
    [clips]
  )

  function pushHistory(nextClips = clips) {
    setHistory((previous) => [...previous.slice(-HISTORY_LIMIT + 1), cloneClips(nextClips)])
    setRedoStack([])
  }

  function applyClips(updater, { record = true } = {}) {
    setClips((previous) => {
      const next = typeof updater === 'function' ? updater(previous) : updater
      if (record) {
        setHistory((historyValue) => [
          ...historyValue.slice(-HISTORY_LIMIT + 1),
          cloneClips(previous)
        ])
        setRedoStack([])
      }
      return next
    })
  }

  const ensureVideoClip = useEffectEvent((nextDuration, { resetTime = false } = {}) => {
    if (!(nextDuration > 0)) {
      return
    }

    const initialClip = createVideoClip(nextDuration, mediaName)
    const existingVideoClip = clips.find((clip) => clip.kind === 'video')
    durationRef.current = nextDuration
    setDuration(nextDuration)
    setClips((previous) => {
      const previousVideoClip = previous.find((clip) => clip.kind === 'video')
      if (!previousVideoClip) {
        return [initialClip, ...previous]
      }

      return previous.map((clip) =>
        clip.id === previousVideoClip.id
          ? {
              ...clip,
              duration: Math.max(clip.duration, nextDuration),
              label: clip.label || mediaName
            }
          : clip
      )
    })
    setSelectedClipId((selected) => selected || existingVideoClip?.id || initialClip.id)

    if (resetTime) {
      currentTimeRef.current = 0
      setCurrentTime(0)
      syncTimelineUi(0)
    } else {
      syncTimelineUi()
    }
  })

  function captureFallbackThumbnail() {
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) {
      return
    }

    try {
      const canvas = document.createElement('canvas')
      canvas.width = 128
      canvas.height = 72
      const context = canvas.getContext('2d')
      if (!context) {
        return
      }

      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      setThumbnails([
        { time: video.currentTime || 0, dataUrl: canvas.toDataURL('image/jpeg', 0.72) }
      ])
      setThumbStatus('fallback')
    } catch {
      // Canvas can fail for unsupported/cross-origin media; ffmpeg extraction remains primary.
    }
  }

  function syncTimelineUi(nextTime = currentTimeRef.current) {
    const safeTime = Math.max(0, Number(nextTime) || 0)
    currentTimeRef.current = safeTime

    if (timeCodeRef.current) {
      timeCodeRef.current.textContent = `${formatEditorTime(safeTime)} / ${formatEditorTime(
        durationRef.current
      )}`
    }

    if (playheadRef.current) {
      playheadRef.current.style.setProperty(
        '--playhead-left',
        `${safeTime * zoomRef.current + 92}px`
      )
    }
  }

  function stopTimelineAnimation() {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = 0
    }
  }

  useEffect(() => {
    document.title = `视频剪辑 - ${displayName}`
  }, [displayName])

  useEffect(() => {
    durationRef.current = duration
    timelineDurationRef.current = timelineDuration
    zoomRef.current = zoom
    syncTimelineUi()
  })

  useEffect(() => {
    return () => {
      stopTimelineAnimation()
      if (objectVideoUrlRef.current) {
        URL.revokeObjectURL(objectVideoUrlRef.current)
        objectVideoUrlRef.current = ''
      }
    }
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) {
      return undefined
    }

    const handleLoadedMetadata = () => {
      const nextDuration = Number.isFinite(video.duration) ? video.duration : 0
      if (nextDuration <= 0) {
        return
      }
      ensureVideoClip(nextDuration, { resetTime: true })
      setHistory([])
      setRedoStack([])
      window.setTimeout(captureFallbackThumbnail, 0)
    }
    const syncPlayingState = () => {
      setIsPlaying(!video.paused)
      if (!video.paused) {
        setPlaybackStatus('')
        stopTimelineAnimation()
        const tick = () => {
          if (!video || video.paused || video.ended) {
            animationFrameRef.current = 0
            syncTimelineUi(video.currentTime)
            return
          }

          syncTimelineUi(video.currentTime)
          animationFrameRef.current = requestAnimationFrame(tick)
        }
        animationFrameRef.current = requestAnimationFrame(tick)
      } else {
        stopTimelineAnimation()
        syncTimelineUi(video.currentTime)
      }
    }
    const handleMediaError = () => {
      const code = video.error?.code
      const message = video.error?.message || `媒体加载失败${code ? `(${code})` : ''}`
      if (mediaUrl === videoUrl && fileUrl && fileUrl !== videoUrl) {
        setMediaUrl(fileUrl)
        setPlaybackStatus('已切换到本地文件源')
        return
      }
      setPlaybackStatus(message)
    }

    video.addEventListener('loadedmetadata', handleLoadedMetadata)
    video.addEventListener('play', syncPlayingState)
    video.addEventListener('pause', syncPlayingState)
    video.addEventListener('ended', syncPlayingState)
    video.addEventListener('error', handleMediaError)
    if (video.readyState >= 1) {
      handleLoadedMetadata()
    }

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      video.removeEventListener('play', syncPlayingState)
      video.removeEventListener('pause', syncPlayingState)
      video.removeEventListener('ended', syncPlayingState)
      video.removeEventListener('error', handleMediaError)
    }
  }, [fileUrl, mediaName, mediaUrl, videoUrl])

  useEffect(() => {
    if (
      !sourcePath ||
      duration > 0 ||
      typeof window.api?.getRecordingEditorMediaInfo !== 'function'
    ) {
      return undefined
    }

    let cancelled = false
    window.api
      .getRecordingEditorMediaInfo({ path: sourcePath })
      .then((result) => {
        if (cancelled || !result?.ok || !(result.durationSec > 0)) {
          return
        }

        const nextDuration = Number(result.durationSec)
        ensureVideoClip(nextDuration, { resetTime: true })
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [duration, mediaName, sourcePath])

  useEffect(() => {
    const video = videoRef.current
    if (video) {
      video.playbackRate = playbackRate
    }
  }, [playbackRate])

  useEffect(() => {
    const video = videoRef.current
    if (video) {
      video.volume = volume
    }
  }, [volume])

  useEffect(() => {
    if (
      !sourcePath ||
      !duration ||
      mediaUrl.startsWith('blob:') ||
      typeof window.api?.extractRecordingEditorThumbnails !== 'function'
    ) {
      return undefined
    }

    let cancelled = false
    const frameCount = Math.min(14, Math.max(6, Math.ceil(duration / 4)))
    const times = Array.from({ length: frameCount }, (_, index) => {
      const ratio = frameCount === 1 ? 0 : index / (frameCount - 1)
      return Math.max(0, Math.min(duration - 0.05, duration * ratio))
    })

    const loadingTimer = window.setTimeout(() => {
      if (!cancelled) {
        setThumbStatus('loading')
      }
    }, 0)

    window.api
      .extractRecordingEditorThumbnails({ path: sourcePath, times, width: 128, height: 72 })
      .then((result) => {
        if (cancelled) {
          return
        }
        if (result?.ok) {
          setThumbnails(Array.isArray(result.thumbnails) ? result.thumbnails : [])
          setThumbStatus('ready')
        } else {
          setThumbStatus('failed')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThumbStatus('failed')
        }
      })

    return () => {
      cancelled = true
      window.clearTimeout(loadingTimer)
    }
  }, [duration, mediaUrl, sourcePath])

  useEffect(() => {
    const handleMove = (event) => {
      const scrubDrag = scrubDragRef.current
      if (scrubDrag) {
        const nextTime = (event.clientX - scrubDrag.left) / zoom
        applySeek(nextTime, {
          duration,
          onTimeChange: syncTimelineUi,
          setCurrentTime,
          timelineDuration,
          video: videoRef.current
        })
        return
      }

      const drag = dragRef.current
      if (!drag) {
        return
      }

      const deltaTime = (event.clientX - drag.clientX) / zoom
      setClips((previous) =>
        previous.map((clip) => {
          if (clip.id !== drag.clipId) {
            return clip
          }

          if (drag.mode === 'move') {
            return {
              ...clip,
              startTime: roundTime(Math.max(0, drag.startTime + deltaTime))
            }
          }

          if (drag.mode === 'trim-left') {
            const maxStart = drag.startTime + drag.duration - MIN_CLIP_DURATION
            const nextStart = clamp(drag.startTime + deltaTime, 0, maxStart)
            const trimDelta = nextStart - drag.startTime
            return {
              ...clip,
              duration: roundTime(Math.max(MIN_CLIP_DURATION, drag.duration - trimDelta)),
              sourceStart:
                drag.kind === 'video'
                  ? roundTime(Math.max(0, drag.sourceStart + trimDelta))
                  : drag.sourceStart,
              startTime: roundTime(nextStart)
            }
          }

          const sourceLimit =
            drag.kind === 'video'
              ? Math.max(MIN_CLIP_DURATION, duration - drag.sourceStart)
              : Math.max(MIN_CLIP_DURATION, timelineDuration + 60)
          const nextDuration = clamp(drag.duration + deltaTime, MIN_CLIP_DURATION, sourceLimit)
          return {
            ...clip,
            duration: roundTime(nextDuration)
          }
        })
      )
    }
    const handleEnd = () => {
      if (scrubDragRef.current && wasPlayingBeforeScrubRef.current) {
        videoRef.current?.play().catch(() => {})
      }
      dragRef.current = null
      scrubDragRef.current = null
      wasPlayingBeforeScrubRef.current = false
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)

    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
    }
  }, [duration, timelineDuration, zoom])

  function seekTo(nextTime) {
    applySeek(nextTime, {
      duration,
      onTimeChange: syncTimelineUi,
      setCurrentTime,
      timelineDuration,
      video: videoRef.current
    })
  }

  async function togglePlayback() {
    const video = videoRef.current
    if (!video) {
      return
    }

    if (video.paused) {
      if (duration > 0 && video.currentTime >= duration - 0.001) {
        seekTo(0)
      }
      setPlaybackStatus('')
      if (video.readyState < 2) {
        video.load()
      }
      try {
        await video.play()
      } catch (error) {
        const message = error instanceof Error ? error.message : '播放失败'
        setPlaybackStatus(message)
      }
      return
    }

    video.pause()
  }

  function startDrag(event, clip, mode) {
    event.preventDefault()
    event.stopPropagation()
    setSelectedClipId(clip.id)
    pushHistory(clips)
    dragRef.current = {
      clientX: event.clientX,
      clipId: clip.id,
      duration: clip.duration,
      kind: clip.kind,
      mode,
      sourceStart: clip.sourceStart || 0,
      startTime: clip.startTime
    }
  }

  function handleLanePointerDown(event) {
    const rect = event.currentTarget.getBoundingClientRect()
    seekTo((event.clientX - rect.left) / zoom)
  }

  function startPlayheadDrag(event) {
    event.preventDefault()
    event.stopPropagation()
    const video = videoRef.current
    wasPlayingBeforeScrubRef.current = Boolean(video && !video.paused)
    if (wasPlayingBeforeScrubRef.current) {
      video.pause()
    }
    const rect = event.currentTarget.parentElement.getBoundingClientRect()
    scrubDragRef.current = {
      left: rect.left + 92
    }
    seekTo((event.clientX - scrubDragRef.current.left) / zoom)
  }

  function addClip(kind) {
    const track = TRACKS.find((item) => item.kind === kind) || TRACKS[0]
    const time = currentTimeRef.current
    const clipDuration = kind === 'video' ? Math.min(4, Math.max(1, duration - time)) : 3
    const clip = {
      duration: Math.max(MIN_CLIP_DURATION, clipDuration),
      id: createId(kind),
      kind,
      label:
        kind === 'text' ? '字幕' : kind === 'image' ? '贴图' : kind === 'audio' ? '音频' : '视频',
      muted: false,
      sourceStart: kind === 'video' ? clamp(time, 0, duration) : 0,
      startTime: roundTime(time),
      trackId: track.id,
      volume: 1
    }

    applyClips((previous) => [...previous, clip])
    setSelectedClipId(clip.id)
  }

  function handleAudioFileSelected(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }

    const track = TRACKS.find((item) => item.kind === 'audio') || TRACKS[1]
    const clip = {
      duration: 3,
      id: createId('audio'),
      kind: 'audio',
      label: file.name || '音频',
      muted: false,
      sourceStart: 0,
      startTime: roundTime(currentTimeRef.current),
      trackId: track.id,
      volume: 1
    }

    applyClips((previous) => [...previous, clip])
    setSelectedClipId(clip.id)
  }

  function handleVideoFileSelected(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }

    if (objectVideoUrlRef.current) {
      URL.revokeObjectURL(objectVideoUrlRef.current)
    }

    const nextUrl = URL.createObjectURL(file)
    objectVideoUrlRef.current = nextUrl
    setPlaybackStatus('导入视频仅支持预览和时间线交互，导出暂未合并外部视频')
    setThumbnails([])
    setThumbStatus('todo')
    setMediaName(file.name || '导入视频')
    setMediaUrl(nextUrl)
    setActiveTool('select')
  }

  function handleToolAction(tool) {
    setActiveTool(tool.id)
    if (tool.id === 'importVideo') {
      videoInputRef.current?.click()
      return
    }

    if (tool.id === 'split') {
      splitSelectedClip()
      return
    }

    if (tool.id === 'audio') {
      audioInputRef.current?.click()
      return
    }

    if (tool.id === 'text' || tool.id === 'image') {
      addClip(tool.kind)
      return
    }

    if (tool.id === 'export') {
      exportCut()
    }
  }

  function splitSelectedClip() {
    if (!selectedClip) {
      return
    }

    const splitTime = currentTimeRef.current
    const clipStart = selectedClip.startTime
    const clipEnd = selectedClip.startTime + selectedClip.duration
    if (splitTime <= clipStart + MIN_CLIP_DURATION || splitTime >= clipEnd - MIN_CLIP_DURATION) {
      return
    }

    const leftDuration = splitTime - clipStart
    const rightDuration = clipEnd - splitTime
    const rightClip = {
      ...selectedClip,
      duration: roundTime(rightDuration),
      id: createId(selectedClip.kind),
      sourceStart: roundTime((selectedClip.sourceStart || 0) + leftDuration),
      startTime: roundTime(splitTime)
    }

    applyClips((previous) =>
      previous.flatMap((clip) => {
        if (clip.id !== selectedClip.id) {
          return clip
        }
        return [{ ...clip, duration: roundTime(leftDuration) }, rightClip]
      })
    )
    setSelectedClipId(rightClip.id)
  }

  function duplicateSelectedClip() {
    if (!selectedClip) {
      return
    }

    const duplicate = {
      ...selectedClip,
      id: createId(selectedClip.kind),
      label: `${selectedClip.label} copy`,
      startTime: roundTime(selectedClip.startTime + selectedClip.duration + 0.2)
    }

    applyClips((previous) => [...previous, duplicate])
    setSelectedClipId(duplicate.id)
  }

  function deleteSelectedClip() {
    if (!selectedClip) {
      return
    }

    applyClips((previous) => previous.filter((clip) => clip.id !== selectedClip.id))
    setSelectedClipId('')
  }

  function resetProject() {
    if (!duration) {
      return
    }

    const initialClip = createVideoClip(duration, mediaName)
    applyClips([initialClip])
    setSelectedClipId(initialClip.id)
    seekTo(0)
  }

  function undo() {
    if (!history.length) {
      return
    }

    const previous = history[history.length - 1]
    setRedoStack((stack) => [cloneClips(clips), ...stack])
    setHistory((stack) => stack.slice(0, -1))
    setClips(cloneClips(previous))
    setSelectedClipId(previous[0]?.id || '')
  }

  function redo() {
    if (!redoStack.length) {
      return
    }

    const next = redoStack[0]
    setHistory((stack) => [...stack, cloneClips(clips)])
    setRedoStack((stack) => stack.slice(1))
    setClips(cloneClips(next))
    setSelectedClipId(next[0]?.id || '')
  }

  function updateSelectedClip(patch) {
    if (!selectedClip) {
      return
    }

    applyClips((previous) =>
      previous.map((clip) => (clip.id === selectedClip.id ? { ...clip, ...patch } : clip))
    )
  }

  async function exportCut() {
    if (!sourcePath || typeof window.api?.exportRecordingEditorCut !== 'function') {
      setExportStatus('导出 TODO: 缺少主进程导出接口')
      return
    }

    if (!videoClips.length) {
      setExportStatus('没有可导出的视频片段')
      return
    }

    setExportStatus('导出中')
    const result = await window.api.exportRecordingEditorCut({
      path: sourcePath,
      clips: videoClips.map((clip) => ({
        duration: clip.duration,
        sourceStart: clip.sourceStart || 0,
        startTime: clip.startTime
      })),
      output: exportSettings
    })

    if (!result?.ok) {
      setExportStatus(result?.message || '导出失败')
      return
    }

    setExportStatus(`已导出 ${result.item?.name || result.outputPath || ''}`)
  }

  const activeToolMeta = TOOLS.find((tool) => tool.id === activeTool) || TOOLS[0]
  const selectedTrack = TRACKS.find((track) => track.id === selectedClip?.trackId)
  const timelineTools = TOOLS.filter((tool) => tool.id !== 'export')
  const capabilityState = [
    { done: true, label: '视频裁剪拼接' },
    { done: true, label: '时间线缩略图' },
    { done: true, label: '逐帧定位' },
    { done: false, label: '音频混音导出' },
    { done: false, label: '贴图/字幕烘焙' }
  ]

  return (
    <Shell>
      <HiddenInput
        ref={audioInputRef}
        type="file"
        accept="audio/*"
        onChange={handleAudioFileSelected}
      />
      <HiddenInput
        ref={videoInputRef}
        type="file"
        accept="video/*"
        onChange={handleVideoFileSelected}
      />
      <Workspace>
        <PreviewColumn>
          <PreviewHeader>
            <span>{activeToolMeta.label}</span>
            <span>
              {playbackStatus ||
                (selectedClip
                  ? `${selectedTrack?.label || ''} · ${selectedClip.label}`
                  : 'No selection')}
            </span>
          </PreviewHeader>
          <PreviewStage>
            <PreviewFrame>
              <Video ref={videoRef} src={mediaUrl} preload="auto" controls={false} />
            </PreviewFrame>
          </PreviewStage>
        </PreviewColumn>

        <Inspector>
          <Panel>
            <PanelTitle>属性</PanelTitle>
            <FieldGrid>
              <Field>
                开始
                <Input
                  type="number"
                  step="0.01"
                  value={selectedClip ? selectedClip.startTime : 0}
                  disabled={!selectedClip}
                  onChange={(event) =>
                    updateSelectedClip({ startTime: Math.max(0, Number(event.target.value) || 0) })
                  }
                />
              </Field>
              <Field>
                时长
                <Input
                  type="number"
                  step="0.01"
                  value={selectedClip ? selectedClip.duration : 0}
                  disabled={!selectedClip}
                  onChange={(event) =>
                    updateSelectedClip({
                      duration: Math.max(MIN_CLIP_DURATION, Number(event.target.value) || 0)
                    })
                  }
                />
              </Field>
              <Field>
                源起点
                <Input
                  type="number"
                  step="0.01"
                  value={selectedClip ? selectedClip.sourceStart || 0 : 0}
                  disabled={!selectedClip || selectedClip.kind !== 'video'}
                  onChange={(event) =>
                    updateSelectedClip({
                      sourceStart: Math.max(0, Number(event.target.value) || 0)
                    })
                  }
                />
              </Field>
              <Field>
                音量
                <Input
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  value={selectedClip ? selectedClip.volume : 1}
                  disabled={!selectedClip}
                  onChange={(event) =>
                    updateSelectedClip({ volume: clamp(Number(event.target.value) || 0, 0, 1) })
                  }
                />
              </Field>
            </FieldGrid>
          </Panel>

          <Panel>
            <PanelTitle>预览</PanelTitle>
            <FieldGrid>
              <Field>
                倍速
                <Select
                  value={String(playbackRate)}
                  onChange={(event) => setPlaybackRate(Number(event.target.value))}
                >
                  {SPEED_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}x
                    </option>
                  ))}
                </Select>
              </Field>
              <Field>
                主音量
                <Input
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={(event) => setVolume(clamp(Number(event.target.value) || 0, 0, 1))}
                />
              </Field>
            </FieldGrid>
            <Range
              type="range"
              min={TIMELINE_ZOOM_MIN}
              max={TIMELINE_ZOOM_MAX}
              step="1"
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
            />
          </Panel>

          <Panel>
            <PanelTitle>导出</PanelTitle>
            <FieldGrid>
              <Field>
                FPS
                <Input
                  type="number"
                  value={exportSettings.fps}
                  onChange={(event) =>
                    setExportSettings((settings) => ({
                      ...settings,
                      fps: Number(event.target.value) || 30
                    }))
                  }
                />
              </Field>
              <Field>
                Mbps
                <Input
                  type="number"
                  value={Math.round(exportSettings.bitrate / 1_000_000)}
                  onChange={(event) =>
                    setExportSettings((settings) => ({
                      ...settings,
                      bitrate: Math.max(1, Number(event.target.value) || 4) * 1_000_000
                    }))
                  }
                />
              </Field>
            </FieldGrid>
            <SubTitle>{exportStatus || `Thumbnails: ${thumbStatus}`}</SubTitle>
            <TodoList>
              {capabilityState.map((item) => (
                <TodoItem key={item.label}>
                  <span>{item.label}</span>
                  <TodoState $done={item.done}>{item.done ? 'ready' : 'todo'}</TodoState>
                </TodoItem>
              ))}
            </TodoList>
          </Panel>
        </Inspector>
      </Workspace>

      <Timeline>
        <TimelineTop>
          <TimelineActions>
            {timelineTools.map((tool) => (
              <ToolAction
                key={tool.id}
                type="button"
                title={tool.label}
                $active={tool.id === activeTool}
                onClick={() => handleToolAction(tool)}
              >
                <ToolIcon toolId={tool.id} />
              </ToolAction>
            ))}
          </TimelineActions>
          <TimelineTransport>
            <IconButton
              type="button"
              title={isPlaying ? '暂停' : '播放'}
              $primary
              onClick={togglePlayback}
            >
              {isPlaying ? 'Ⅱ' : '▶'}
            </IconButton>
            <TimeCode ref={timeCodeRef}>
              {formatEditorTime(0)} / {formatEditorTime(durationRef.current)}
            </TimeCode>
          </TimelineTransport>
          <TimelineEditActions>
            <IconButton type="button" title="Undo" onClick={undo} disabled={!history.length}>
              ↶
            </IconButton>
            <IconButton type="button" title="Redo" onClick={redo} disabled={!redoStack.length}>
              ↷
            </IconButton>
            <IconButton
              type="button"
              title="Duplicate"
              onClick={duplicateSelectedClip}
              disabled={!selectedClip}
            >
              ⧉
            </IconButton>
            <IconButton
              type="button"
              title="Delete"
              onClick={deleteSelectedClip}
              disabled={!selectedClip}
            >
              ⌫
            </IconButton>
            <IconButton type="button" title="Reset" onClick={resetProject}>
              ↺
            </IconButton>
            <IconButton type="button" title="Export" $primary onClick={exportCut}>
              ⇩
            </IconButton>
            <ZoomLabel>{Math.round(zoom)} px/s</ZoomLabel>
          </TimelineEditActions>
        </TimelineTop>

        <RulerViewport>
          <Ruler style={{ width: timelineWidth }}>
            {rulerTicks.map((tick) => (
              <Tick key={`${tick.left}-${tick.label}`} $left={tick.left}>
                {tick.label}
              </Tick>
            ))}
          </Ruler>
        </RulerViewport>

        <TrackViewport>
          <TrackContent style={{ width: timelineWidth + 92 }}>
            <Playhead ref={playheadRef} onPointerDown={startPlayheadDrag} />
            {TRACKS.map((track) => (
              <TrackRow key={track.id}>
                <TrackLabel>{track.label}</TrackLabel>
                <Lane $kind={track.kind} onPointerDown={handleLanePointerDown}>
                  {clips
                    .filter((clip) => clip.trackId === track.id)
                    .map((clip) => {
                      const left = clip.startTime * zoom
                      const width = Math.max(28, clip.duration * zoom)
                      const selected = clip.id === selectedClipId
                      return (
                        <Clip
                          key={clip.id}
                          $kind={clip.kind}
                          $left={left}
                          $selected={selected}
                          $width={width}
                          title={clip.label}
                          onPointerDown={(event) => startDrag(event, clip, 'move')}
                        >
                          {clip.kind === 'video' && thumbnails.length > 0 ? (
                            <ClipThumbs>
                              {thumbnails.map((thumb) => (
                                <ClipThumb
                                  key={thumb.time}
                                  src={thumb.dataUrl}
                                  alt=""
                                  draggable={false}
                                />
                              ))}
                            </ClipThumbs>
                          ) : null}
                          <EdgeHandle
                            $side="left"
                            onPointerDown={(event) => startDrag(event, clip, 'trim-left')}
                          />
                          <ClipLabel>
                            {clip.kind === 'video'
                              ? '▣'
                              : clip.kind === 'audio'
                                ? '♪'
                                : clip.kind === 'text'
                                  ? 'T'
                                  : '□'}{' '}
                            {clip.label}
                          </ClipLabel>
                          <EdgeHandle
                            $side="right"
                            onPointerDown={(event) => startDrag(event, clip, 'trim-right')}
                          />
                        </Clip>
                      )
                    })}
                </Lane>
              </TrackRow>
            ))}
          </TrackContent>
        </TrackViewport>
      </Timeline>
    </Shell>
  )
}

RecordingCutEditor.propTypes = {
  displayName: PropTypes.string.isRequired,
  fileUrl: PropTypes.string,
  sourcePath: PropTypes.string.isRequired,
  videoUrl: PropTypes.string.isRequired
}

RecordingCutEditor.defaultProps = {
  fileUrl: ''
}

export default RecordingCutEditor
