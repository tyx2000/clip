import { useRef } from 'react'

import {
  MIN_CLIP_DURATION,
  TIMELINE_AUTO_SCROLL_EDGE_PX,
  TIMELINE_AUTO_SCROLL_STEP_PX
} from '../constants'
import {
  getMoveDragCandidate,
  getTimelineTrackRectKey,
  getTimelineTrackRects,
  getTrimLeftStartTime,
  getTrimRightDuration,
  hasTrackOverlap,
  roundTime
} from '../timelineModel'

export function useTimelineClipDrag({
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
}) {
  const dragRef = useRef(null)

  function refreshTimelineTrackRects(drag, { force = false } = {}) {
    const viewport = trackViewportRef.current
    if (!viewport) {
      drag.trackRects = []
      drag.trackRectKey = ''
      drag.trackRectsScrollTop = 0
      return
    }

    const trackRectKey = getTimelineTrackRectKey(viewport)
    const scrollTop = viewport.scrollTop
    if (!force && drag.trackRectKey === trackRectKey && drag.trackRectsScrollTop === scrollTop) {
      return
    }

    drag.trackRects = getTimelineTrackRects(viewport)
    drag.trackRectKey = trackRectKey
    drag.trackRectsScrollTop = scrollTop
  }

  function getTimelineMoveDropState(drag, event) {
    refreshTimelineTrackRects(drag)
    const { candidate, targetTrack } = getMoveDragCandidate(
      drag,
      event,
      zoomRef.current,
      clipsRef.current
    )
    const isValid =
      targetTrack?.kind === drag.kind &&
      targetTrack.trackId &&
      !hasTrackOverlap(clipsRef.current, candidate, targetTrack.trackId)

    return {
      candidate,
      dropState: isValid ? 'valid' : 'invalid',
      targetTrack
    }
  }

  function scrollTimelineWhileDragging(event) {
    const viewport = trackViewportRef.current
    if (!viewport) {
      return false
    }

    const rect = viewport.getBoundingClientRect()
    if (event.clientY > rect.bottom - TIMELINE_AUTO_SCROLL_EDGE_PX) {
      viewport.scrollTop += TIMELINE_AUTO_SCROLL_STEP_PX
      return true
    } else if (event.clientY < rect.top + TIMELINE_AUTO_SCROLL_EDGE_PX) {
      viewport.scrollTop -= TIMELINE_AUTO_SCROLL_STEP_PX
      return true
    }

    return false
  }

  function updateTimelineMovePreview(drag, event) {
    const didScroll = scrollTimelineWhileDragging(event)
    if (didScroll) {
      refreshTimelineTrackRects(drag)
    }
    const { candidate, dropState, targetTrack } = getTimelineMoveDropState(drag, event)
    const deltaX = candidate.startTime * zoomRef.current - drag.startTime * zoomRef.current
    const scrollDeltaY = (trackViewportRef.current?.scrollTop || 0) - drag.scrollTop
    const deltaY = targetTrack
      ? targetTrack.top - drag.trackTop + scrollDeltaY
      : event.clientY - drag.clientY + scrollDeltaY

    setTimelineDragPreview((previous) => {
      const nextPreview = {
        clipId: drag.clipId,
        deltaX,
        deltaY,
        dropState,
        isNewTrack: Boolean(targetTrack?.isNew),
        newTrackKind: targetTrack?.isNew ? targetTrack.kind : '',
        targetTrackId: targetTrack?.trackId || ''
      }

      if (
        previous?.clipId === nextPreview.clipId &&
        previous.deltaX === nextPreview.deltaX &&
        previous.deltaY === nextPreview.deltaY &&
        previous.dropState === nextPreview.dropState &&
        previous.isNewTrack === nextPreview.isNewTrack &&
        previous.newTrackKind === nextPreview.newTrackKind &&
        previous.targetTrackId === nextPreview.targetTrackId
      ) {
        return previous
      }

      return nextPreview
    })
  }

  function completeTimelineMove(drag, event) {
    const { candidate, dropState, targetTrack } = getTimelineMoveDropState(drag, event)
    if (dropState !== 'valid' || !targetTrack?.trackId) {
      return
    }

    const changed =
      roundTime(candidate.startTime) !== roundTime(drag.startTime) ||
      targetTrack.trackId !== drag.trackId

    if (!changed) {
      return
    }

    applyClips((previous) =>
      previous.map((clip) =>
        clip.id === drag.clipId
          ? { ...clip, startTime: candidate.startTime, trackId: targetTrack.trackId }
          : clip
      )
    )
  }

  function moveTimelineClipDrag(event) {
    const drag = dragRef.current
    if (!drag) {
      return false
    }

    if (drag.mode === 'move') {
      updateTimelineMovePreview(drag, event)
      return true
    }

    const deltaTime = (event.clientX - drag.clientX) / zoom
    setClips((previous) =>
      previous.map((clip) => {
        if (clip.id !== drag.clipId) {
          return clip
        }

        if (drag.mode === 'trim-left') {
          const nextStart = getTrimLeftStartTime(previous, drag, deltaTime, zoom)
          const trimDelta = nextStart - drag.startTime
          return {
            ...clip,
            duration: roundTime(Math.max(MIN_CLIP_DURATION, drag.duration - trimDelta)),
            sourceStart:
              drag.kind === 'video' || drag.kind === 'audio'
                ? roundTime(Math.max(0, drag.sourceStart + trimDelta))
                : drag.sourceStart,
            startTime: roundTime(nextStart)
          }
        }

        const sourceLimit =
          drag.kind === 'video'
            ? Math.max(MIN_CLIP_DURATION, duration - drag.sourceStart)
            : drag.kind === 'audio'
              ? Math.max(MIN_CLIP_DURATION, drag.sourceDuration - drag.sourceStart)
              : Math.max(MIN_CLIP_DURATION, timelineDuration + 60)
        const nextDuration = getTrimRightDuration(previous, drag, deltaTime, sourceLimit, zoom)
        return {
          ...clip,
          duration: roundTime(nextDuration)
        }
      })
    )
    return true
  }

  function completeTimelineClipDrag(event) {
    const completedDrag = dragRef.current
    if (completedDrag?.mode === 'move') {
      completeTimelineMove(completedDrag, event)
    }
    if (completedDrag) {
      setTimelineDragPreview(null)
    }
    dragRef.current = null
    return Boolean(completedDrag)
  }

  function startDrag(event, clip, mode) {
    event.preventDefault()
    event.stopPropagation()
    setSelectedClipId(clip.id)
    if (mode !== 'move') {
      pushHistory(clips)
    }
    const dragState = {
      clientX: event.clientX,
      clientY: event.clientY,
      clip: { ...clip },
      clipId: clip.id,
      duration: clip.duration,
      kind: clip.kind,
      mode,
      scrollTop: trackViewportRef.current?.scrollTop || 0,
      sourceStart: clip.sourceStart || 0,
      sourceDuration: clip.sourceDuration || clip.duration,
      startTime: clip.startTime,
      trackTop: event.currentTarget.parentElement.getBoundingClientRect().top,
      trackId: clip.trackId,
      trackRectKey: '',
      trackRects: [],
      trackRectsScrollTop: 0
    }
    refreshTimelineTrackRects(dragState, { force: true })
    dragRef.current = dragState

    if (mode === 'move') {
      setTimelineDragPreview({
        clipId: clip.id,
        deltaX: 0,
        deltaY: 0,
        dropState: 'valid',
        isNewTrack: false,
        newTrackKind: '',
        targetTrackId: clip.trackId
      })
    }
  }

  return {
    completeTimelineClipDrag,
    moveTimelineClipDrag,
    startDrag
  }
}
