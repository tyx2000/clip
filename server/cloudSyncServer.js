const http = require('node:http')
const crypto = require('node:crypto')
const { existsSync, createReadStream } = require('node:fs')
const {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile
} = require('node:fs/promises')
const path = require('node:path')

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const DATA_DIR = path.join(__dirname, 'data')
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
const SESSION_MANIFEST = 'manifest.json'

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
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
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

/** Returns the manifest path for one remote session. */
function getManifestPath(sessionId) {
  return path.join(getSessionDir(sessionId), SESSION_MANIFEST)
}

/** Returns the directory that stores uploaded part files. */
function getSegmentsDir(sessionId) {
  return path.join(getSessionDir(sessionId), 'segments')
}

/** Returns the directory that stores the merged remote output. */
function getMergedDir(sessionId) {
  return path.join(getSessionDir(sessionId), 'merged')
}

/** Creates the initial server-side session manifest. */
function createSessionState(payload) {
  return {
    version: 1,
    sessionId: payload.sessionId,
    mimeType: payload.mimeType || 'video/webm',
    extension: payload.extension || 'webm',
    segmentDurationMs: Number(payload.segmentDurationMs || 5000),
    startedAt: Number(payload.startedAt || Date.now()),
    stoppedAt: null,
    expectedPartCount: null,
    totalBytes: 0,
    uploadStatus: 'receiving',
    mergeStatus: 'pending',
    remoteVideoPath: '',
    remoteVideoUrl: '',
    lastError: '',
    uploadedParts: 0,
    parts: []
  }
}

/** Returns the normalized parts array from a manifest object. */
function getManifestParts(manifest) {
  return Array.isArray(manifest.parts) ? manifest.parts : []
}

/** Atomically writes the server manifest to disk. */
async function writeManifest(sessionId, manifest) {
  const manifestPath = getManifestPath(sessionId)
  const tempPath = `${manifestPath}.tmp`
  await writeFile(tempPath, JSON.stringify(manifest, null, 2), 'utf8')
  await rename(tempPath, manifestPath)
}

/** Reads one server manifest from disk. */
async function readManifest(sessionId) {
  const manifestPath = getManifestPath(sessionId)
  const content = await readFile(manifestPath, 'utf8')
  return JSON.parse(content)
}

/** Produces the public session status payload returned to clients. */
function summarizeSession(manifest) {
  const parts = getManifestParts(manifest)
  const totalParts = Number(manifest.expectedPartCount || parts.length || 0)

  return {
    ok: true,
    sessionId: manifest.sessionId,
    uploadStatus: manifest.uploadStatus,
    mergeStatus: manifest.mergeStatus,
    uploadedParts: Number(manifest.uploadedParts || 0),
    totalParts,
    remoteVideoUrl: manifest.remoteVideoUrl || '',
    remoteVideoPath: manifest.remoteVideoPath || '',
    lastError: manifest.lastError || ''
  }
}

/** Merges all uploaded parts by byte order once the session is complete. */
async function mergeUploadedSession(sessionId) {
  const manifest = await readManifest(sessionId)
  const readyParts = [...getManifestParts(manifest)]
    .filter((part) => part.uploadStatus === 'uploaded')
    .sort((a, b) => a.index - b.index)

  if (!manifest.stoppedAt) {
    return
  }

  const expectedCount = Number(manifest.expectedPartCount || 0)
  if (!expectedCount || readyParts.length !== expectedCount) {
    return
  }

  manifest.mergeStatus = 'merging'
  manifest.uploadStatus = 'uploaded'
  manifest.lastError = ''
  await writeManifest(sessionId, manifest)

  try {
    const mergedDir = getMergedDir(sessionId)
    await mkdir(mergedDir, { recursive: true })
    const outputFilePath = path.join(mergedDir, `merged.${manifest.extension}`)

    if (readyParts.length === 1) {
      await copyFile(readyParts[0].serverPath, outputFilePath)
    } else {
      await writeFile(outputFilePath, Buffer.alloc(0))
      for (const part of readyParts) {
        const body = await readFile(part.serverPath)
        await appendFile(outputFilePath, body)
      }
    }

    manifest.mergeStatus = 'merged'
    manifest.remoteVideoPath = outputFilePath
    manifest.remoteVideoUrl = `/api/cloud-sync/sessions/${sessionId}/merged`
    manifest.lastError = ''
    await writeManifest(sessionId, manifest)
  } catch (error) {
    manifest.mergeStatus = 'merge_failed'
    manifest.lastError = error instanceof Error ? error.message : 'Failed to merge session.'
    await writeManifest(sessionId, manifest)
    throw error
  }
}

