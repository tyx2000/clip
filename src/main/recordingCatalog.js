import { existsSync } from 'fs'
import { mkdir, readdir, stat, unlink, writeFile } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import {
  RECORDING_FILE_PREFIX,
  VIDEO_FILE_EXTENSIONS,
  createRecordingFileName,
  getPosterPathByVideoPath,
  getRecordingsDirectoryPath,
  getVideoExtensionFromMimeType
} from './recordingPaths'

export function createRecordingCatalog({
  readRecordingMetadata,
  writeRecordingMetadata,
  probeVideoDurationSec,
  toRecordingMediaUrl,
  parseDataUrl,
  deleteRecordingMetadataFromDatabase
}) {
  function isRecordingFilePath(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return false
    }

    const recordingsRoot = `${resolve(getRecordingsDirectoryPath())}${sep}`
    const targetPath = resolve(filePath)
    return `${targetPath}${sep}`.startsWith(recordingsRoot)
  }

  async function buildRecordingItem(filePath, fileStat) {
    const metadata = await readRecordingMetadata(filePath)
    const createdAt = Number(fileStat.birthtimeMs || fileStat.mtimeMs || Date.now())
    const posterPath = getPosterPathByVideoPath(filePath)
    const posterUrl = existsSync(posterPath) ? toRecordingMediaUrl(posterPath) : ''
    const probedDurationSec = await probeVideoDurationSec(filePath)
    const durationSec =
      Number.isFinite(probedDurationSec) && probedDurationSec > 0 ? probedDurationSec : null
    const cloudSync = metadata?.cloudSync || null

    return {
      name: filePath.split(sep).pop() || '',
      path: filePath,
      fileUrl: toRecordingMediaUrl(filePath),
      posterUrl,
      bytes: Number(fileStat.size || 0),
      createdAt,
      durationSec,
      cloudSync
    }
  }

  async function listRecordingItems() {
    const recordingsDir = getRecordingsDirectoryPath()
    await mkdir(recordingsDir, { recursive: true })

    const fileNames = await readdir(recordingsDir)
    const items = []

    for (const fileName of fileNames) {
      if (!fileName.startsWith(RECORDING_FILE_PREFIX)) {
        continue
      }

      const extension = fileName.split('.').pop()?.toLowerCase() || ''
      if (!VIDEO_FILE_EXTENSIONS.has(extension)) {
        continue
      }

      const filePath = join(recordingsDir, fileName)

      try {
        const fileStat = await stat(filePath)
        if (!fileStat.isFile()) {
          continue
        }
        items.push(await buildRecordingItem(filePath, fileStat))
      } catch {
        continue
      }
    }

    items.sort((a, b) => b.createdAt - a.createdAt)
    return items
  }

  async function saveRecordingFromDataUrl(payload = {}) {
    const parsed = parseDataUrl(payload?.dataUrl || '')

    if (!parsed || !parsed.buffer?.length) {
      return { ok: false, message: 'Invalid recording payload.' }
    }

    const detectedMime = parsed.mimeType || payload?.mimeType || 'video/webm'
    const ext = getVideoExtensionFromMimeType(detectedMime)
    const filePath = join(getRecordingsDirectoryPath(), createRecordingFileName(ext))

    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, parsed.buffer)

    const fileStat = await stat(filePath)
    const durationSec = await probeVideoDurationSec(filePath)
    await writeRecordingMetadata(filePath, {
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
      cloudSync: null
    })

    return {
      ok: true,
      item: await buildRecordingItem(filePath, fileStat)
    }
  }

  async function deleteRecordingFile(filePath) {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) {
      return { ok: false, message: 'Recording file not found.' }
    }

    await unlink(filePath)
    const posterPath = getPosterPathByVideoPath(filePath)
    deleteRecordingMetadataFromDatabase(filePath)
    if (existsSync(posterPath)) {
      try {
        await unlink(posterPath)
      } catch {
        // Ignore poster deletion failures.
      }
    }

    return { ok: true }
  }

  return {
    isRecordingFilePath,
    buildRecordingItem,
    listRecordingItems,
    saveRecordingFromDataUrl,
    deleteRecordingFile
  }
}
