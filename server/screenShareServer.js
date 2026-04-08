const crypto = require('node:crypto')
const http = require('node:http')
const { URL } = require('node:url')
const WebSocket = require('ws')

const PORT = Number(process.env.SCREEN_SHARE_PORT || 8788)
const HOST = process.env.SCREEN_SHARE_HOST || '127.0.0.1'
const ROOM_IDLE_TTL_MS = 30 * 60 * 1000
const MAX_VIEWERS_PER_ROOM = 4

const rooms = new Map()
let screenShareServerPromise = null

function getScreenShareServerOrigin() {
  return `http://${HOST}:${PORT}`
}

function now() {
  return Date.now()
}

function randomId(prefix = '') {
  return `${prefix}${crypto.randomBytes(4).toString('hex')}`
}

function createRoomId() {
  return randomId('room-')
}

function createPeerId(role) {
  return role === 'host' ? 'host' : randomId('viewer-')
}

function createToken() {
  return crypto.randomBytes(16).toString('hex')
}

function isSocketOpen(socket) {
  return Boolean(socket && socket.readyState === WebSocket.OPEN)
}

function getOnlineViewerCount(room) {
  let count = 0
  for (const viewer of room.viewers.values()) {
    if (isSocketOpen(viewer.socket)) {
      count += 1
    }
  }
  return count
}

function getWsOrigin(req) {
  const host = req?.headers?.host || `${HOST}:${PORT}`
  return `ws://${host}`
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  res.end(body)
}

function notFound(res) {
  json(res, 404, { ok: false, message: 'Room not found.' })
}

function badRequest(res, message) {
  json(res, 400, { ok: false, message })
}

function conflict(res, message) {
  json(res, 409, { ok: false, message })
}

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

function summarizeRoom(room) {
  return {
    roomId: room.roomId,
    hostPresent: isSocketOpen(room.host?.socket),
    viewerCount: getOnlineViewerCount(room),
    shareActive: room.shareActive,
    role: room.role || 'host'
  }
}

function ensureRoom(roomId) {
  const room = rooms.get(roomId)
  if (!room) {
    return null
  }
  room.updatedAt = now()
  return room
}

function createRoom(req) {
  const roomId = createRoomId()
  const hostToken = createToken()
  const room = {
    roomId,
    createdAt: now(),
    updatedAt: now(),
    shareActive: false,
    host: {
      peerId: 'host',
      token: hostToken,
      socket: null
    },
    viewers: new Map()
  }
  rooms.set(roomId, room)

  const wsOrigin = getWsOrigin(req)
  return {
    ok: true,
    roomId,
    role: 'host',
    peerId: 'host',
    token: hostToken,
    wsUrl: `${wsOrigin}/ws`,
    ...summarizeRoom(room)
  }
}

function joinRoom(req, roomId) {
  const room = ensureRoom(roomId)
  if (!room) {
    return { ok: false, statusCode: 404, message: 'Room not found.' }
  }

  if (getOnlineViewerCount(room) >= MAX_VIEWERS_PER_ROOM) {
    return { ok: false, statusCode: 409, message: 'Viewer limit reached.' }
  }

  const peerId = createPeerId('viewer')
  const token = createToken()
  room.viewers.set(peerId, {
    peerId,
    token,
    socket: null
  })
  room.updatedAt = now()

  return {
    ok: true,
    roomId,
    role: 'viewer',
    peerId,
    token,
    wsUrl: `${getWsOrigin(req)}/ws`,
    ...summarizeRoom(room)
  }
}

function createRoomLocal() {
  return createRoom(null)
}

function joinRoomLocal(roomId) {
  return joinRoom(null, roomId)
}

function getRoomSummaryLocal(roomId) {
  const room = ensureRoom(roomId)
  if (!room) {
    return null
  }

  return {
    ok: true,
    ...summarizeRoom(room)
  }
}