/** Serializes merge work per session to avoid duplicate merge races. */
function scheduleMerge(sessionId) {
  const current = mergeQueue.get(sessionId) || Promise.resolve()
  const next = current
    .catch(() => {})
    .then(async () => {
      await mergeUploadedSession(sessionId)
    })
    .finally(() => {
      if (mergeQueue.get(sessionId) === next) {
        mergeQueue.delete(sessionId)
      }
    })

  mergeQueue.set(sessionId, next)
  return next
}

/** Creates a new remote cloud-sync session. */
async function handleCreateSession(req, res) {
  const payload = await parseJsonBody(req)
  const sessionId = String(payload.sessionId || '').trim()
  if (!sessionId) {
    badRequest(res, 'sessionId is required.')
    return
  }

  const sessionDir = getSessionDir(sessionId)
  const manifestPath = getManifestPath(sessionId)
  if (existsSync(sessionDir) || existsSync(manifestPath)) {
    json(res, 200, {
      ok: true,
      sessionId,
      uploadToken: `session:${sessionId}`,
      alreadyExists: true
    })
    return
  }

  await mkdir(getSegmentsDir(sessionId), { recursive: true })
  await mkdir(getMergedDir(sessionId), { recursive: true })

  const manifest = createSessionState(payload)
  await writeManifest(sessionId, manifest)

  json(res, 201, {
    ok: true,
    sessionId,
    uploadToken: `session:${sessionId}`,
    alreadyExists: false
  })
}

/** Stores one uploaded part, verifies integrity, and schedules merge when possible. */
async function handleUploadPart(req, res, sessionId, partIndex) {
  if (!existsSync(getManifestPath(sessionId))) {
    notFound(res)
    return
  }

  const manifest = await readManifest(sessionId)
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

  const existing = getManifestParts(manifest).find((part) => part.index === partIndex)
  if (existing && existing.checksum === checksum && existing.uploadStatus === 'uploaded') {
    json(res, 200, {
      ok: true,
      sessionId,
      partIndex,
      etag: existing.etag || checksum,
      alreadyExisted: true
    })
    return
  }

  if (existing && existing.checksum && existing.checksum !== checksum) {
    json(res, 409, {
      ok: false,
      message: 'Conflicting part checksum for the same part index.'
    })
    return
  }

  await mkdir(getSegmentsDir(sessionId), { recursive: true })
  const ext = manifest.extension || 'webm'
  const fileName = `part-${String(partIndex).padStart(4, '0')}.${ext}`
  const filePath = path.join(getSegmentsDir(sessionId), fileName)
  const tempPath = `${filePath}.tmp`
  await writeFile(tempPath, body)
  await rename(tempPath, filePath)

  const checksumFromFile = await sha256File(filePath)
  if (checksumFromFile !== checksum) {
    badRequest(res, 'Checksum verification failed after write.')
    return
  }

  const fileStat = await stat(filePath)
  const nextPart = {
    index: partIndex,
    fileName,
    serverPath: filePath,
    bytes: Number(fileStat.size || body.length),
    checksum,
    uploadStatus: 'uploaded',
    retryCount: existing?.retryCount || 0,
    etag: checksum,
    uploadedAt: Date.now()
  }

  const nextParts = getManifestParts(manifest)
    .filter((part) => part.index !== partIndex)
    .concat(nextPart)
    .sort((a, b) => a.index - b.index)
  manifest.parts = nextParts
  manifest.uploadedParts = nextParts.filter((part) => part.uploadStatus === 'uploaded').length
  manifest.totalBytes = nextParts.reduce((sum, part) => sum + Number(part.bytes || 0), 0)
  manifest.uploadStatus = manifest.stoppedAt ? 'uploading' : 'receiving'
  manifest.lastError = ''
  await writeManifest(sessionId, manifest)

  if (manifest.stoppedAt) {
    scheduleMerge(sessionId).catch(() => {})
  }

  json(res, 200, {
    ok: true,
    sessionId,
    partIndex,
    etag: checksum,
    alreadyExisted: false
  })
}

