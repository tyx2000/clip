import { useEffect, useRef, useState } from 'react'

import { DEFAULT_EXPORT } from '../constants'
import { serializeClipForExport } from '../mediaClient'
import { clamp, createId } from '../timelineModel'

export function useExportCut({ clips, sourcePath, timelineDuration, videoClips }) {
  const exportIdRef = useRef('')
  const isCancellingRef = useRef(false)
  const [exportSettings, setExportSettings] = useState(DEFAULT_EXPORT)
  const [exportStatus, setExportStatus] = useState('')
  const [exportProgress, setExportProgress] = useState(0)
  const [isExporting, setIsExporting] = useState(false)

  useEffect(() => {
    if (typeof window.api?.onRecordingEditorExportProgress !== 'function') {
      return undefined
    }

    return window.api.onRecordingEditorExportProgress((payload = {}) => {
      if (!payload?.exportId || payload.exportId !== exportIdRef.current) {
        return
      }

      setExportProgress(clamp(Number(payload.progress) || 0, 0, 1))
    })
  }, [])

  async function cancelExport() {
    const exportId = exportIdRef.current
    if (!exportId || isCancellingRef.current) {
      return
    }

    const confirmed = window.confirm('当前导出任务仍在进行，是否取消导出？')
    if (!confirmed) {
      return
    }

    if (typeof window.api?.cancelRecordingEditorExport !== 'function') {
      setExportStatus('取消失败：缺少主进程取消接口')
      return
    }

    isCancellingRef.current = true
    setExportStatus('正在取消导出...')
    const result = await window.api.cancelRecordingEditorExport({ exportId })
    if (!result?.ok) {
      isCancellingRef.current = false
      setExportStatus(result?.message || '取消导出失败')
    }
  }

  async function exportCut() {
    if (isExporting) {
      await cancelExport()
      return
    }

    if (!sourcePath || typeof window.api?.exportRecordingEditorCut !== 'function') {
      setExportStatus('导出失败：缺少主进程导出接口')
      return
    }

    if (!videoClips.length) {
      setExportStatus('没有可导出的视频片段')
      return
    }

    const exportId = createId('export')
    exportIdRef.current = exportId
    setIsExporting(true)
    setExportProgress(0.01)
    setExportStatus('')
    try {
      const result = await window.api.exportRecordingEditorCut({
        exportId,
        path: sourcePath,
        clips: clips.map((clip) => serializeClipForExport(clip, sourcePath)),
        output: {
          ...exportSettings,
          duration: timelineDuration
        }
      })

      if (result?.cancelled) {
        setExportProgress(0)
        setExportStatus('')
        window.alert('导出已取消')
        return
      }

      if (!result?.ok) {
        setExportStatus(result?.message || '导出失败')
        return
      }

      setExportProgress(1)
      setExportStatus(`已导出 ${result.item?.name || result.outputPath || ''}`)
    } catch (error) {
      setExportStatus(error instanceof Error ? error.message : '导出失败')
    } finally {
      isCancellingRef.current = false
      setIsExporting(false)
      exportIdRef.current = ''
    }
  }

  return {
    exportCut,
    exportProgress,
    exportSettings,
    exportStatus,
    isExporting,
    setExportSettings
  }
}
