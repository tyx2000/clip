export function formatDuration(totalSeconds) {
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0')
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }

  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

export function middleEllipsis(value, maxLength = 36) {
  const text = String(value || '')
  if (text.length <= maxLength) {
    return text
  }

  const extensionMatch = text.match(/(\.[a-z0-9]{2,8})$/i)
  const extension = extensionMatch ? extensionMatch[1] : ''
  const body = extension ? text.slice(0, -extension.length) : text
  const budget = Math.max(maxLength - extension.length - 1, 6)
  const frontLength = Math.ceil(budget / 2)
  const backLength = Math.floor(budget / 2)
  const back = backLength > 0 ? body.slice(-backLength) : ''

  return `${body.slice(0, frontLength)}…${back}${extension}`
}

export function formatDateTime24(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

export function getPreferredRecorderMimeType() {
  if (typeof window.MediaRecorder?.isTypeSupported !== 'function') {
    return ''
  }

  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  return candidates.find((mimeType) => window.MediaRecorder.isTypeSupported(mimeType)) || ''
}

export async function blobToDataUrl(blob) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('Failed to convert recording blob.'))
    reader.readAsDataURL(blob)
  })
}

export async function capturePosterFromBlob(blob, quality = 0.76) {
  if (!(blob instanceof Blob) || !blob.size) {
    return ''
  }

  const video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true

  const objectUrl = URL.createObjectURL(blob)
  video.src = objectUrl

  const waitForFrame = async () => {
    await new Promise((resolve, reject) => {
      let resolved = false

      const cleanup = () => {
        video.removeEventListener('error', onError)
        video.removeEventListener('loadedmetadata', onLoadedMetadata)
        video.removeEventListener('loadeddata', onLoadedData)
        video.removeEventListener('seeked', onSeeked)
      }

      const finish = () => {
        if (resolved) {
          return
        }
        resolved = true
        cleanup()
        resolve()
      }

      const onError = () => {
        if (resolved) {
          return
        }
        resolved = true
        cleanup()
        reject(new Error('Failed to decode video for poster capture.'))
      }

      const onLoadedData = () => {
        finish()
      }

      const onSeeked = () => {
        finish()
      }

      const onLoadedMetadata = () => {
        const duration = Number.isFinite(video.duration) ? video.duration : 0
        if (duration <= 0) {
          video.addEventListener('loadeddata', onLoadedData, { once: true })
          return
        }

        const targetTime = Math.min(Math.max(duration * 0.12, 0.1), Math.max(duration - 0.1, 0))
        if (targetTime <= 0) {
          video.addEventListener('loadeddata', onLoadedData, { once: true })
          return
        }

        video.addEventListener('seeked', onSeeked, { once: true })
        try {
          video.currentTime = targetTime
        } catch {
          video.removeEventListener('seeked', onSeeked)
          video.addEventListener('loadeddata', onLoadedData, { once: true })
        }
      }

      video.addEventListener('error', onError, { once: true })
      video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true })
    })
  }

  try {
    await waitForFrame()
    return capturePosterFromVideo(video, quality)
  } catch {
    return ''
  } finally {
    URL.revokeObjectURL(objectUrl)
    video.removeAttribute('src')
    video.load()
  }
}

export function isLikelyPermissionError(error) {
  const name = String(error?.name || '').toLowerCase()
  const message = String(error?.message || '').toLowerCase()

  if (
    name === 'notallowederror' ||
    name === 'securityerror' ||
    name === 'permissiondeniederror' ||
    name === 'notreadableerror'
  ) {
    return true
  }

  return (
    message.includes('permission') ||
    message.includes('denied') ||
    message.includes('not allowed') ||
    message.includes('could not start video source') ||
    message.includes('not supported')
  )
}

export function capturePosterFromVideo(videoElement, quality = 0.76) {
  if (!videoElement?.videoWidth || !videoElement?.videoHeight) {
    return ''
  }

  try {
    const canvas = document.createElement('canvas')
    canvas.width = videoElement.videoWidth
    canvas.height = videoElement.videoHeight

    const context = canvas.getContext('2d')
    if (!context) {
      return ''
    }

    context.drawImage(videoElement, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', quality)
  } catch {
    return ''
  }
}