function getPeer(room, role, peerId) {
  if (role === 'host') {
    return room.host.peerId === peerId ? room.host : null
  }
  return room.viewers.get(peerId) || null
}

function sendJson(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return
  }
  socket.send(JSON.stringify(payload))
}

function broadcastRoomState(room) {
  const payload = {
    type: 'room-state',
    room: summarizeRoom(room)
  }
  if (room.host.socket) {
    sendJson(room.host.socket, payload)
  }
  for (const viewer of room.viewers.values()) {
    if (viewer.socket) {
      sendJson(viewer.socket, payload)
    }
  }
}

function handlePeerDisconnect(room, role, peerId) {
  if (role === 'host') {
    room.host.socket = null
    room.shareActive = false
    for (const viewer of room.viewers.values()) {
      if (viewer.socket) {
        sendJson(viewer.socket, {
          type: 'share-stopped',
          room: summarizeRoom(room)
        })
      }
    }
  } else {
    const viewer = room.viewers.get(peerId)
    if (viewer) {
      viewer.socket = null
    }
    if (room.host.socket) {
      sendJson(room.host.socket, {
        type: 'peer-leave',
        peerId
      })
    }
  }

  room.updatedAt = now()
  broadcastRoomState(room)
}

function removePeer(room, role, peerId) {
  if (role === 'host') {
    handlePeerDisconnect(room, role, peerId)
    return
  }

  handlePeerDisconnect(room, role, peerId)
  room.viewers.delete(peerId)
  room.updatedAt = now()
  broadcastRoomState(room)
}

function handleSignalMessage(room, socketState, message) {
  const targetPeerId = typeof message.targetPeerId === 'string' ? message.targetPeerId : ''
  if (!targetPeerId) {
    return
  }

  const target = targetPeerId === 'host' ? room.host : room.viewers.get(targetPeerId) || null
  if (!target?.socket) {
    return
  }

  sendJson(target.socket, {
    type: message.type,
    fromPeerId: socketState.peerId,
    targetPeerId,
    payload: message.payload || null
  })
}

function cleanupRooms() {
  const cutoff = now() - ROOM_IDLE_TTL_MS
  for (const [roomId, room] of rooms.entries()) {
    const hostOnline = isSocketOpen(room.host?.socket)
    const hasOnlineViewer = [...room.viewers.values()].some((viewer) => isSocketOpen(viewer.socket))
    if (!hostOnline && !hasOnlineViewer && room.updatedAt < cutoff) {
      rooms.delete(roomId)
    }
  }
}

