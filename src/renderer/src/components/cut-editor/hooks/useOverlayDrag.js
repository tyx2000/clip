import { useRef } from 'react'

import {
  clamp,
  clampOverlayPosition,
  cloneClips,
  getOverlayBoundsFromElement,
  roundTime,
  snapOverlayToCenter
} from '../timelineModel'

export function useOverlayDrag({
  clipsRef,
  pushHistory,
  selectClipAndReveal,
  selectedClipIdRef,
  setCenterGuides,
  setClips
}) {
  const overlayDragRef = useRef(null)

  function moveOverlayResizeDrag(event, overlayDrag) {
    const pointerXPercent = ((event.clientX - overlayDrag.left) / overlayDrag.width) * 100
    const pointerYPercent = ((event.clientY - overlayDrag.top) / overlayDrag.height) * 100
    const widthFromX = Math.abs(pointerXPercent - overlayDrag.x) * 2
    const heightFromY = Math.abs(pointerYPercent - overlayDrag.y) * 2
    const widthFromY =
      heightFromY * (overlayDrag.height / overlayDrag.width) * overlayDrag.aspectRatio
    const heightLimitPercent = Math.min(overlayDrag.y, 100 - overlayDrag.y) * 2
    const widthLimitFromHeight =
      heightLimitPercent * (overlayDrag.height / overlayDrag.width) * overlayDrag.aspectRatio
    const widthLimitFromWidth = Math.min(overlayDrag.x, 100 - overlayDrag.x) * 2
    const nextScale = clamp(
      Math.max(widthFromX, widthFromY),
      8,
      Math.max(8, Math.min(80, widthLimitFromWidth, widthLimitFromHeight))
    )
    const roundedScale = roundTime(nextScale)
    if (roundedScale !== overlayDrag.originalScale) {
      overlayDrag.changed = true
    }
    setClips((previous) =>
      previous.map((clip) =>
        clip.id === overlayDrag.clipId ? { ...clip, scale: roundedScale } : clip
      )
    )
  }

  function moveOverlayPositionDrag(event, overlayDrag) {
    const rawPosition = clampOverlayPosition(
      overlayDrag.x + ((event.clientX - overlayDrag.clientX) / overlayDrag.width) * 100,
      overlayDrag.y + ((event.clientY - overlayDrag.clientY) / overlayDrag.height) * 100,
      overlayDrag.bounds
    )
    const { guides, position: nextPosition } = snapOverlayToCenter(rawPosition)
    const roundedX = roundTime(nextPosition.x)
    const roundedY = roundTime(nextPosition.y)
    if (roundedX !== overlayDrag.originalX || roundedY !== overlayDrag.originalY) {
      overlayDrag.changed = true
    }
    setCenterGuides((previous) =>
      previous.x === guides.x && previous.y === guides.y ? previous : guides
    )
    setClips((previous) =>
      previous.map((clip) =>
        clip.id === overlayDrag.clipId ? { ...clip, x: roundedX, y: roundedY } : clip
      )
    )
  }

  function moveOverlayDrag(event) {
    const overlayDrag = overlayDragRef.current
    if (!overlayDrag) {
      return false
    }

    if (overlayDrag.mode === 'resize') {
      moveOverlayResizeDrag(event, overlayDrag)
      return true
    }

    moveOverlayPositionDrag(event, overlayDrag)
    return true
  }

  function completeOverlayDrag(event) {
    const completedOverlayDrag = overlayDragRef.current
    if (completedOverlayDrag?.changed && event.type !== 'pointercancel') {
      pushHistory(completedOverlayDrag.historyClips, completedOverlayDrag.historySelectedClipId)
    }
    overlayDragRef.current = null
    setCenterGuides({ x: false, y: false })
    return Boolean(completedOverlayDrag)
  }

  function startOverlayDrag(event, clip) {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.parentElement.getBoundingClientRect()
    const bounds = getOverlayBoundsFromElement(event.currentTarget)
    const position = clampOverlayPosition(Number(clip.x ?? 50), Number(clip.y ?? 50), bounds)
    selectClipAndReveal(clip.id)
    overlayDragRef.current = {
      bounds,
      changed: false,
      clientX: event.clientX,
      clientY: event.clientY,
      clipId: clip.id,
      height: Math.max(1, rect.height),
      historyClips: cloneClips(clipsRef.current),
      historySelectedClipId: selectedClipIdRef.current,
      mode: 'move',
      originalX: roundTime(position.x),
      originalY: roundTime(position.y),
      width: Math.max(1, rect.width),
      x: position.x,
      y: position.y
    }
  }

  function startImageResize(event, clip) {
    event.preventDefault()
    event.stopPropagation()
    const element = event.currentTarget.parentElement
    const layer = element.parentElement
    const elementRect = element.getBoundingClientRect()
    const layerRect = layer.getBoundingClientRect()
    selectClipAndReveal(clip.id)
    overlayDragRef.current = {
      aspectRatio: elementRect.width / Math.max(1, elementRect.height),
      changed: false,
      clipId: clip.id,
      height: Math.max(1, layerRect.height),
      historyClips: cloneClips(clipsRef.current),
      historySelectedClipId: selectedClipIdRef.current,
      left: layerRect.left,
      mode: 'resize',
      originalScale: roundTime(Number(clip.scale ?? 28)),
      top: layerRect.top,
      width: Math.max(1, layerRect.width),
      x: Number(clip.x ?? 50),
      y: Number(clip.y ?? 50)
    }
  }

  return {
    completeOverlayDrag,
    moveOverlayDrag,
    startImageResize,
    startOverlayDrag
  }
}
