import { MIN_CLIP_DURATION } from '../constants'
import {
  createAudioClip,
  createImageClip,
  createImportedVideoClip,
  createToolClip
} from '../clipFactory'
import {
  analyzeAudioFile,
  createFallbackWaveform,
  createUserMediaSource,
  extractVideoFileThumbnails,
  loadVideoFileInfo
} from '../mediaClient'

const ACCEPTED_EXTENSIONS = {
  audio: new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav', 'webm']),
  image: new Set(['gif', 'jpeg', 'jpg', 'png', 'webp']),
  video: new Set(['m4v', 'mov', 'mp4', 'ogv', 'webm'])
}

function getFileExtension(file) {
  const name = String(file?.name || '')
  const extension = name.split('.').pop()?.toLowerCase() || ''
  return extension === name ? '' : extension
}

function isAcceptedFile(file, kind) {
  if (!file) {
    return false
  }

  const mimeType = String(file.type || '').toLowerCase()
  if (mimeType.startsWith(`${kind}/`)) {
    return true
  }

  return ACCEPTED_EXTENSIONS[kind]?.has(getFileExtension(file)) || false
}

export function useClipActions({
  applyClips,
  clipsRef,
  currentTimeRef,
  duration,
  objectAssetUrlsRef,
  setActiveTool,
  setPlaybackStatus,
  setSelectedClipId
}) {
  function addClip(kind) {
    const clip = createToolClip({
      clips: clipsRef.current,
      duration,
      kind,
      time: currentTimeRef.current
    })

    applyClips((previous) => [...previous, clip])
    setSelectedClipId(clip.id)
  }

  async function handleAudioFileSelected(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }
    if (!isAcceptedFile(file, 'audio')) {
      setPlaybackStatus('不支持的音频格式')
      return
    }

    const { shouldRevoke, sourcePath: clipSourcePath, sourceUrl } = createUserMediaSource(file)
    if (shouldRevoke) {
      objectAssetUrlsRef.current.add(sourceUrl)
    }
    const audioInfo = await analyzeAudioFile(file).catch(() => ({
      duration: 3,
      waveform: createFallbackWaveform()
    }))
    const clip = createAudioClip({
      clips: clipsRef.current,
      duration: audioInfo.duration,
      fileName: file.name,
      sourcePath: clipSourcePath,
      sourceUrl,
      time: currentTimeRef.current,
      waveform: audioInfo.waveform
    })

    applyClips((previous) => [...previous, clip])
    setSelectedClipId(clip.id)
    setActiveTool('')
  }

  function handleImageFileSelected(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }
    if (!isAcceptedFile(file, 'image')) {
      setPlaybackStatus('不支持的图片格式')
      return
    }

    const { shouldRevoke, sourcePath: clipSourcePath, sourceUrl } = createUserMediaSource(file)
    if (shouldRevoke) {
      objectAssetUrlsRef.current.add(sourceUrl)
    }
    const clip = createImageClip({
      clips: clipsRef.current,
      fileName: file.name,
      sourcePath: clipSourcePath,
      sourceUrl,
      time: currentTimeRef.current
    })

    applyClips((previous) => [...previous, clip])
    setSelectedClipId(clip.id)
    setActiveTool('')
  }

  async function handleVideoFileSelected(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }
    if (!isAcceptedFile(file, 'video')) {
      setPlaybackStatus('不支持的视频格式')
      return
    }

    const {
      shouldRevoke,
      sourcePath: clipSourcePath,
      sourceUrl: nextUrl
    } = createUserMediaSource(file)
    if (shouldRevoke) {
      objectAssetUrlsRef.current.add(nextUrl)
    }
    try {
      const info = await loadVideoFileInfo(nextUrl)
      const nextDuration = Math.max(MIN_CLIP_DURATION, Number(info.duration) || 3)
      const clip = createImportedVideoClip({
        clips: clipsRef.current,
        duration: nextDuration,
        fileName: file.name,
        sourcePath: clipSourcePath,
        sourceUrl: nextUrl,
        thumbnails: await extractVideoFileThumbnails(nextUrl, nextDuration).catch(() => [])
      })
      applyClips((previous) => [...previous, clip])
      setSelectedClipId(clip.id)
      setPlaybackStatus('导入视频已追加到视频轨')
    } catch (error) {
      if (shouldRevoke) {
        URL.revokeObjectURL(nextUrl)
        objectAssetUrlsRef.current.delete(nextUrl)
      }
      const message = error instanceof Error ? error.message : '导入视频失败'
      setPlaybackStatus(message)
    }
    setActiveTool('')
  }

  return {
    addClip,
    handleAudioFileSelected,
    handleImageFileSelected,
    handleVideoFileSelected
  }
}