function startScreenShareServer() {
  if (screenShareServerPromise) {
    return screenShareServerPromise
  }

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(
        req.url || '/',
        `http://${req?.headers?.host || `${HOST}:${PORT}`}`
      )
      const pathname = requestUrl.pathname

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Cache-Control': 'no-store'
        })
        res.end()
        return
      }

      if (req.method === 'GET' && pathname === '/healthz') {
        json(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && pathname === '/api/screen-share/rooms') {
        json(res, 201, createRoom(req))
        return
      }

      const joinMatch = pathname.match(/^\/api\/screen-share\/rooms\/([^/]+)\/join$/)
      if (req.method === 'POST' && joinMatch) {
        await parseJsonBody(req).catch(() => ({}))
        const payload = joinRoom(req, decodeURIComponent(joinMatch[1]))
        if (!payload.ok) {
          if (payload.statusCode === 404) {
            notFound(res)
            return
          }
          if (payload.statusCode === 409) {
            conflict(res, payload.message)
            return
          }
          badRequest(res, payload.message)
          return
        }
        json(res, 200, payload)
        return
      }

      const roomMatch = pathname.match(/^\/api\/screen-share\/rooms\/([^/]+)$/)
      if (req.method === 'GET' && roomMatch) {
        const room = ensureRoom(decodeURIComponent(roomMatch[1]))
        if (!room) {
          notFound(res)
          return
        }
        json(res, 200, {
          ok: true,
          ...summarizeRoom(room)
        })
        return
      }

      json(res, 404, { ok: false, message: 'Not found.' })
    } catch (error) {
      json(res, 500, {
        ok: false,
        message: error instanceof Error ? error.message : 'Internal server error.'
      })
    }
  })

  const wss = new WebSocket.Server({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const requestUrl = new URL(req.url || '/', `http://${req?.headers?.host || `${HOST}:${PORT}`}`)
    if (requestUrl.pathname !== '/ws') {
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (socket) => {
    const socketState = {
      roomId: '',
      role: '',
      peerId: ''
    }

    socket.on('message', async (raw) => {
      let message = null
      try {
        message = JSON.parse(String(raw || ''))
      } catch {
        sendJson(socket, { type: 'error', message: 'Invalid message payload.' })
        return
      }

      if (message.type === 'hello') {
        const room = ensureRoom(String(message.roomId || ''))
        if (!room) {
          sendJson(socket, { type: 'error', message: 'Room not found.' })
          socket.close()
          return
        }

        const role = String(message.role || '')
        const peerId = String(message.peerId || '')
        const token = String(message.token || '')
        const peer = getPeer(room, role, peerId)
        if (!peer || peer.token !== token) {
          sendJson(socket, { type: 'error', message: 'Invalid room token.' })
          socket.close()
          return
        }

        peer.socket = socket
        socketState.roomId = room.roomId
        socketState.role = role
        socketState.peerId = peerId
        room.updatedAt = now()

        sendJson(socket, {
          type: 'welcome',
          room: summarizeRoom(room),
          role,
          peerId,
          viewerPeerIds:
            role === 'host'
              ? [...room.viewers.values()]
                  .filter((viewer) => isSocketOpen(viewer.socket))
                  .map((viewer) => viewer.peerId)
              : []
        })

        if (role === 'viewer' && room.host.socket) {
          sendJson(room.host.socket, {
            type: 'peer-join',
            peerId
          })
        }

        broadcastRoomState(room)
        return
      }

      const room = ensureRoom(socketState.roomId)
      if (!room) {
        return
      }

      if (message.type === 'share-state' && socketState.role === 'host') {
        room.shareActive = Boolean(message.active)
        room.updatedAt = now()
        const eventType = room.shareActive ? 'share-started' : 'share-stopped'
        for (const viewer of room.viewers.values()) {
          if (viewer.socket) {
            sendJson(viewer.socket, {
              type: eventType,
              room: summarizeRoom(room)
            })
          }
        }
        broadcastRoomState(room)
        return
      }

      if (message.type === 'leave') {
        removePeer(room, socketState.role, socketState.peerId)
        socketState.roomId = ''
        socketState.role = ''
        socketState.peerId = ''
        socket.close()
        return
      }

      if (
        message.type === 'offer' ||
        message.type === 'answer' ||
        message.type === 'ice-candidate' ||
        message.type === 'renegotiate-request'
      ) {
        handleSignalMessage(room, socketState, message)
      }
    })

    socket.on('close', () => {
      const room = ensureRoom(socketState.roomId)
      if (!room) {
        return
      }
      handlePeerDisconnect(room, socketState.role, socketState.peerId)
    })
  })

  const cleanupTimer = setInterval(cleanupRooms, 60_000)
  cleanupTimer.unref()

  screenShareServerPromise = new Promise((resolve, reject) => {
    server.once('error', (error) => {
      screenShareServerPromise = null
      reject(error)
    })

    server.listen(PORT, HOST, () => {
      console.log(`[screen-share] listening on http://${HOST}:${PORT}`)
      resolve({ server, wss })
    })
  })

  return screenShareServerPromise
}

module.exports = {
  startScreenShareServer,
  getScreenShareServerOrigin,
  createRoomLocal,
  joinRoomLocal,
  getRoomSummaryLocal
}
