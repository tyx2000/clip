import {
  BASE_TRACKS,
  CENTER_SNAP_THRESHOLD,
  DEFAULT_VIDEO_TRANSITION_SECONDS,
  CLIP_SNAP_DISTANCE_PX,
  DEFAULT_TRANSITION,
  MIN_CLIP_DURATION,
  OVERLAY_FADE_SECONDS
} from './constants'

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

export function roundTime(value) {
  return Math.round(value * 100) / 100
}

export function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function cloneClips(clips) {
  return clips.map((clip) => ({ ...clip }))
}

export function createHistorySnapshot(clips, selectedClipId = '') {
  return {
    clips: cloneClips(clips),
    selectedClipId
  }
}

export function getHistorySnapshotClips(snapshot) {
  return Array.isArray(snapshot) ? snapshot : snapshot?.clips || []
}

export function getHistorySnapshotSelectedClipId(snapshot) {
  return Array.isArray(snapshot) ? snapshot[0]?.id || '' : snapshot?.selectedClipId || ''
}

export function formatEditorTime(value) {
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

export function formatRulerTime(value) {
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

export function formatExportProgress(progress) {
  return `${clamp(Math.round((Number(progress) || 0) * 100), 1, 100)}%`
}

export function getTimelineEnd(clips, fallbackDuration) {
  return Math.max(
    fallbackDuration,
    1,
    ...clips.map((clip) => Number(clip.startTime || 0) + Number(clip.duration || 0))
  )
}

export function getKindEnd(clips, kind) {
  return Math.max(
    0,
    ...clips
      .filter((clip) => clip.kind === kind)
      .map((clip) => Number(clip.startTime || 0) + Number(clip.duration || 0))
  )
}

export function getTrackKind(trackId) {
  const normalized = String(trackId || '')
  return BASE_TRACKS.find(
    (track) => normalized === track.kind || normalized.startsWith(`${track.kind}-`)
  )?.kind
}

export function getTrackIndex(trackId, kind = getTrackKind(trackId)) {
  const normalized = String(trackId || '')
  if (normalized === kind) {
    return 1
  }

  const suffix = Number(normalized.slice(String(kind || '').length + 1))
  return Number.isFinite(suffix) && suffix > 1 ? suffix : 1
}

export function createTrackId(kind, index) {
  return index <= 1 ? kind : `${kind}-${index}`
}

export function getTimelineTracks(clips) {
  return BASE_TRACKS.flatMap((track) => {
    const maxIndex = Math.max(
      1,
      ...clips
        .filter((clip) => clip.kind === track.kind)
        .map((clip) => getTrackIndex(clip.trackId, track.kind))
    )

    return Array.from({ length: maxIndex }, (_, index) => ({
      id: createTrackId(track.kind, index + 1),
      kind: track.kind
    }))
  })
}

export function clipsOverlap(startA, durationA, startB, durationB) {
  const endA = startA + durationA
  const endB = startB + durationB
  return startA < endB && startB < endA
}

export function hasTrackOverlap(clips, candidate, trackId = candidate.trackId) {
  return clips.some(
    (clip) =>
      clip.id !== candidate.id &&
      clip.kind === candidate.kind &&
      clip.trackId === trackId &&
      clipsOverlap(candidate.startTime, candidate.duration, clip.startTime, clip.duration)
  )
}

export function getClipEnd(clip) {
  return Number(clip.startTime || 0) + Number(clip.duration || 0)
}

export function getClipSourceEnd(clip) {
  return Number(clip.sourceStart || 0) + Number(clip.duration || 0)
}

export function getSnappedMoveStartTime(clips, candidate, trackId, zoomValue) {
  const snapThreshold = CLIP_SNAP_DISTANCE_PX / Math.max(1, zoomValue)
  let snappedStartTime = candidate.startTime
  let snapDistance = snapThreshold

  const considerSnap = (nextStartTime) => {
    if (nextStartTime < 0) return

    const distance = Math.abs(candidate.startTime - nextStartTime)
    if (distance <= snapDistance) {
      snapDistance = distance
      snappedStartTime = nextStartTime
    }
  }

  for (const clip of clips) {
    if (clip.id === candidate.id || clip.kind !== candidate.kind || clip.trackId !== trackId) {
      continue
    }

    considerSnap(getClipEnd(clip))
    considerSnap(Number(clip.startTime || 0) - Number(candidate.duration || 0))
  }

  return roundTime(snappedStartTime)
}

export function getSameTrackNeighborClips(clips, drag) {
  return clips.filter(
    (clip) => clip.id !== drag.clipId && clip.kind === drag.kind && clip.trackId === drag.trackId
  )
}

export function getTrimLeftStartTime(clips, drag, deltaTime, zoomValue) {
  const fixedEnd = drag.startTime + drag.duration
  const maxStart = fixedEnd - MIN_CLIP_DURATION
  const minStart = Math.min(
    maxStart,
    Math.max(
      0,
      ...getSameTrackNeighborClips(clips, drag)
        .filter((clip) => Number(clip.startTime || 0) < fixedEnd)
        .map((clip) => getClipEnd(clip))
    )
  )
  const snapThreshold = CLIP_SNAP_DISTANCE_PX / Math.max(1, zoomValue)
  const rawStart = drag.startTime + deltaTime
  const snappedStart = Math.abs(rawStart - minStart) <= snapThreshold ? minStart : rawStart

  return roundTime(clamp(snappedStart, minStart, maxStart))
}

export function getTrimRightDuration(clips, drag, deltaTime, sourceLimit, zoomValue) {
  const minEnd = drag.startTime + MIN_CLIP_DURATION
  const sourceEnd = drag.startTime + sourceLimit
  const nextClipStart = Math.min(
    sourceEnd,
    ...getSameTrackNeighborClips(clips, drag)
      .map((clip) => Number(clip.startTime || 0))
      .filter((startTime) => startTime > drag.startTime)
  )
  const maxEnd = Math.max(minEnd, nextClipStart)
  const snapThreshold = CLIP_SNAP_DISTANCE_PX / Math.max(1, zoomValue)
  const rawEnd = drag.startTime + drag.duration + deltaTime
  const snappedEnd = Math.abs(rawEnd - maxEnd) <= snapThreshold ? maxEnd : rawEnd

  return roundTime(clamp(snappedEnd, minEnd, maxEnd) - drag.startTime)
}

export function getNextTrackId(clips, kind) {
  const maxIndex = Math.max(
    1,
    ...clips.filter((clip) => clip.kind === kind).map((clip) => getTrackIndex(clip.trackId, kind))
  )
  return createTrackId(kind, maxIndex + 1)
}

export function getAvailableTrackId(clips, kind, startTime, duration) {
  const candidate = {
    duration,
    id: '__candidate__',
    kind,
    startTime
  }
  const tracks = getTimelineTracks(clips).filter((track) => track.kind === kind)
  const availableTrack = tracks.find((track) => !hasTrackOverlap(clips, candidate, track.id))
  return availableTrack?.id || getNextTrackId(clips, kind)
}

export function getTimelineTrackRects(trackViewport) {
  return Array.from(trackViewport?.querySelectorAll('[data-track-id]') || []).map((element) => {
    const rect = element.getBoundingClientRect()
    return {
      bottom: rect.bottom,
      isPreview: element.dataset.trackPreview === 'true',
      kind: element.dataset.trackKind,
      top: rect.top,
      trackId: element.dataset.trackId
    }
  })
}

export function getTimelineTrackRectKey(trackViewport) {
  return Array.from(trackViewport?.querySelectorAll('[data-track-id]') || [])
    .map((element) => `${element.dataset.trackId}:${element.dataset.trackPreview || 'false'}`)
    .join('|')
}

export function getTrackAtClientY(trackRects, clientY) {
  return trackRects.find((track) => clientY >= track.top && clientY <= track.bottom) || null
}

export function getNewTrackTarget(trackRects, clips, kind, clientY) {
  const sameKindTracks = trackRects.filter((track) => track.kind === kind && !track.isPreview)
  const lastSameKindTrack = sameKindTracks.at(-1)
  if (!lastSameKindTrack || clientY < lastSameKindTrack.bottom - 8) {
    return null
  }

  return {
    bottom: lastSameKindTrack.bottom + (lastSameKindTrack.bottom - lastSameKindTrack.top),
    isNew: true,
    kind,
    top: lastSameKindTrack.bottom,
    trackId: getNextTrackId(clips, kind)
  }
}

export function getMoveDragCandidate(drag, event, zoomValue, clips = []) {
  const hoveredTrack = getTrackAtClientY(drag.trackRects, event.clientY)
  const targetTrack =
    hoveredTrack?.kind === drag.kind && !hoveredTrack.isPreview
      ? hoveredTrack
      : getNewTrackTarget(drag.trackRects, clips, drag.kind, event.clientY) || hoveredTrack
  const targetTrackId = targetTrack?.trackId || drag.trackId
  const rawStartTime = roundTime(
    Math.max(0, drag.startTime + (event.clientX - drag.clientX) / zoomValue)
  )
  const candidate = {
    ...drag.clip,
    startTime: rawStartTime,
    trackId: targetTrackId
  }

  if (targetTrack?.kind === drag.kind && targetTrackId) {
    candidate.startTime = getSnappedMoveStartTime(clips, candidate, targetTrackId, zoomValue)
  }

  return {
    candidate,
    targetTrack
  }
}

export function findVideoClipAtTime(clips, time) {
  const directClip = clips.find((clip) => time >= clip.startTime && time < getClipEnd(clip))
  if (directClip) {
    return directClip
  }

  const edgeEpsilon = 0.001
  return (
    clips.find(
      (clip) =>
        time > clip.startTime &&
        Math.abs(time - getClipEnd(clip)) <= edgeEpsilon &&
        !clips.some((nextClip) => Math.abs(nextClip.startTime - time) <= edgeEpsilon)
    ) || null
  )
}

export function getClipThumbnails(clip, thumbnails) {
  if (clip.kind !== 'video' || !thumbnails.length) {
    return clip.kind === 'video' && clip.thumbnails?.length ? clip.thumbnails : []
  }

  const sourceThumbnails = clip.thumbnails?.length ? clip.thumbnails : thumbnails
  const sourceStart = Number(clip.sourceStart || 0)
  const sourceEnd = sourceStart + Number(clip.duration || 0)
  const clippedThumbnails = sourceThumbnails.filter(
    (thumb) => thumb.time >= sourceStart && thumb.time <= sourceEnd
  )

  return clippedThumbnails.length ? clippedThumbnails : sourceThumbnails
}

export function isClipActiveAtTime(clip, time) {
  return time >= clip.startTime && time < getClipEnd(clip)
}

export function easeInOut(value) {
  return value * value * (3 - 2 * value)
}

export function getOverlayTransitionAtTime(clip, time) {
  const start = Number(clip.startTime || 0)
  const end = getClipEnd(clip)
  if (time < start || time >= end) {
    return { alpha: 0, axisScale: 1 }
  }

  const transitionSeconds =
    Number(clip.transitionSeconds) >= 0 ? Number(clip.transitionSeconds) : OVERLAY_FADE_SECONDS
  const fadeIn = transitionSeconds > 0 ? Math.min((time - start) / transitionSeconds, 1) : 1
  const fadeOut = transitionSeconds > 0 ? Math.min((end - time) / transitionSeconds, 1) : 1
  const progress = easeInOut(Math.min(fadeIn, fadeOut))
  const transitionType = clip.transitionType || DEFAULT_TRANSITION

  if (transitionType === 'none') {
    return { alpha: progress > 0 ? 1 : 0, axisScale: 1 }
  }

  return {
    alpha: progress,
    axisScale: transitionType === 'rotateY' ? Math.cos((1 - progress) * (Math.PI / 2)) : 1
  }
}

function getVideoTransitionProgress(clip, time, direction) {
  const start = Number(clip.startTime || 0)
  const duration = Number(clip.duration || 0)
  const end = start + duration
  const type = clip[`${direction}TransitionType`] || 'none'
  const fallbackSeconds = type === 'none' ? 0 : DEFAULT_VIDEO_TRANSITION_SECONDS
  const transitionSeconds = Math.min(
    Math.max(0, Number(clip[`${direction}TransitionSeconds`]) || fallbackSeconds),
    duration / 2
  )

  if (transitionSeconds <= 0) {
    return 1
  }

  if (direction === 'videoIn') {
    return clamp((time - start) / transitionSeconds, 0, 1)
  }

  return clamp((end - time) / transitionSeconds, 0, 1)
}

function getVideoTransitionTransform(type, progress, direction) {
  if (type === 'slideLeft') {
    return `translateX(${direction === 'videoIn' ? (progress - 1) * 100 : (1 - progress) * -100}%)`
  }
  if (type === 'slideRight') {
    return `translateX(${direction === 'videoIn' ? (1 - progress) * 100 : (1 - progress) * 100}%)`
  }
  if (type === 'slideUp') {
    return `translateY(${direction === 'videoIn' ? (progress - 1) * 100 : (1 - progress) * -100}%)`
  }
  if (type === 'slideDown') {
    return `translateY(${direction === 'videoIn' ? (1 - progress) * 100 : (1 - progress) * 100}%)`
  }

  return 'none'
}

export function getVideoTransitionAtTime(clip, time) {
  const start = Number(clip.startTime || 0)
  const duration = Number(clip.duration || 0)
  const end = start + duration
  const inType = clip.videoInTransitionType || 'none'
  const outType = clip.videoOutTransitionType || 'none'
  const inSeconds = Math.min(
    Math.max(
      0,
      Number(clip.videoInTransitionSeconds) ||
        (inType === 'none' ? 0 : DEFAULT_VIDEO_TRANSITION_SECONDS)
    ),
    duration / 2
  )
  const outSeconds = Math.min(
    Math.max(
      0,
      Number(clip.videoOutTransitionSeconds) ||
        (outType === 'none' ? 0 : DEFAULT_VIDEO_TRANSITION_SECONDS)
    ),
    duration / 2
  )
  const isInTransition = inType !== 'none' && inSeconds > 0 && time < start + inSeconds
  const isOutTransition = outType !== 'none' && outSeconds > 0 && time > end - outSeconds

  if (!isInTransition && !isOutTransition) {
    return { opacity: 1, transform: 'none' }
  }

  const direction = isInTransition ? 'videoIn' : 'videoOut'
  const type = isInTransition ? inType : outType
  const progress = getVideoTransitionProgress(clip, time, direction)

  return {
    opacity: type === 'fade' ? progress : 1,
    transform: getVideoTransitionTransform(type, progress, direction)
  }
}

export function getVisiblePreviewClips(clips, time) {
  return clips
    .filter(
      (clip) => (clip.kind === 'image' || clip.kind === 'text') && isClipActiveAtTime(clip, time)
    )
    .map((clip) => ({ ...clip, previewTransition: getOverlayTransitionAtTime(clip, time) }))
    .sort((a, b) => a.startTime - b.startTime)
}

export function getPreviewOverlaySignature(clips) {
  return clips
    .map((clip) =>
      [
        clip.id,
        clip.kind,
        clip.label,
        clip.x,
        clip.y,
        clip.scale,
        clip.opacity,
        clip.transitionType,
        clip.transitionSeconds,
        clip.color,
        clip.fontFamily,
        clip.fontSize,
        clip.fontWeight,
        clip.align,
        clip.lineHeight,
        clip.strokeColor,
        clip.strokeWidth,
        clip.shadowColor,
        clip.shadowBlur,
        clip.shadowDistance,
        clip.backgroundColor,
        clip.backgroundAlpha,
        clip.previewTransition?.alpha,
        clip.previewTransition?.axisScale
      ].join(':')
    )
    .join('|')
}

export function getOverlayBoundsFromElement(element) {
  const layer = element.parentElement
  const layerRect = layer?.getBoundingClientRect()
  if (!layerRect || !layerRect.width || !layerRect.height) {
    return null
  }

  const elementWidth = element.offsetWidth || element.getBoundingClientRect().width
  const elementHeight = element.offsetHeight || element.getBoundingClientRect().height
  const halfWidth = Math.min(50, (elementWidth / layerRect.width) * 50)
  const halfHeight = Math.min(50, (elementHeight / layerRect.height) * 50)
  return {
    height: layerRect.height,
    maxX: 100 - halfWidth,
    maxY: 100 - halfHeight,
    minX: halfWidth,
    minY: halfHeight,
    width: layerRect.width
  }
}

export function clampOverlayPosition(x, y, bounds) {
  if (!bounds) {
    return {
      x: clamp(x, 0, 100),
      y: clamp(y, 0, 100)
    }
  }

  const minX = Math.min(bounds.minX, bounds.maxX)
  const maxX = Math.max(bounds.minX, bounds.maxX)
  const minY = Math.min(bounds.minY, bounds.maxY)
  const maxY = Math.max(bounds.minY, bounds.maxY)

  return {
    x: clamp(x, minX, maxX),
    y: clamp(y, minY, maxY)
  }
}

export function snapOverlayToCenter(position) {
  const snapX = Math.abs(position.x - 50) <= CENTER_SNAP_THRESHOLD
  const snapY = Math.abs(position.y - 50) <= CENTER_SNAP_THRESHOLD

  return {
    guides: { x: snapX, y: snapY },
    position: {
      x: snapX ? 50 : position.x,
      y: snapY ? 50 : position.y
    }
  }
}

export function getRulerStep(zoom) {
  const minStep = 88 / Math.max(zoom, 1)
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800]
  return steps.find((step) => step >= minStep) || 3600
}

export function createVideoClip(duration, name) {
  return {
    duration,
    id: createId('video'),
    kind: 'video',
    label: name || 'Video',
    muted: false,
    sourceStart: 0,
    sourceDuration: duration,
    startTime: 0,
    trackId: 'video',
    videoInTransitionSeconds: DEFAULT_VIDEO_TRANSITION_SECONDS,
    videoInTransitionType: 'none',
    videoOutTransitionSeconds: DEFAULT_VIDEO_TRANSITION_SECONDS,
    videoOutTransitionType: 'none',
    volume: 1
  }
}

export function applySeek(nextTime, { onTimeChange, setCurrentTime, timelineDuration }) {
  const clamped = clamp(nextTime, 0, Math.max(1, timelineDuration))

  onTimeChange?.(clamped)
  setCurrentTime(clamped)
}
