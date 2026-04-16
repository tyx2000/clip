const crypto = require('node:crypto')
const http = require('node:http')
const { URL } = require('node:url')
const WebSocket = require('ws')
const { createMeetingRoomServer } = require('./meetingRoomServer')
const { createMeetingSfuServer } = require('./meetingSfuServer')
const { MEETING_SIGNAL_TYPES } = require('./meetingSignalProtocol')

const PORT = Number(process.env.SCREEN_SHARE_PORT || 8788)
const HOST = process.env.SCREEN_SHARE_HOST || '127.0.0.1'
const ROOM_IDLE_TTL_MS = 30 * 60 * 1000
const MAX_VIEWERS_PER_ROOM = 4

const roomListSubscribers = new Set()
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

const roomServer = createMeetingRoomServer({
  now,
  createRoomId,
  createPeerId,
  createToken,
  getWsOrigin,
  isSocketOpen,
  maxViewersPerRoom: MAX_VIEWERS_PER_ROOM
})

const {
  hasAnyOnlineParticipant,
  summarizeRoom,
  listRoomSummaries,
  ensureRoom,
  createRoom: createRoomState,
  joinRoom: joinRoomState,
  createRoomLocal: createRoomStateLocal,
  joinRoomLocal: joinRoomStateLocal,
  getRoomSummaryLocal,
  getPeer,
  deleteRoom,
  cleanupRooms: cleanupIdleRooms
} = roomServer
const meetingSfuServer = createMeetingSfuServer()

function sendJson(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return
  }
  socket.send(JSON.stringify(payload))
}

function createRoom(req, ownerUserId = '') {
  const payload = createRoomState(req, ownerUserId)
  broadcastRoomList()
  return payload
}

function joinRoom(req, roomId, userId = '') {
  const payload = joinRoomState(req, roomId, userId)
  if (payload.ok) {
    broadcastRoomList()
  }
  return payload
}

function createRoomLocal(ownerUserId = '') {
  const payload = createRoomStateLocal(ownerUserId)
  broadcastRoomList()
  return payload
}

function joinRoomLocal(roomId, userId = '') {
  const payload = joinRoomStateLocal(roomId, userId)
  if (payload.ok) {
    broadcastRoomList()
  }
  return payload
}

function broadcastRoomList() {
  const payload = {
    type: MEETING_SIGNAL_TYPES.ROOMS_SNAPSHOT,
    rooms: listRoomSummaries()
  }

  for (const socket of roomListSubscribers) {
    sendJson(socket, payload)
  }
}

