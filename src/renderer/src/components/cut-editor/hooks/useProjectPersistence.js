import { useEffect, useMemo } from 'react'

import { getProjectStorageKey, toPlayableFileUrl } from '../mediaClient'

export function useProjectPersistence({
  clips,
  duration,
  exportSettings,
  projectRestoredRef,
  setClips,
  setExportSettings,
  setPlaybackStatus,
  setSelectedClipId,
  sourcePath
}) {
  const projectStorageKey = useMemo(() => getProjectStorageKey(sourcePath), [sourcePath])

  useEffect(() => {
    if (!projectStorageKey || !duration || projectRestoredRef.current) {
      return
    }

    projectRestoredRef.current = true
    try {
      const rawProject = window.localStorage.getItem(projectStorageKey)
      if (!rawProject) {
        return
      }

      const project = JSON.parse(rawProject)
      const restoredClips = Array.isArray(project?.clips)
        ? project.clips
            .filter((clip) => clip?.id && clip?.kind && clip?.trackId)
            .map((clip) => {
              const sourceUrl =
                clip.sourcePath &&
                (clip.kind === 'audio' || clip.kind === 'image' || clip.sourcePath !== sourcePath)
                  ? toPlayableFileUrl(clip.sourcePath)
                  : clip.sourceUrl || ''
              return {
                ...clip,
                sourceUrl
              }
            })
        : []

      if (!restoredClips.length) {
        return
      }

      setClips(restoredClips)
      setSelectedClipId(restoredClips[0]?.id || '')
      if (project?.exportSettings) {
        setExportSettings((settings) => ({ ...settings, ...project.exportSettings }))
      }
      setPlaybackStatus('已恢复上次剪辑工程')
    } catch {
      setPlaybackStatus('剪辑工程恢复失败')
    }
  }, [
    duration,
    projectRestoredRef,
    projectStorageKey,
    setClips,
    setExportSettings,
    setPlaybackStatus,
    setSelectedClipId,
    sourcePath
  ])

  useEffect(() => {
    if (!projectStorageKey || !clips.length) {
      return undefined
    }

    const saveTimer = window.setTimeout(() => {
      const serializableClips = clips.map(({ sourceUrl, thumbnails: clipThumbnails, ...clip }) => ({
        ...clip,
        hasPreviewSource: Boolean(sourceUrl),
        hasThumbnails: Boolean(clipThumbnails?.length)
      }))
      window.localStorage.setItem(
        projectStorageKey,
        JSON.stringify({
          clips: serializableClips,
          exportSettings,
          savedAt: Date.now()
        })
      )
    }, 250)

    return () => {
      window.clearTimeout(saveTimer)
    }
  }, [clips, exportSettings, projectStorageKey])
}
