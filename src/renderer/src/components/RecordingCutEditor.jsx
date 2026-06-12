import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import styled from 'styled-components'
import {
  DEFAULT_VIDEO_TRANSITION_SECONDS,
  MEDIA_TOOLS,
  MIN_CLIP_DURATION,
  TIMELINE_ZOOM_DEFAULT,
  TRACK_GUTTER_WIDTH
} from './cut-editor/constants'
import {
  applySeek,
  clamp,
  createVideoClip,
  findVideoClipAtTime,
  formatEditorTime,
  formatExportProgress,
  formatRulerTime,
  getAvailableTrackId,
  getClipSourceEnd,
  getClipThumbnails,
  getPreviewOverlaySignature,
  getRulerStep,
  getTimelineEnd,
  getTimelineTracks,
  getVideoTransitionAtTime,
  getVisiblePreviewClips,
  hasTrackOverlap,
  isClipActiveAtTime
} from './cut-editor/timelineModel'
import { duplicateClip, splitClipAtTime } from './cut-editor/clipFactory'
import { ExportDialog } from './cut-editor/ExportDialog'
import { InspectorPanel } from './cut-editor/InspectorPanel'
import { PreviewPane } from './cut-editor/PreviewPane'
import { TimelinePanel } from './cut-editor/TimelinePanel'
import { useClipActions } from './cut-editor/hooks/useClipActions'
import { useClipHistory } from './cut-editor/hooks/useClipHistory'
import { useExportCut } from './cut-editor/hooks/useExportCut'
import { useLayoutResizeDrag } from './cut-editor/hooks/useLayoutResizeDrag'
import { useOverlayDrag } from './cut-editor/hooks/useOverlayDrag'
import { usePointerInteraction } from './cut-editor/hooks/usePointerInteraction'
import { useProjectPersistence } from './cut-editor/hooks/useProjectPersistence'
import { useTimelineClipDrag } from './cut-editor/hooks/useTimelineClipDrag'
import { useTimelineScrubDrag } from './cut-editor/hooks/useTimelineScrubDrag'

const Shell = styled.main`
  --timeline-height: ${({ $timelineHeight }) => `${$timelineHeight}px`};
  height: 100%;
  display: grid;
  grid-template-rows: minmax(0, 1fr) 7px var(--timeline-height);
  background: #111418;
  color: #f5f7fb;
`

const Workspace = styled.section`
  position: relative;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  border-bottom: 1px solid #252b34;
  overflow: hidden;
`

const HiddenInput = styled.input`
  display: none;
`

const InspectorDock = styled.div`
  position: fixed;
  top: 0;
  right: 0;
  bottom: calc(var(--timeline-height) + 7px);
  width: 28px;
  z-index: 80;

  .inspector-panel {
    position: absolute;
    top: 50%;
    right: 12px;
    width: 278px;
    transform: translate(calc(100% + 24px), -50%);
    opacity: 0;
    pointer-events: none;
    transition:
      transform 180ms ease,
      opacity 180ms ease;
  }

  &:hover .inspector-panel,
  &:focus-within .inspector-panel {
    transform: translate(0, -50%);
    opacity: 1;
    pointer-events: auto;
  }
`

function roundInspectorTime(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000
}

