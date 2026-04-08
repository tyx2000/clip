const http = require('node:http')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { existsSync, createReadStream } = require('node:fs')
const {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} = require('node:fs/promises')
const path = require('node:path')
const ffmpegPath = require('ffmpeg-static')

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const DATA_DIR = path.join(__dirname, 'data')
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')

const mergeQueue = new Map()

/** Writes a JSON HTTP response with common cache-control headers. */
function json(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

/** Sends a standard 404 response for unknown resources. */
function notFound(res) {
  json(res, 404, { ok: false, message: 'Not found.' })
}

/** Sends a standard 400 response for invalid client input. */
function badRequest(res, message) {
  json(res, 400, { ok: false, message })
}

/** Sends a standard 409 response for conflicts. */
function conflict(res, message) {
  json(res, 409, { ok: false, message })
}

/** Sends a standard 500 response for unexpected server failures. */
function serverError(res, error) {
  json(res, 500, {
    ok: false,
    message: error instanceof Error ? error.message : 'Internal server error.'
  })
}

/** Reads and parses a JSON request body. */
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('Invalid JSON body.'))
      }
    })
    req.on('error', reject)
  })
}

/** Reads a binary request body into one Buffer for part upload handling. */
function parseBinaryBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Computes the SHA-256 checksum for an in-memory payload. */
function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/** Computes the SHA-256 checksum for one on-disk file. */
async function sha256File(filePath) {
  const buffer = await readFile(filePath)
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/** Runs ffmpeg and surfaces a useful stderr tail on failure. */
async function runFfmpeg(args) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg binary is not available on the server.')
  }

  await new Promise((resolveCallback, rejectCallback) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    })

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', rejectCallback)
    child.on('close', (code) => {
      if (code === 0) {
        resolveCallback()
        return
      }

      const tail = stderr.trim().split('\n').slice(-6).join('\n')
      rejectCallback(new Error(tail || `ffmpeg exited with code ${code}`))
    })
  })
}

/** Ensures the server data root exists before requests are handled. */
async function ensureDirectories() {
  await mkdir(SESSIONS_DIR, { recursive: true })
}

/** Returns the absolute working directory for one remote session. */
function getSessionDir(sessionId) {
  return path.join(SESSIONS_DIR, sessionId)
}

/** Returns the directory that stores uploaded part files. */
function getSegmentsDir(sessionId) {
  return path.join(getSessionDir(sessionId), 'segments')
}

/** Returns the directory that stores the merged remote output. */
function getMergedDir(sessionId) {
  return path.join(getSessionDir(sessionId), 'merged')
}

function getMergedFilePath(sessionId, extension = 'webm') {
  return path.join(getMergedDir(sessionId), `merged.${extension}`)
}

async function findMergedFile(sessionId) {
  const mergedDir = getMergedDir(sessionId)
  if (!existsSync(mergedDir)) {
    return null
  }

  const entries = await readdir(mergedDir, { withFileTypes: true }).catch(() => [])
  const fileEntry = entries.find((entry) => entry.isFile() && entry.name.startsWith('merged.'))
  return fileEntry ? path.join(mergedDir, fileEntry.name) : null
}

function getPartFilePath(sessionId, partIndex) {
  const label = String(partIndex).padStart(4, '0')
  return path.join(getSegmentsDir(sessionId), `part-${label}.bin`)
}

function getMimeTypeByExtension(extension = '') {
  const normalized = String(extension || '').toLowerCase()
  if (normalized === 'mp4') {
    return 'video/mp4'
  }
  if (normalized === 'ogv' || normalized === 'ogg') {
    return 'video/ogg'
  }
  return 'video/webm'
}

async function removeSegmentsDir(sessionId) {
  const segmentsDir = getSegmentsDir(sessionId)
  if (!existsSync(segmentsDir)) {
    return
  }

  await rm(segmentsDir, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 200
  })
}