function broadcastRoomState(room) {
  const payload = {
    type: MEETING_SIGNAL_TYPES.ROOM_STATE,
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
  broadcastRoomList()
}

function closeRoom(room, message = 'Host left the meeting. Room closed.') {
  const payload = {
    type: MEETING_SIGNAL_TYPES.ROOM_CLOSED,
    roomId: room.roomId,
    message
  }

  if (room.host.socket) {
    sendJson(room.host.socket, payload)
  }

  for (const viewer of room.viewers.values()) {
    if (!viewer.socket) {
      continue
    }

    sendJson(viewer.socket, payload)
    viewer.socket.close()
  }

  deleteRoom(room.roomId)
  void meetingSfuServer.closeRoomMedia(room.roomId).catch(() => {})
  broadcastRoomList()
}

function broadcastChatMessage(room, messagePayload) {
  const payload = {
    type: MEETING_SIGNAL_TYPES.CHAT_MESSAGE,
    message: messagePayload
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
    void meetingSfuServer.closeParticipantMedia(room.roomId, peerId).catch(() => {})
    room.host.socket = null
    room.host.audioEnabled = false
    room.shareActive = false
    closeRoom(room, '主持人已离开会议，房间已关闭。')
    return true
  } else {
    void meetingSfuServer.closeParticipantMedia(room.roomId, peerId).catch(() => {})
    const viewer = room.viewers.get(peerId)
    if (viewer) {
      viewer.socket = null
      viewer.audioEnabled = false
    }
    if (room.host.socket) {
      sendJson(room.host.socket, {
        type: MEETING_SIGNAL_TYPES.PEER_LEAVE,
        peerId
      })
    }
  }

  if (!hasAnyOnlineParticipant(room)) {
    closeRoom(room, '会议内已无人在线，房间已关闭。')
    return true
  }

  room.updatedAt = now()
  broadcastRoomState(room)
  return false
}

function removePeer(room, role, peerId) {
  if (role === 'host') {
    handlePeerDisconnect(room, role, peerId)
    return
  }

  const roomClosed = handlePeerDisconnect(room, role, peerId)
  if (roomClosed) {
    return
  }

  room.viewers.delete(peerId)
  if (!hasAnyOnlineParticipant(room)) {
    closeRoom(room, '会议内已无人在线，房间已关闭。')
    return
  }
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
  if (cleanupIdleRooms(cutoff)) {
    broadcastRoomList()
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
      subscriptionType: '',
      roomId: '',
      role: '',
      peerId: ''
    }

    socket.on('message', async (raw) => {
      let message = null
      try {
        message = JSON.parse(String(raw || ''))
      } catch {
        sendJson(socket, {
          type: MEETING_SIGNAL_TYPES.ERROR,
          message: 'Invalid message payload.'
        })
        return
      }

      if (message.type === MEETING_SIGNAL_TYPES.SUBSCRIBE_ROOMS) {
        socketState.subscriptionType = MEETING_SIGNAL_TYPES.SUBSCRIBE_ROOMS
        roomListSubscribers.add(socket)
        sendJson(socket, {
          type: MEETING_SIGNAL_TYPES.ROOMS_SNAPSHOT,
          rooms: listRoomSummaries()
        })
        return
      }

      if (message.type === MEETING_SIGNAL_TYPES.HELLO) {
        const room = ensureRoom(String(message.roomId || ''))
        if (!room) {
          sendJson(socket, { type: MEETING_SIGNAL_TYPES.ERROR, message: 'Room not found.' })
          socket.close()
          return
        }

        const role = String(message.role || '')
        const peerId = String(message.peerId || '')
        const token = String(message.token || '')
        const peer = getPeer(room, role, peerId)
        if (!peer || peer.token !== token) {
          sendJson(socket, { type: MEETING_SIGNAL_TYPES.ERROR, message: 'Invalid room token.' })
          socket.close()
          return
        }

        peer.socket = socket
        socketState.roomId = room.roomId
        socketState.role = role
        socketState.peerId = peerId
        room.updatedAt = now()

        sendJson(socket, {
          type: MEETING_SIGNAL_TYPES.WELCOME,
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
            type: MEETING_SIGNAL_TYPES.PEER_JOIN,
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

      if (message.type === MEETING_SIGNAL_TYPES.GET_ROUTER_RTP_CAPABILITIES) {
        try {
          const rtpCapabilities = await meetingSfuServer.getRouterRtpCapabilities(room.roomId)
          sendJson(socket, {
            type: MEETING_SIGNAL_TYPES.ROUTER_RTP_CAPABILITIES,
            roomId: room.roomId,
            rtpCapabilities
          })
        } catch (error) {
          sendJson(socket, {
            type: MEETING_SIGNAL_TYPES.ERROR,
            message: error instanceof Error ? error.message : 'Failed to create SFU router.'
          })
        }
        return
      }

      if (message.type === MEETING_SIGNAL_TYPES.CREATE_SEND_TRANSPORT) {
        try {
          const transportOptions = await meetingSfuServer.createSendTransport(
            room.roomId,
            socketState.peerId
          )
          sendJson(socket, {
            type: MEETING_SIGNAL_TYPES.SEND_TRANSPORT_CREATED,
            roomId: room.roomId,
            transportOptions
          })
        } catch (error) {
          sendJson(socket, {
            type: MEETING_SIGNAL_TYPES.ERROR,
            message: error instanceof Error ? error.message : 'Failed to create SFU send transport.'
          })
        }
        return
      }

      if (message.type === MEETING_SIGNAL_TYPES.CONNECT_SEND_TRANSPORT) {
        try {
          await meetingSfuServer.connectSendTransport(
            room.roomId,
            socketState.peerId,
            message.dtlsParameters
          )
          sendJson(socket, {
            type: MEETING_SIGNAL_TYPES.CONNECT_SEND_TRANSPORT,
            roomId: room.roomId,
            ok: true
          })
        } catch (error) {
          sendJson(socket, {
            type: MEETING_SIGNAL_TYPES.ERROR,
            message:
              error instanceof Error ? error.message : 'Failed to connect SFU send transport.'
          })
        }
        return
      }

      if (message.type === MEETING_SIGNAL_TYPES.CREATE_RECV_TRANSPORT) {
        try {
          const transportOptions = await meetingSfuServer.createRecvTransport(
            room.roomId,
            socketState.peerId
          )
          sendJson(socket, {
            type: MEETING_SIGNAL_TYPES.RECV_TRANSPORT_CREATED,
            roomId: room.roomId,
            transportOptions
          })
        } catch (error) {
          sendJson(socket, {
            type: MEETING_SIGNAL_TYPES.ERROR,
            message: error instanceof Error ? error.message : 'Failed to create SFU recv transport.'
          })
        }
        return
      }

      if (message.type === MEETING_SIGNAL_TYPES.CONNECT_RECV_TRANSPORT) {
        try {
          await meetingSfuServer.connectRecvTransport(
            room.roomId,
            socketState.peerId,
            message.dtlsParameters
          )
          sendJson(socket, {
            type: MEETING_SIGNAL_TYPES.CONNECT_RECV_TRANSPORT,
            roomId: room.roomId,
            ok: true
          })
        } catch (error) {
          sendJson(socket, {
            type: MEETING_SIGNAL_TYPES.ERROR,
            message:
              error instanceof Error ? error.message : 'Failed to connect SFU recv transport.'
          })
        }
        return
      }

      if (message.type === MEETING_SIGNAL_TYPES.SHARE_STATE && socketState.role === 'host') {
        room.shareActive = Boolean(message.active)
        room.shareOwnerPeerId = room.shareActive ? socketState.peerId : ''
        room.updatedAt = now()
        const eventType = room.shareActive
          ? MEETING_SIGNAL_TYPES.SHARE_STARTED
          : MEETING_SIGNAL_TYPES.SHARE_STOPPED
        for (const viewer of room.viewers.values()) {
          if (viewer.socket) {
            sendJson(viewer.socket, {
              type: eventType,
              peerId: socketState.peerId,
              room: summarizeRoom(room)
            })
          }
        }
        broadcastRoomState(room)
        return
      }

      if (message.type === MEETING_SIGNAL_TYPES.SHARE_STATE) {
        if (socketState.role !== 'host') {
          return
        }
        room.shareActive = Boolean(message.active)
        room.updatedAt = now()
        const eventType = room.shareActive
          ? MEETING_SIGNAL_TYPES.SHARE_STARTED
          : MEETING_SIGNAL_TYPES.SHARE_STOPPED
        const payload = { type: eventType, room: summarizeRoom(room) }
        for (const viewer of room.viewers.values()) {
          if (viewer.socket) {
            sendJson(viewer.socket, payload)
          }
        }
        broadcastRoomState(room)
        return
      }

      if (message.type === MEETING_SIGNAL_TYPES.AUDIO_STATE) {
        const peer = getPeer(room, socketState.role, socketState.peerId)
        if (!peer) {
          return
        }

        peer.audioEnabled = Boolean(message.active)
        room.updatedAt = now()
        broadcastRoomState(room)
        return
      }

      if (message.type === MEETING_SIGNAL_TYPES.CHAT_MESSAGE) {
        const kind = message.kind === 'image' ? 'image' : 'text'
        const text =
          kind === 'text'
            ? String(message.text || '')
                .trim()
                .slice(0, 2000)
            : ''
        const imageDataUrl =
          kind === 'image' ? String(message.imageDataUrl || '').slice(0, 3_000_000) : ''

        if (!text && !imageDataUrl) {
          return
        }

        if (imageDataUrl && !imageDataUrl.startsWith('data:image/')) {
          return
        }

        broadcastChatMessage(room, {
          messageId: randomId('msg-'),
          roomId: room.roomId,
          senderPeerId: socketState.peerId,
          senderRole: socketState.role,
          kind,
          text,
          imageDataUrl,
          createdAt: now()
        })
        return
      }

      if (message.type === MEETING_SIGNAL_TYPES.LEAVE) {
        removePeer(room, socketState.role, socketState.peerId)
        socketState.roomId = ''
        socketState.role = ''
        socketState.peerId = ''
        socket.close()
        return
      }

      if (
        message.type === MEETING_SIGNAL_TYPES.OFFER ||
        message.type === MEETING_SIGNAL_TYPES.ANSWER ||
        message.type === MEETING_SIGNAL_TYPES.ICE_CANDIDATE ||
        message.type === MEETING_SIGNAL_TYPES.RENEGOTIATE_REQUEST
      ) {
        handleSignalMessage(room, socketState, message)
      }
    })

    socket.on('close', () => {
      if (socketState.subscriptionType === MEETING_SIGNAL_TYPES.SUBSCRIBE_ROOMS) {
        roomListSubscribers.delete(socket)
      }

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