async function handleCompleteSession(req, res, sessionId) {
  if (!existsSync(getManifestPath(sessionId))) {
    notFound(res)
    return
  }

  const payload = await parseJsonBody(req)
  const manifest = await readManifest(sessionId)
  manifest.stoppedAt = Number(payload.stoppedAt || Date.now())
  const partCount = Number(payload.partCount || getManifestParts(manifest).length || 0)
  manifest.expectedPartCount = partCount
  manifest.totalBytes = Number(payload.totalBytes || manifest.totalBytes || 0)
  manifest.uploadStatus =
    Number(manifest.uploadedParts || 0) >= partCount ? 'uploaded' : 'uploading'
  manifest.lastError = ''
  await writeManifest(sessionId, manifest)

  scheduleMerge(sessionId).catch(() => {})
  json(res, 200, summarizeSession(await readManifest(sessionId)))
}

async function handleGetSession(res, sessionId) {
  if (!existsSync(getManifestPath(sessionId))) {
    notFound(res)
    return
  }

  const manifest = await readManifest(sessionId)
  json(res, 200, summarizeSession(manifest))
}

async function handleGetMerged(req, res, sessionId) {
  if (!existsSync(getManifestPath(sessionId))) {
    notFound(res)
    return
  }

  const manifest = await readManifest(sessionId)
  if (!manifest.remoteVideoPath || !existsSync(manifest.remoteVideoPath)) {
    notFound(res)
    return
  }

  const fileStat = await stat(manifest.remoteVideoPath)
  res.writeHead(200, {
    'Content-Type': 'video/webm',
    'Content-Length': String(fileStat.size),
    'Cache-Control': 'no-store'
  })
  createReadStream(manifest.remoteVideoPath).pipe(res)
}

async function bootstrapFromDisk() {
  await ensureDirectories()
  const entries = await readdir(SESSIONS_DIR, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const sessionId = entry.name
    if (existsSync(getManifestPath(sessionId))) {
      scheduleMerge(sessionId).catch(() => {})
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = requestUrl.pathname

    if (req.method === 'GET' && pathname === '/healthz') {
      json(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && pathname === '/api/cloud-sync/sessions') {
      await handleCreateSession(req, res)
      return
    }

    const partMatch = pathname.match(/^\/api\/cloud-sync\/sessions\/([^/]+)\/parts\/(\d+)$/)
    if (req.method === 'PUT' && partMatch) {
      await handleUploadPart(req, res, partMatch[1], Number(partMatch[2]))
      return
    }

    const completeMatch = pathname.match(/^\/api\/cloud-sync\/sessions\/([^/]+)\/complete$/)
    if (req.method === 'POST' && completeMatch) {
      await handleCompleteSession(req, res, completeMatch[1])
      return
    }

    const mergedMatch = pathname.match(/^\/api\/cloud-sync\/sessions\/([^/]+)\/merged$/)
    if (req.method === 'GET' && mergedMatch) {
      await handleGetMerged(req, res, mergedMatch[1])
      return
    }

    const sessionMatch = pathname.match(/^\/api\/cloud-sync\/sessions\/([^/]+)$/)
    if (req.method === 'GET' && sessionMatch) {
      await handleGetSession(res, sessionMatch[1])
      return
    }

    notFound(res)
  } catch (error) {
    serverError(res, error)
  }
})

async function startCloudSyncServer() {
  await bootstrapFromDisk()

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
