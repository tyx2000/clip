import { useRef } from 'react'

import { TRACK_GUTTER_WIDTH } from '../constants'

export function useTimelineScrubDrag({
  getCurrentTime,
  isPlaying,
  pauseTimelinePlayback,
  seekTo,
  startTimelinePlayback,
  zoom
}) {
  const scrubDragRef = useRef(null)
  const wasPlayingBeforeScrubRef = useRef(false)

  function beginScrub(left, clientX) {
    wasPlayingBeforeScrubRef.current = isPlaying
    if (wasPlayingBeforeScrubRef.current) {
      pauseTimelinePlayback()
    }
    scrubDragRef.current = { left }
    seekTo((clientX - left) / zoom)
  }

  function startPlayheadScrub(event) {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.parentElement.getBoundingClientRect()
    beginScrub(rect.left + TRACK_GUTTER_WIDTH, event.clientX)
  }

  function startRulerScrub(event) {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    beginScrub(rect.left, event.clientX)
  }

  function moveScrubDrag(event) {
    const scrubDrag = scrubDragRef.current
    if (!scrubDrag) {
      return false
    }

    seekTo((event.clientX - scrubDrag.left) / zoom)
    return true
  }

  function completeScrubDrag() {
    if (!scrubDragRef.current) {
      return false
    }

    if (wasPlayingBeforeScrubRef.current) {
      startTimelinePlayback(getCurrentTime())
    }
    scrubDragRef.current = null
    wasPlayingBeforeScrubRef.current = false
    return true
  }

  return {
    completeScrubDrag,
    moveScrubDrag,
    startPlayheadScrub,
    startRulerScrub
  }
}