function RecordingCutEditor({ videoUrl, fileUrl, sourcePath, displayName }) {
  const videoRef = useRef(null)
  const videoShellRef = useRef(null)
  const playheadRef = useRef(null)
  const rulerViewportRef = useRef(null)
  const trackViewportRef = useRef(null)
  const timeCodeRef = useRef(null)
  const audioInputRef = useRef(null)
  const imageInputRef = useRef(null)
  const videoInputRef = useRef(null)
  const objectVideoUrlRef = useRef('')
  const objectAssetUrlsRef = useRef(new Set())
  const audioElementsRef = useRef(new Map())
  const visibleOverlayKeyRef = useRef('')
  const activeVideoClipIdRef = useRef('')
  const previewVideoVisibleRef = useRef(true)
  const timelinePlaybackRef = useRef({ startedAt: 0, startTime: 0 })
  const mediaMetadataInitializedRef = useRef(false)
  const projectRestoredRef = useRef(false)
  const isTimelinePlayingRef = useRef(false)
  const animationFrameRef = useRef(0)
  const currentTimeRef = useRef(0)
  const durationRef = useRef(0)
  const timelineDurationRef = useRef(1)
  const zoomRef = useRef(TIMELINE_ZOOM_DEFAULT)
  const playbackRateRef = useRef(1)
  const volumeRef = useRef(1)
  const clipsRef = useRef([])
  const selectedClipIdRef = useRef('')
  const videoClipsRef = useRef([])
  const [, setActiveTool] = useState('')
  const [duration, setDuration] = useState(0)
  const [, setCurrentTime] = useState(0)
  const [clips, setClips] = useState([])
  const [selectedClipId, setSelectedClipId] = useState('')
  const [playbackRate, setPlaybackRate] = useState(1)
  const [volume, setVolume] = useState(1)
  const [zoom, setZoom] = useState(TIMELINE_ZOOM_DEFAULT)
  const [isPlaying, setIsPlaying] = useState(false)
  const [thumbnails, setThumbnails] = useState([])
  const [, setThumbStatus] = useState('idle')
  const [, setPlaybackStatus] = useState('')
  const [mediaUrl, setMediaUrl] = useState(fileUrl || videoUrl)
  const [mediaName] = useState(displayName)
  const [isPreviewVideoVisible, setIsPreviewVideoVisible] = useState(true)
  const [visiblePreviewClips, setVisiblePreviewClips] = useState([])
  const [centerGuides, setCenterGuides] = useState({ x: false, y: false })
  const [timelineDragPreview, setTimelineDragPreview] = useState(null)
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false)
  const [timelineHeight, setTimelineHeight] = useState(() =>
    typeof window === 'undefined' ? 260 : Math.max(220, Math.round(window.innerHeight * 0.34))
  )
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
  const {
    exportCut,
    exportProgress,
    exportSettings,
    exportStatus,
    isExporting,
    setExportSettings
  } = useExportCut({
    clips,
    sourcePath,
    timelineDuration,
    videoClips
  })
  const timelineTracks = useMemo(() => getTimelineTracks(clips), [clips])
  const draggedTimelineClip = useMemo(
    () =>
      timelineDragPreview ? clips.find((clip) => clip.id === timelineDragPreview.clipId) : null,
    [clips, timelineDragPreview]
  )
  const clipsByTrackId = useMemo(() => {
    const nextClipsByTrackId = new Map()
    for (const clip of clips) {
      const trackClips = nextClipsByTrackId.get(clip.trackId) || []
      trackClips.push(clip)
      nextClipsByTrackId.set(clip.trackId, trackClips)
    }
    return nextClipsByTrackId
  }, [clips])
  const clipThumbnailsById = useMemo(() => {
    const nextClipThumbnailsById = new Map()
    for (const clip of clips) {
      nextClipThumbnailsById.set(clip.id, getClipThumbnails(clip, thumbnails))
    }
    return nextClipThumbnailsById
  }, [clips, thumbnails])
  const { clearLayoutResizeDrag, moveLayoutResizeDrag, startLayoutResizeDrag } =
    useLayoutResizeDrag({
      setTimelineHeight,
      timelineHeight
    })
  const { completeScrubDrag, moveScrubDrag, startPlayheadScrub, startRulerScrub } =
    useTimelineScrubDrag({
      getCurrentTime: () => currentTimeRef.current,
      isPlaying,
      pauseTimelinePlayback,
      seekTo,
      startTimelinePlayback,
      zoom
    })
  const { applyClips, clearHistory, history, pushHistory, redo, redoStack, undo } = useClipHistory({
    clipsRef,
    selectedClipIdRef,
    setClips,
    setSelectedClipId
  })
  const { addClip, handleAudioFileSelected, handleImageFileSelected, handleVideoFileSelected } =
    useClipActions({
      applyClips,
      clipsRef,
      currentTimeRef,
      duration,
      objectAssetUrlsRef,
      setActiveTool,
      setPlaybackStatus,
      setSelectedClipId
    })
  const { completeOverlayDrag, moveOverlayDrag, startImageResize, startOverlayDrag } =
    useOverlayDrag({
      clipsRef,
      pushHistory,
      selectClipAndReveal,
      selectedClipIdRef,
      setCenterGuides,
      setClips
    })
  const { completeTimelineClipDrag, moveTimelineClipDrag, startDrag } = useTimelineClipDrag({
    applyClips,
    clips,
    clipsRef,
    duration,
    pushHistory,
    setClips,
    setSelectedClipId,
    setTimelineDragPreview,
    timelineDuration,
    trackViewportRef,
    zoom,
    zoomRef
  })
  useProjectPersistence({
    clips,
    duration,
    exportSettings,
    projectRestoredRef,
    setClips,
    setExportSettings,
    setPlaybackStatus,
    setSelectedClipId,
    sourcePath
  })

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

  function getAudioElement(clip) {
    if (!clip.sourceUrl) {
      return null
    }

    const existing = audioElementsRef.current.get(clip.id)
    if (existing?.src === clip.sourceUrl) {
      return existing
    }

    existing?.pause()
    const audio = new Audio(clip.sourceUrl)
    audio.preload = 'auto'
    audioElementsRef.current.set(clip.id, audio)
    return audio
  }

  function getVideoClipSource(clip) {
    return clip?.sourceUrl || mediaUrl
  }

  function setPreviewVideoVisible(nextVisible) {
    if (previewVideoVisibleRef.current === nextVisible) {
      return
    }

    previewVideoVisibleRef.current = nextVisible
    setIsPreviewVideoVisible(nextVisible)
  }

  function stopAllAudio() {
    for (const audio of audioElementsRef.current.values()) {
      audio.pause()
    }
  }

  function syncVideoPlayback(time, playing = false) {
    const video = videoRef.current
    const videoShell = videoShellRef.current
    if (!video) {
      return
    }

    const clip = findVideoClipAtTime(videoClipsRef.current, time)
    if (!clip) {
      activeVideoClipIdRef.current = ''
      video.pause()
      if (videoShell) {
        videoShell.style.opacity = '0'
        videoShell.style.transform = 'none'
      }
      setPreviewVideoVisible(false)
      return
    }

    const sourceUrl = getVideoClipSource(clip)
    if (video.dataset.sourceUrl !== sourceUrl) {
      video.pause()
      video.src = sourceUrl
      video.dataset.sourceUrl = sourceUrl
      activeVideoClipIdRef.current = ''
    }

    const sourceTime = clamp(
      Number(clip.sourceStart || 0) + (time - clip.startTime),
      Number(clip.sourceStart || 0),
      Math.max(Number(clip.sourceStart || 0), getClipSourceEnd(clip) - 0.033)
    )
    const enteredClip = activeVideoClipIdRef.current !== clip.id
    activeVideoClipIdRef.current = clip.id
    setPreviewVideoVisible(true)
    const videoTransition = getVideoTransitionAtTime(clip, time)
    if (videoShell) {
      videoShell.style.opacity = String(videoTransition.opacity)
      videoShell.style.transform = videoTransition.transform
    }
    video.playbackRate = playbackRateRef.current
    video.volume = volumeRef.current

    const seekThreshold = playing ? 0.12 : 0.03
    if (enteredClip || Math.abs(video.currentTime - sourceTime) > seekThreshold) {
      if (typeof video.fastSeek === 'function') {
        video.fastSeek(sourceTime)
      } else {
        video.currentTime = sourceTime
      }
    }

    if (playing && video.paused) {
      video.play().catch((error) => {
        const message = error instanceof Error ? error.message : '播放失败'
        setPlaybackStatus(message)
      })
    } else if (!playing) {
      video.pause()
    }
  }

  function syncPreviewOverlays(time) {
    const overlays = getVisiblePreviewClips(clipsRef.current, time)
    const overlayKey = getPreviewOverlaySignature(overlays)
    if (overlayKey === visibleOverlayKeyRef.current) {
      return
    }

    visibleOverlayKeyRef.current = overlayKey
    setVisiblePreviewClips(overlays)
  }

  function syncAudioPlayback(time, playing = isTimelinePlayingRef.current) {
    let hasActiveAudio = false

    for (const clip of clipsRef.current) {
      if (clip.kind !== 'audio' || !clip.sourceUrl) {
        continue
      }

      const audio = getAudioElement(clip)
      if (!audio) {
        continue
      }

      const active = isClipActiveAtTime(clip, time)
      if (!active || clip.muted) {
        audio.pause()
        continue
      }

      hasActiveAudio = true
      const sourceTime = Number(clip.sourceStart || 0) + (time - clip.startTime)
      audio.volume = clamp(Number(clip.volume ?? 1) * volumeRef.current, 0, 1)
      audio.playbackRate = playbackRateRef.current
      if (Math.abs(audio.currentTime - sourceTime) > 0.08 || audio.paused) {
        audio.currentTime = Math.max(0, sourceTime)
      }

      if (playing && audio.paused) {
        audio.play().catch(() => {
          setPlaybackStatus('音频预览播放失败')
        })
      } else if (!playing) {
        audio.pause()
      }
    }

    if (!hasActiveAudio && !playing) {
      stopAllAudio()
    }
  }

  function handleTimelineScroll(event) {
    if (rulerViewportRef.current) {
      rulerViewportRef.current.scrollLeft = event.currentTarget.scrollLeft
    }
  }

  function syncTimelineChrome(nextTime = currentTimeRef.current) {
    const safeTime = Math.max(0, Number(nextTime) || 0)
    currentTimeRef.current = safeTime
    const playheadLeft = safeTime * zoomRef.current + TRACK_GUTTER_WIDTH

    if (timeCodeRef.current) {
      timeCodeRef.current.textContent = `${formatEditorTime(safeTime)} / ${formatEditorTime(
        timelineDurationRef.current
      )}`
    }

    if (playheadRef.current) {
      playheadRef.current.style.setProperty('--playhead-left', `${playheadLeft}px`)
    }

    return safeTime
  }

  function syncTimelineUi(
    nextTime = currentTimeRef.current,
    { playing = isTimelinePlayingRef.current } = {}
  ) {
    const safeTime = syncTimelineChrome(nextTime)
    syncPreviewOverlays(safeTime)
    syncVideoPlayback(safeTime, playing)
    syncAudioPlayback(safeTime, playing)
  }

  function stopTimelineAnimation() {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = 0
    }
  }

  function pauseTimelinePlayback() {
    stopTimelineAnimation()
    isTimelinePlayingRef.current = false
    setIsPlaying(false)
    syncTimelineUi(currentTimeRef.current, { playing: false })
  }

  function startTimelinePlayback(startTime = currentTimeRef.current) {
    const safeStart = startTime >= timelineDurationRef.current ? 0 : Math.max(0, startTime)
    timelinePlaybackRef.current = {
      startedAt: performance.now(),
      startTime: safeStart
    }
    isTimelinePlayingRef.current = true
    setIsPlaying(true)
    setPlaybackStatus('')
    stopTimelineAnimation()

    const tick = (now) => {
      const elapsed =
        ((now - timelinePlaybackRef.current.startedAt) / 1000) * playbackRateRef.current
      const nextTime = Math.min(
        timelineDurationRef.current,
        timelinePlaybackRef.current.startTime + elapsed
      )
      syncTimelineUi(nextTime, { playing: true })

      if (nextTime >= timelineDurationRef.current - 0.001) {
        pauseTimelinePlayback()
        syncTimelineUi(timelineDurationRef.current, { playing: false })
        return
      }

      animationFrameRef.current = requestAnimationFrame(tick)
    }

    syncTimelineUi(safeStart, { playing: true })
    animationFrameRef.current = requestAnimationFrame(tick)
  }

  useEffect(() => {
    document.title = `视频剪辑 - ${displayName}`
  }, [displayName])

  useEffect(() => {
    durationRef.current = duration
    timelineDurationRef.current = timelineDuration
    zoomRef.current = zoom
    playbackRateRef.current = playbackRate
    volumeRef.current = volume
    clipsRef.current = clips
    selectedClipIdRef.current = selectedClipId
    videoClipsRef.current = videoClips
    syncTimelineChrome(currentTimeRef.current, { playing: isTimelinePlayingRef.current })
  })

  useEffect(() => {
    const objectAssetUrls = objectAssetUrlsRef.current
    return () => {
      stopTimelineAnimation()
      stopAllAudio()
      for (const assetUrl of objectAssetUrls) {
        URL.revokeObjectURL(assetUrl)
      }
      if (objectVideoUrlRef.current) {
        URL.revokeObjectURL(objectVideoUrlRef.current)
        objectVideoUrlRef.current = ''
      }
    }
  }, [])

  useEffect(() => {
    const clampTimelineHeight = () => {
      setTimelineHeight((height) =>
        clamp(height, 180, Math.max(180, Math.round(window.innerHeight * 0.6)))
      )
    }

    window.addEventListener('resize', clampTimelineHeight)
    clampTimelineHeight()

    return () => {
      window.removeEventListener('resize', clampTimelineHeight)
    }
  }, [])

  useEffect(() => {
    const clipIds = new Set(clips.map((clip) => clip.id))
    for (const [clipId, audio] of audioElementsRef.current.entries()) {
      if (!clipIds.has(clipId)) {
        audio.pause()
        audioElementsRef.current.delete(clipId)
      }
    }
    syncTimelineUi(currentTimeRef.current, { playing: isTimelinePlayingRef.current })
    // syncTimelineUi reads refs intentionally; adding it would re-run this cleanup sync every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips])

  useEffect(() => {
    const video = videoRef.current
    if (!video) {
      return undefined
    }

    const handleLoadedMetadata = () => {
      if (video.currentSrc && video.currentSrc !== mediaUrl) {
        return
      }
      if (mediaMetadataInitializedRef.current) {
        return
      }
      const nextDuration = Number.isFinite(video.duration) ? video.duration : 0
      if (nextDuration <= 0) {
        return
      }
      mediaMetadataInitializedRef.current = true
      ensureVideoClip(nextDuration, { resetTime: true })
      clearHistory()
      window.setTimeout(captureFallbackThumbnail, 0)
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
    video.addEventListener('error', handleMediaError)
    if (video.readyState >= 1) {
      handleLoadedMetadata()
    }

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      video.removeEventListener('error', handleMediaError)
    }
  }, [clearHistory, fileUrl, mediaName, mediaUrl, videoUrl])

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
        mediaMetadataInitializedRef.current = true
        ensureVideoClip(nextDuration, { resetTime: true })
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [duration, mediaName, sourcePath])

  useEffect(() => {
    playbackRateRef.current = playbackRate
    if (isTimelinePlayingRef.current) {
      timelinePlaybackRef.current = {
        startedAt: performance.now(),
        startTime: currentTimeRef.current
      }
    }

    const video = videoRef.current
    if (video) {
      video.playbackRate = playbackRate
    }
    syncAudioPlayback(currentTimeRef.current)
    // syncAudioPlayback reads live refs and should not cause media effect rebinding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackRate])

  useEffect(() => {
    volumeRef.current = volume
    const video = videoRef.current
    if (video) {
      video.volume = volume
    }
    syncAudioPlayback(currentTimeRef.current)
    // syncAudioPlayback reads live refs and should not cause media effect rebinding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  function completePointerDrag(event) {
    completeScrubDrag()
    completeTimelineClipDrag(event)
    completeOverlayDrag(event)
    clearLayoutResizeDrag()
  }

  function handleGlobalPointerMove(event) {
    if (moveLayoutResizeDrag(event)) {
      return
    }

    if (moveOverlayDrag(event)) {
      return
    }

    if (moveScrubDrag(event)) {
      return
    }

    moveTimelineClipDrag(event)
  }

  function handleGlobalPointerEnd(event) {
    completePointerDrag(event)
  }

  usePointerInteraction({
    onPointerCancel: handleGlobalPointerEnd,
    onPointerMove: handleGlobalPointerMove,
    onPointerUp: handleGlobalPointerEnd
  })

  function seekTo(nextTime) {
    applySeek(nextTime, {
      onTimeChange: syncTimelineUi,
      setCurrentTime,
      timelineDuration
    })
  }

  function revealTimelineClip(clipId) {
    window.requestAnimationFrame(() => {
      const viewport = trackViewportRef.current
      const clipElement = viewport?.querySelector(`[data-clip-id="${clipId}"]`)
      if (!viewport || !clipElement) {
        return
      }

      const viewportRect = viewport.getBoundingClientRect()
      const clipRect = clipElement.getBoundingClientRect()
      const nextScrollLeft =
        clipRect.left < viewportRect.left + 48
          ? viewport.scrollLeft - (viewportRect.left + 48 - clipRect.left)
          : clipRect.right > viewportRect.right - 48
            ? viewport.scrollLeft + (clipRect.right - (viewportRect.right - 48))
            : viewport.scrollLeft
      const nextScrollTop =
        clipRect.top < viewportRect.top + 12
          ? viewport.scrollTop - (viewportRect.top + 12 - clipRect.top)
          : clipRect.bottom > viewportRect.bottom - 12
            ? viewport.scrollTop + (clipRect.bottom - (viewportRect.bottom - 12))
            : viewport.scrollTop

      viewport.scrollTo({
        left: Math.max(0, nextScrollLeft),
        top: Math.max(0, nextScrollTop),
        behavior: 'smooth'
      })
    })
  }

  function selectClipAndReveal(clipId) {
    if (!clipId) {
      return
    }

    setSelectedClipId(clipId)
    revealTimelineClip(clipId)
  }

  function selectActiveVideoClipFromPreview(event) {
    event.preventDefault()
    event.stopPropagation()
    const activeVideoClip = findVideoClipAtTime(videoClipsRef.current, currentTimeRef.current)
    if (activeVideoClip) {
      selectClipAndReveal(activeVideoClip.id)
    }
  }

  function togglePlayback() {
    if (isPlaying) {
      pauseTimelinePlayback()
      return
    }

    startTimelinePlayback(currentTimeRef.current)
  }

  function handleLanePointerDown(event) {
    const rect = event.currentTarget.getBoundingClientRect()
    seekTo((event.clientX - rect.left) / zoom)
  }

  function handleMediaToolAction(tool) {
    setActiveTool(tool.id)
    if (tool.id === 'importVideo') {
      videoInputRef.current?.click()
      return
    }

    if (tool.id === 'audio') {
      audioInputRef.current?.click()
      return
    }

    if (tool.id === 'image') {
      imageInputRef.current?.click()
      return
    }

    if (tool.id === 'text') {
      addClip(tool.kind)
    }
  }

  function handleExportButtonClick() {
    if (isExporting) {
      exportCut()
      return
    }

    setIsExportDialogOpen(true)
  }

  function confirmExport() {
    setIsExportDialogOpen(false)
    exportCut()
  }

  function splitSelectedClip() {
    if (!selectedClip) {
      return
    }

    const splitResult = splitClipAtTime(selectedClip, currentTimeRef.current)
    if (!splitResult) {
      return
    }

    applyClips((previous) =>
      previous.flatMap((clip) => {
        if (clip.id !== selectedClip.id) {
          return clip
        }
        return [splitResult.leftClip, splitResult.rightClip]
      })
    )
    setSelectedClipId(splitResult.rightClip.id)
  }

  function duplicateSelectedClip() {
    if (!selectedClip) {
      return
    }

    const duplicate = duplicateClip(selectedClip)

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

    const confirmed = window.confirm(
      '重置会清空当前所有剪辑、素材和轨道，恢复为原始视频并跳回开头。是否继续？'
    )
    if (!confirmed) {
      return
    }

    const initialClip = createVideoClip(duration, mediaName)
    applyClips([initialClip])
    setSelectedClipId(initialClip.id)
    seekTo(0)
  }

  function updateSelectedClip(patch) {
    if (!selectedClip) {
      return
    }

    applyClips((previous) =>
      previous.map((clip) => (clip.id === selectedClip.id ? { ...clip, ...patch } : clip))
    )

    if (
      selectedClip.kind === 'video' &&
      Object.keys(patch).some((key) => key.startsWith('videoInTransition'))
    ) {
      const transitionSeconds =
        Number(patch.videoInTransitionSeconds) ||
        selectedClip.videoInTransitionSeconds ||
        DEFAULT_VIDEO_TRANSITION_SECONDS
      seekTo(selectedClip.startTime + Math.min(selectedClip.duration / 2, transitionSeconds / 2))
    } else if (
      selectedClip.kind === 'video' &&
      Object.keys(patch).some((key) => key.startsWith('videoOutTransition'))
    ) {
      const transitionSeconds =
        Number(patch.videoOutTransitionSeconds) ||
        selectedClip.videoOutTransitionSeconds ||
        DEFAULT_VIDEO_TRANSITION_SECONDS
      seekTo(
        Math.max(
          selectedClip.startTime,
          selectedClip.startTime + selectedClip.duration - transitionSeconds / 2
        )
      )
    }
  }

  function commitSelectedClipTiming(patch) {
    if (!selectedClip) {
      return
    }

    applyClips((previous) =>
      previous.map((clip) => {
        if (clip.id !== selectedClip.id) {
          return clip
        }

        const nextClip = { ...clip, ...patch }
        const sourceDuration =
          nextClip.kind === 'video' || nextClip.kind === 'audio'
            ? Number(nextClip.sourceDuration || 0) - Number(nextClip.sourceStart || 0)
            : 0
        const maxDuration =
          sourceDuration > 0
            ? Math.max(MIN_CLIP_DURATION, sourceDuration)
            : Number.POSITIVE_INFINITY
        const duration = roundInspectorTime(
          clamp(Number(nextClip.duration) || MIN_CLIP_DURATION, MIN_CLIP_DURATION, maxDuration)
        )
        const startTime = roundInspectorTime(Math.max(0, Number(nextClip.startTime) || 0))
        const candidate = {
          ...nextClip,
          duration,
          startTime
        }
        const otherClips = previous.filter((otherClip) => otherClip.id !== clip.id)
        const trackId = hasTrackOverlap(otherClips, candidate, candidate.trackId)
          ? getAvailableTrackId(otherClips, candidate.kind, startTime, duration)
          : candidate.trackId

        return { ...candidate, trackId }
      })
    )
  }

  const visibleTimelineTracks = useMemo(() => {
    if (
      !timelineDragPreview?.isNewTrack ||
      !timelineDragPreview.targetTrackId ||
      timelineTracks.some((track) => track.id === timelineDragPreview.targetTrackId)
    ) {
      return timelineTracks
    }

    const nextTracks = [...timelineTracks]
    const insertIndex =
      nextTracks.findLastIndex((track) => track.kind === timelineDragPreview.newTrackKind) + 1
    nextTracks.splice(Math.max(0, insertIndex), 0, {
      id: timelineDragPreview.targetTrackId,
      isPreview: true,
      kind: timelineDragPreview.newTrackKind
    })
    return nextTracks
  }, [timelineDragPreview, timelineTracks])
  const exportProgressText = isExporting ? `导出进度 ${formatExportProgress(exportProgress)}` : ''
  return (
    <Shell $timelineHeight={timelineHeight}>
      <HiddenInput
        ref={audioInputRef}
        type="file"
        accept="audio/*,.aac,.flac,.m4a,.mp3,.ogg,.opus,.wav,.webm"
        onChange={handleAudioFileSelected}
      />
      <HiddenInput
        ref={imageInputRef}
        type="file"
        accept="image/*,.gif,.jpeg,.jpg,.png,.webp"
        onChange={handleImageFileSelected}
      />
      <HiddenInput
        ref={videoInputRef}
        type="file"
        accept="video/*,.m4v,.mov,.mp4,.ogv,.webm"
        onChange={handleVideoFileSelected}
      />
      <Workspace>
        <PreviewPane
          centerGuides={centerGuides}
          isPreviewVideoVisible={isPreviewVideoVisible}
          mediaUrl={mediaUrl}
          onImageResizeStart={startImageResize}
          onOverlayDragStart={startOverlayDrag}
          onPreviewVideoPointerDown={selectActiveVideoClipFromPreview}
          videoShellRef={videoShellRef}
          videoRef={videoRef}
          visiblePreviewClips={visiblePreviewClips}
        />

        <InspectorDock>
          <InspectorPanel
            className="inspector-panel"
            onSelectedClipChange={updateSelectedClip}
            onSelectedClipCommit={commitSelectedClipTiming}
            selectedClip={selectedClip}
          />
        </InspectorDock>
      </Workspace>
      <TimelinePanel
        clipThumbnailsById={clipThumbnailsById}
        clipsByTrackId={clipsByTrackId}
        draggedTimelineClip={draggedTimelineClip}
        duration={durationRef.current}
        exportCut={handleExportButtonClick}
        exportProgress={exportProgress}
        exportProgressText={exportProgressText}
        exportStatus={exportStatus}
        handleLanePointerDown={handleLanePointerDown}
        handleTimelineScroll={handleTimelineScroll}
        history={history}
        isExporting={isExporting}
        isPlaying={isPlaying}
        mediaTools={MEDIA_TOOLS}
        onDeleteSelectedClip={deleteSelectedClip}
        onDuplicateSelectedClip={duplicateSelectedClip}
        onMediaToolAction={handleMediaToolAction}
        onPlaybackRateChange={setPlaybackRate}
        onResetProject={resetProject}
        onSplitSelectedClip={splitSelectedClip}
        onTimelineResizeStart={startLayoutResizeDrag}
        onVolumeChange={setVolume}
        onZoomChange={setZoom}
        playbackRate={playbackRate}
        playheadRef={playheadRef}
        redo={redo}
        redoStack={redoStack}
        rulerTicks={rulerTicks}
        rulerViewportRef={rulerViewportRef}
        selectedClip={selectedClip}
        selectedClipId={selectedClipId}
        startDrag={startDrag}
        startPlayheadScrub={startPlayheadScrub}
        startRulerScrub={startRulerScrub}
        timeCodeRef={timeCodeRef}
        timelineDragPreview={timelineDragPreview}
        timelineTracks={visibleTimelineTracks}
        timelineWidth={timelineWidth}
        togglePlayback={togglePlayback}
        trackViewportRef={trackViewportRef}
        undo={undo}
        volume={volume}
        zoom={zoom}
      />
      {isExportDialogOpen ? (
        <ExportDialog
          exportSettings={exportSettings}
          onCancel={() => setIsExportDialogOpen(false)}
          onConfirm={confirmExport}
          setExportSettings={setExportSettings}
        />
      ) : null}
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