/** Reassembles the ordered raw part stream into a temporary continuous file. */
async function buildAssembledSource(sessionId, parts, extension) {
  const sessionDir = getSessionDir(sessionId)
  const assembledPath = path.join(sessionDir, `assembled.${extension}`)
  await writeFile(assembledPath, Buffer.alloc(0))

  for (const part of parts) {
    const body = await readFile(part.filePath)
    await appendFile(assembledPath, body)
  }

  return assembledPath
}

/** Produces the final merged file for one session. */
async function mergeSessionFiles(sessionId, extension, parts) {
  await mkdir(getMergedDir(sessionId), { recursive: true })
  const outputFilePath = getMergedFilePath(sessionId, extension)

  if (parts.length === 1) {
    await copyFile(parts[0].filePath, outputFilePath)
    return outputFilePath
  }

  const assembledPath = await buildAssembledSource(sessionId, parts, extension)
  try {
    await runFfmpeg(['-y', '-i', assembledPath, '-c', 'copy', outputFilePath])
  } finally {
    if (existsSync(assembledPath)) {
      await unlink(assembledPath).catch(() => {})
    }
  }

  return outputFilePath
}

/** Serializes merge work per session to avoid duplicate merge races. */
function scheduleMerge(sessionId, task) {
  const current = mergeQueue.get(sessionId) || Promise.resolve()
  const next = current
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (mergeQueue.get(sessionId) === next) {
        mergeQueue.delete(sessionId)
      }
    })

  mergeQueue.set(sessionId, next)
  return next
}

/** Stores one uploaded part, verifies integrity, and remains idempotent. */
async function handleUploadPart(req, res, sessionId, partIndex) {
  const mergedFilePath = await findMergedFile(sessionId)
  if (mergedFilePath) {
    json(res, 200, {
      ok: true,
      sessionId,
      partIndex,
      alreadyMerged: true
    })
    return
  }

  const body = await parseBinaryBody(req)
  if (!body.length) {
    badRequest(res, 'Part body is empty.')
    return
  }

  const checksumHeader = String(req.headers['x-checksum-sha256'] || '')
    .trim()
    .toLowerCase()
  const sizeHeader = Number(req.headers['x-file-size'] || 0)
  const checksum = sha256Buffer(body)
  if (checksumHeader && checksumHeader !== checksum) {
    badRequest(res, 'Checksum mismatch.')
    return
  }

  if (sizeHeader > 0 && sizeHeader !== body.length) {
    badRequest(res, 'File size mismatch.')
    return
  }

  await mkdir(getSegmentsDir(sessionId), { recursive: true })
  const filePath = getPartFilePath(sessionId, partIndex)

  if (existsSync(filePath)) {
    const existingChecksum = await sha256File(filePath)
    if (existingChecksum === checksum) {
      json(res, 200, {
        ok: true,
        sessionId,
        partIndex,
        etag: existingChecksum,
        alreadyExisted: true
      })
      return
    }

    conflict(res, 'Conflicting part checksum for the same part index.')
    return
  }

  const tempPath = `${filePath}.tmp`
  await writeFile(tempPath, body)
  await rename(tempPath, filePath)

  const checksumFromFile = await sha256File(filePath)
  if (checksumFromFile !== checksum) {
    badRequest(res, 'Checksum verification failed after write.')
    return
  }

  json(res, 200, {
    ok: true,
    sessionId,
    partIndex,
    etag: checksum,
    alreadyExisted: false
  })
}

