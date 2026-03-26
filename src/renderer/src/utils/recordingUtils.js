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
