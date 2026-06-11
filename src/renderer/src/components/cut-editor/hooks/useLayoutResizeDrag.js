import { useRef } from 'react'

import { clamp } from '../timelineModel'

export function useLayoutResizeDrag({ setTimelineHeight, timelineHeight }) {
  const dividerDragRef = useRef(null)

  function startLayoutResizeDrag(event) {
    event.preventDefault()
    event.stopPropagation()
    dividerDragRef.current = {
      clientY: event.clientY,
      height: timelineHeight
    }
  }

  function moveLayoutResizeDrag(event) {
    const dividerDrag = dividerDragRef.current
    if (!dividerDrag) {
      return false
    }

    const deltaY = event.clientY - dividerDrag.clientY
    const maxHeight = Math.max(180, Math.round(window.innerHeight * 0.6))
    setTimelineHeight(clamp(dividerDrag.height - deltaY, 180, maxHeight))
    return true
  }

  function clearLayoutResizeDrag() {
    dividerDragRef.current = null
  }

  return {
    clearLayoutResizeDrag,
    moveLayoutResizeDrag,
    startLayoutResizeDrag
  }
}