/** Merges all uploaded parts declared by the client and deletes source segments on success. */
async function handleMergeSession(req, res, sessionId) {
  const payload = await parseJsonBody(req)
  const parts = Array.isArray(payload.parts) ? payload.parts : []
  const extension =
    String(payload.extension || 'webm')
      .trim()
      .toLowerCase() || 'webm'

  if (!parts.length) {
    badRequest(res, 'parts is required.')
    return
  }

  const mergedFilePath = getMergedFilePath(sessionId, extension)
  if (existsSync(mergedFilePath)) {
    const fileStat = await stat(mergedFilePath)
    json(res, 200, {
      ok: true,
      remoteVideoUrl: `/api/cloud-sync/sessions/${sessionId}/merged`,
      mergedBytes: Number(fileStat.size || 0),
      alreadyMerged: true
    })
    return
  }

  await scheduleMerge(sessionId, async () => {
    const mergedReadyPath = await findMergedFile(sessionId)
    if (mergedReadyPath) {
      const fileStat = await stat(mergedReadyPath)
      json(res, 200, {
        ok: true,
        remoteVideoUrl: `/api/cloud-sync/sessions/${sessionId}/merged`,
        mergedBytes: Number(fileStat.size || 0),
        alreadyMerged: true
      })
      return
    }

    const normalizedParts = [...parts]
      .map((part) => ({
        index: Number(part?.index || 0),
        checksum: String(part?.checksum || '')
          .trim()
          .toLowerCase(),
        filePath: getPartFilePath(sessionId, Number(part?.index || 0))
      }))
      .filter((part) => Number.isInteger(part.index) && part.index > 0 && part.checksum)
      .sort((left, right) => left.index - right.index)

    if (!normalizedParts.length) {
      badRequest(res, 'parts must contain valid index and checksum values.')
      return
    }

    for (const part of normalizedParts) {
      if (!existsSync(part.filePath)) {
        notFound(res)
        return
      }

      const checksum = await sha256File(part.filePath)
      if (checksum !== part.checksum) {
        conflict(res, `Checksum mismatch for part ${part.index}.`)
        return
      }
    }

    const outputFilePath = await mergeSessionFiles(sessionId, extension, normalizedParts)
    await removeSegmentsDir(sessionId)
    const fileStat = await stat(outputFilePath)

    json(res, 200, {
      ok: true,
      remoteVideoUrl: `/api/cloud-sync/sessions/${sessionId}/merged`,
      mergedBytes: Number(fileStat.size || 0),
      alreadyMerged: false
    })
  })
}

async function handleGetMerged(req, res, sessionId) {
  const mergedFilePath = await findMergedFile(sessionId)
  if (!mergedFilePath || !existsSync(mergedFilePath)) {
    notFound(res)
    return
  }

  const fileStat = await stat(mergedFilePath)
  const extension = path.extname(mergedFilePath).slice(1)
  res.writeHead(200, {
    'Content-Type': getMimeTypeByExtension(extension),
    'Content-Length': String(fileStat.size),
    'Cache-Control': 'no-store'
  })
  createReadStream(mergedFilePath).pipe(res)
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = requestUrl.pathname

    if (req.method === 'GET' && pathname === '/healthz') {
      json(res, 200, { ok: true })
      return
    }

    const partMatch = pathname.match(/^\/api\/cloud-sync\/sessions\/([^/]+)\/parts\/(\d+)$/)
    if (req.method === 'PUT' && partMatch) {
      await handleUploadPart(req, res, partMatch[1], Number(partMatch[2]))
      return
    }

    const mergeMatch = pathname.match(/^\/api\/cloud-sync\/sessions\/([^/]+)\/merge$/)
    if (req.method === 'POST' && mergeMatch) {
      await handleMergeSession(req, res, mergeMatch[1])
      return
    }

    const mergedMatch = pathname.match(/^\/api\/cloud-sync\/sessions\/([^/]+)\/merged$/)
    if (req.method === 'GET' && mergedMatch) {
      await handleGetMerged(req, res, mergedMatch[1])
      return
    }

    notFound(res)
  } catch (error) {
    serverError(res, error)
  }
})

async function startCloudSyncServer() {
  await ensureDirectories()

  await new Promise((resolve) => {
    server.listen(PORT, HOST, () => {
      console.log(`[cloud-sync] listening on http://${HOST}:${PORT}`)
      resolve()
    })
  })
}

module.exports = {
  startCloudSyncServer
}
