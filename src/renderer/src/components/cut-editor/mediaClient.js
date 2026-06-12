export function createFallbackWaveform(bucketCount = 72) {
  return Array.from({ length: bucketCount }, (_, index) => {
    const phase = index / Math.max(1, bucketCount - 1)
    return 0.18 + Math.abs(Math.sin(phase * Math.PI * 5)) * 0.72
  })
}

export function getUserFilePath(file) {
  if (!file) {
    return ''
  }

  return window.api?.getPathForFile?.(file) || file.path || ''
}

export function toPlayableFileUrl(filePath) {
  if (!filePath) {
    return ''
  }

  return window.api?.toFileUrl?.(filePath) || ''
}

export function createUserMediaSource(file) {
  const sourcePath = getUserFilePath(file)
  const fileUrl = toPlayableFileUrl(sourcePath)
  if (fileUrl) {
    return { shouldRevoke: false, sourcePath, sourceUrl: fileUrl }
  }

  return { shouldRevoke: true, sourcePath, sourceUrl: URL.createObjectURL(file) }
}

export function getProjectStorageKey(sourcePath) {
  return sourcePath ? `recording-cut-project:${sourcePath}` : ''
}

export function serializeClipForExport(clip, fallbackVideoPath) {
  const base = {
    align: clip.align,
    backgroundAlpha: clip.backgroundAlpha,
    backgroundColor: clip.backgroundColor,
    color: clip.color,
    duration: clip.duration,
    fontFamily: clip.fontFamily,
    fontSize: clip.fontSize,
    fontWeight: clip.fontWeight,
    kind: clip.kind,
    label: clip.label,
    lineHeight: clip.lineHeight,
    muted: clip.muted,
    opacity: clip.opacity,
    scale: clip.scale,
    shadowBlur: clip.shadowBlur,
    shadowColor: clip.shadowColor,
    shadowDistance: clip.shadowDistance,
    sourceStart: clip.sourceStart || 0,
    startTime: clip.startTime,
    strokeColor: clip.strokeColor,
    strokeWidth: clip.strokeWidth,
    transitionSeconds: clip.transitionSeconds,
    transitionType: clip.transitionType,
    videoInTransitionSeconds: clip.videoInTransitionSeconds,
    videoInTransitionType: clip.videoInTransitionType,
    videoOutTransitionSeconds: clip.videoOutTransitionSeconds,
    videoOutTransitionType: clip.videoOutTransitionType,
    volume: clip.volume,
    x: clip.x,
    y: clip.y
  }

  if (clip.kind === 'video') {
    return {
      ...base,
      sourcePath: clip.sourcePath || fallbackVideoPath
    }
  }

  if (clip.kind === 'audio' || clip.kind === 'image') {
    return {
      ...base,
      sourcePath: clip.sourcePath || ''
    }
  }

  return base
}

export async function analyzeAudioFile(file, bucketCount = 88) {
  const AudioContext = window.AudioContext || window.webkitAudioContext
  if (!AudioContext) {
    return { duration: 3, waveform: createFallbackWaveform(bucketCount) }
  }

  const context = new AudioContext()
  try {
    const audioBuffer = await context.decodeAudioData(await file.arrayBuffer())
    const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) =>
      audioBuffer.getChannelData(index)
    )
    const bucketSize = Math.max(1, Math.floor(audioBuffer.length / bucketCount))
    const rmsBuckets = Array.from({ length: bucketCount }, (_, index) => {
      const start = index * bucketSize
      const end = Math.min(audioBuffer.length, start + bucketSize)
      let sum = 0
      let count = 0
      for (let cursor = start; cursor < end; cursor += 1) {
        const mixed =
          channels.reduce((total, channel) => total + Math.abs(channel[cursor] || 0), 0) /
          Math.max(1, channels.length)
        sum += mixed * mixed
        count += 1
      }
      return Math.sqrt(sum / Math.max(1, count))
    })
    const maxRms = Math.max(0.001, ...rmsBuckets)
    const waveform = rmsBuckets.map((value) => Math.max(0.08, Math.min(1, value / maxRms)))

    return { duration: audioBuffer.duration, waveform }
  } finally {
    await context.close?.()
  }
}

export function loadVideoFileInfo(sourceUrl) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.onloadedmetadata = () => {
      resolve({
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        height: video.videoHeight || 0,
        width: video.videoWidth || 0
      })
    }
    video.onerror = () => reject(new Error('视频文件读取失败'))
    video.src = sourceUrl
  })
}

export async function extractVideoFileThumbnails(sourceUrl, duration, count = 10) {
  const safeDuration = Math.max(0, Number(duration) || 0)
  if (!safeDuration) {
    return []
  }

  const video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  video.src = sourceUrl

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve
    video.onerror = () => reject(new Error('视频缩略图读取失败'))
  })

  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 72
  const context = canvas.getContext('2d')
  if (!context) {
    return []
  }

  const frameCount = Math.min(12, Math.max(4, count))
  const thumbnails = []
  for (let index = 0; index < frameCount; index += 1) {
    const ratio = frameCount === 1 ? 0 : index / (frameCount - 1)
    const time = Math.max(0, Math.min(safeDuration - 0.05, safeDuration * ratio))
    await new Promise((resolve) => {
      video.onseeked = resolve
      video.currentTime = time
    })
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    thumbnails.push({ time, dataUrl: canvas.toDataURL('image/jpeg', 0.72) })
  }

  return thumbnails
}
