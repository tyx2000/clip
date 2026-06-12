import WebSocket from 'ws'

const ROOMS_EVENT_CHANNEL = 'onScreenShareRoomsSnapshot'
const MEETING_EVENT_CHANNEL = 'onScreenShareMeetingSocketEvent'

// 主进程只负责应用级 socket 生命周期：
// 1. 房间列表 WS 是全局单例，避免多个窗口重复订阅同一份快照。
// 2. 会议信令 WS 按窗口持有，负责 hello/offer/answer/ice/leave 这类控制消息。
// 3. 主进程不持有 RTCPeerConnection、MediaStream、DataChannel，这些都留在 renderer，
//    否则会把浏览器媒体对象和 Electron 进程边界强行搅在一起。
const roomListSubscribers = new Map()
let roomListSocket = null
let roomListReconnectTimer = null
let latestRoomSnapshot = []
let hasReceivedRoomSnapshot = false

// key 为 webContents.id。这里保存的是“窗口对应的信令 socket”，不是媒体连接本身。
const meetingSockets = new Map()

function buildWebSocketUrl(origin) {
  return `${String(origin || '').replace(/^http/i, 'ws')}/ws`
}

function isFatalMeetingSocketError(message) {
  return message === 'Room not found.' || message === 'Invalid room token.'
}

function sendToWebContents(target, channel, payload) {
  if (!target || target.isDestroyed?.()) {
    return
  }

  target.send(channel, payload)
}

function broadcastRoomSnapshot() {
  for (const target of roomListSubscribers.values()) {
    sendToWebContents(target, ROOMS_EVENT_CHANNEL, { rooms: latestRoomSnapshot })
  }
}

function clearRoomListReconnectTimer() {
  if (!roomListReconnectTimer) {
    return
  }

  clearTimeout(roomListReconnectTimer)
  roomListReconnectTimer = null
}

function closeRoomListSocket() {
  clearRoomListReconnectTimer()

  if (!roomListSocket) {
    return
  }

  const socket = roomListSocket
  roomListSocket = null
  socket.close()
}

async function ensureRoomListSocket({ ensureScreenShareServer, getScreenShareServerOrigin }) {
  if (roomListSocket) {
    if (
      roomListSocket.readyState === WebSocket.OPEN ||
      roomListSocket.readyState === WebSocket.CONNECTING
    ) {
      return
    }
  }

  await ensureScreenShareServer()
  clearRoomListReconnectTimer()

  const socket = new WebSocket(buildWebSocketUrl(getScreenShareServerOrigin()))
  roomListSocket = socket

  socket.on('open', () => {
    socket.send(JSON.stringify({ type: 'subscribe-rooms' }))
  })

  socket.on('message', (raw) => {
    let message = null
    try {
      message = JSON.parse(String(raw || ''))
    } catch {
      return
    }

    if (message.type !== 'rooms-snapshot') {
      return
    }

    latestRoomSnapshot = Array.isArray(message.rooms) ? message.rooms : []
    hasReceivedRoomSnapshot = true
    broadcastRoomSnapshot()
  })

  socket.on('close', () => {
    if (roomListSocket === socket) {
      roomListSocket = null
    }

    if (!roomListSubscribers.size) {
      return
    }

    clearRoomListReconnectTimer()
    roomListReconnectTimer = setTimeout(() => {
      void ensureRoomListSocket({ ensureScreenShareServer, getScreenShareServerOrigin })
    }, 1000)
  })

  socket.on('error', () => {
    socket.close()
  })
}

export async function subscribeScreenShareRooms(webContents, deps) {
  roomListSubscribers.set(webContents.id, webContents)

  if (hasReceivedRoomSnapshot) {
    sendToWebContents(webContents, ROOMS_EVENT_CHANNEL, { rooms: latestRoomSnapshot })
  }

  await ensureRoomListSocket(deps)
}

export function unsubscribeScreenShareRooms(webContentsId) {
  roomListSubscribers.delete(webContentsId)

  if (!roomListSubscribers.size) {
    closeRoomListSocket()
  }
}

export async function connectScreenShareMeetingSocket(webContents, payload) {
  const roomId = typeof payload?.roomId === 'string' ? payload.roomId : ''
  const role = typeof payload?.role === 'string' ? payload.role : ''
  const peerId = typeof payload?.peerId === 'string' ? payload.peerId : ''
  const token = typeof payload?.token === 'string' ? payload.token : ''
  const wsUrl = typeof payload?.wsUrl === 'string' ? payload.wsUrl : ''

  if (!roomId || !role || !peerId || !token || !wsUrl) {
    return {
      ok: false,
      message: '会议连接参数不完整。'
    }
  }

  disconnectScreenShareMeetingSocket(webContents.id, {
    sendLeave: false,
    suppressCloseEvent: true
  })

  try {
    const socket = new WebSocket(wsUrl)
    const state = {
      socket,
      suppressCloseEvent: false,
      closeReason: '',
      reconnectable: true
    }

    meetingSockets.set(webContents.id, state)

    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          roomId,
          role,
          peerId,
          token
        })
      )
    })

    socket.on('message', (raw) => {
      let message = null
      try {
        message = JSON.parse(String(raw || ''))
      } catch {
        return
      }

      if (message.type === 'error') {
        state.closeReason = message.message || '房间连接失败。'
        state.reconnectable = !isFatalMeetingSocketError(state.closeReason)
      }

      sendToWebContents(webContents, MEETING_EVENT_CHANNEL, {
        kind: 'message',
        message
      })

      if (message.type === 'error') {
        socket.close()
      }
    })

    socket.on('close', () => {
      if (meetingSockets.get(webContents.id) === state) {
        meetingSockets.delete(webContents.id)
      }

      if (state.suppressCloseEvent) {
        return
      }

      sendToWebContents(webContents, MEETING_EVENT_CHANNEL, {
        kind: 'close',
        closeReason: state.closeReason,
        reconnectable: state.reconnectable
      })
    })

    socket.on('error', (error) => {
      if (!state.closeReason) {
        state.closeReason =
          error instanceof Error ? error.message : 'Failed to connect room socket.'
      }
      socket.close()
    })

    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '房间连接失败。'
    }
  }
}

export function sendScreenShareMeetingMessage(webContentsId, payload) {
  const state = meetingSockets.get(webContentsId)
  if (!state || state.socket.readyState !== WebSocket.OPEN) {
    return { ok: false, message: '会议连接未建立。' }
  }

  try {
    state.socket.send(JSON.stringify(payload || {}))
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '会议消息发送失败。'
    }
  }
}

export function disconnectScreenShareMeetingSocket(
  webContentsId,
  { sendLeave = false, suppressCloseEvent = true } = {}
) {
  const state = meetingSockets.get(webContentsId)
  if (!state) {
    return { ok: true }
  }

  meetingSockets.delete(webContentsId)
  state.suppressCloseEvent = suppressCloseEvent

  if (sendLeave && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: 'leave' }))
  }

  state.socket.close()
  return { ok: true }
}

export function cleanupShareSocketsForWebContents(webContentsId) {
  unsubscribeScreenShareRooms(webContentsId)
  disconnectScreenShareMeetingSocket(webContentsId, {
    sendLeave: true,
    suppressCloseEvent: true
  })
}
