import { useCallback, useState } from 'react'

import { HISTORY_LIMIT } from '../constants'
import {
  cloneClips,
  createHistorySnapshot,
  getHistorySnapshotClips,
  getHistorySnapshotSelectedClipId
} from '../timelineModel'

export function useClipHistory({ clipsRef, selectedClipIdRef, setClips, setSelectedClipId }) {
  const [history, setHistory] = useState([])
  const [redoStack, setRedoStack] = useState([])

  function pushHistory(
    nextClips = clipsRef.current,
    nextSelectedClipId = selectedClipIdRef.current
  ) {
    setHistory((previous) => [
      ...previous.slice(-HISTORY_LIMIT + 1),
      createHistorySnapshot(nextClips, nextSelectedClipId)
    ])
    setRedoStack([])
  }

  function applyClips(updater, { record = true } = {}) {
    const previous = clipsRef.current
    const next = typeof updater === 'function' ? updater(previous) : updater
    if (record) {
      pushHistory(previous)
    }
    clipsRef.current = next
    setClips(next)
  }

  function undo() {
    if (!history.length) {
      return
    }

    const previousSnapshot = history[history.length - 1]
    const previousClips = cloneClips(getHistorySnapshotClips(previousSnapshot))
    const previousSelectedClipId = getHistorySnapshotSelectedClipId(previousSnapshot)
    setRedoStack((stack) => [
      createHistorySnapshot(clipsRef.current, selectedClipIdRef.current),
      ...stack
    ])
    setHistory((stack) => stack.slice(0, -1))
    clipsRef.current = previousClips
    selectedClipIdRef.current = previousSelectedClipId
    setClips(previousClips)
    setSelectedClipId(previousSelectedClipId)
  }

  function redo() {
    if (!redoStack.length) {
      return
    }

    const nextSnapshot = redoStack[0]
    const nextClips = cloneClips(getHistorySnapshotClips(nextSnapshot))
    const nextSelectedClipId = getHistorySnapshotSelectedClipId(nextSnapshot)
    setHistory((stack) => [
      ...stack.slice(-HISTORY_LIMIT + 1),
      createHistorySnapshot(clipsRef.current, selectedClipIdRef.current)
    ])
    setRedoStack((stack) => stack.slice(1))
    clipsRef.current = nextClips
    selectedClipIdRef.current = nextSelectedClipId
    setClips(nextClips)
    setSelectedClipId(nextSelectedClipId)
  }

  const clearHistory = useCallback(() => {
    setHistory([])
    setRedoStack([])
  }, [])

  return {
    applyClips,
    clearHistory,
    history,
    pushHistory,
    redo,
    redoStack,
    undo
  }
}
