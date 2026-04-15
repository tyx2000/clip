export const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]
export const CHAT_DATA_CHANNEL_LABEL = 'meeting-chat'
export const CHAT_CHUNK_SIZE = 16 * 1024

export function createPeerConnection() {
  return new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS })
}

export function createEmptySession() {
  return {
    roomId: '',
    role: '',
    peerId: '',
    token: '',
    wsUrl: ''
  }
}

export function getReconnectDelay(attempt) {
  return Math.min(1000 * attempt, 4000)
}

export function hasEnabledTrack(stream) {
  return Boolean(stream?.getTracks().some((track) => track.enabled))
}

export function createTransferId(prefix = 'chat-transfer-') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}${crypto.randomUUID()}`
  }

  return `${prefix}${Math.random().toString(16).slice(2, 10)}`
}

export function normalizeRoomParticipants({
  room = null,
  previousRoom = null,
  session = null,
  initialSessionPayload = null,
  currentUserId = ''
}) {
  const participants = Array.isArray(room?.participants)
    ? [...room.participants]
    : Array.isArray(previousRoom?.participants)
      ? [...previousRoom.participants]
      : []

  const hostPeerId =
    participants.find((participant) => participant?.role === 'host')?.peerId ||
    (session?.role === 'host' ? session?.peerId || 'host' : '') ||
    (initialSessionPayload?.role === 'host' ? initialSessionPayload?.peerId || 'host' : '') ||
    'host'

  if (!participants.some((participant) => participant?.role === 'host')) {
    participants.unshift({
      peerId: hostPeerId,
      userId:
        room?.ownerUserId || previousRoom?.ownerUserId || initialSessionPayload?.ownerUserId || '',
      role: 'host',
      connected:
        typeof room?.hostPresent === 'boolean'
          ? room.hostPresent
          : typeof previousRoom?.hostPresent === 'boolean'
            ? previousRoom.hostPresent
            : Boolean(session?.role === 'host' || initialSessionPayload?.role === 'host'),
      audioEnabled: false
    })
  }

  const currentRole =
    session?.role || previousRoom?.role || room?.role || initialSessionPayload?.role || ''
  const currentPeerId =
    session?.peerId ||
    previousRoom?.peerId ||
    room?.peerId ||
    initialSessionPayload?.peerId ||
    (currentRole === 'host' ? 'host' : '')

  if (
    currentRole &&
    currentPeerId &&
    !participants.some((participant) => participant?.peerId === currentPeerId)
  ) {
    participants.push({
      peerId: currentPeerId,
      userId:
        currentRole === 'host'
          ? room?.ownerUserId ||
            previousRoom?.ownerUserId ||
            initialSessionPayload?.ownerUserId ||
            currentUserId
          : currentUserId,
      role: currentRole,
      connected: true,
      audioEnabled: false
    })
  }

  return participants
}

export function sendChunkedDataChannelPayload(channel, payload) {
  if (!channel || channel.readyState !== 'open') {
    return false
  }

  const serialized = JSON.stringify(payload || {})
  const totalChunks = Math.max(1, Math.ceil(serialized.length / CHAT_CHUNK_SIZE))
  const transferId = createTransferId()

  channel.send(JSON.stringify({ type: 'chat-transfer-meta', transferId, totalChunks }))
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * CHAT_CHUNK_SIZE
    channel.send(
      JSON.stringify({
        type: 'chat-transfer-chunk',
        transferId,
        index,
        chunk: serialized.slice(start, start + CHAT_CHUNK_SIZE)
      })
    )
  }

  return true
}

export function consumeIncomingDataChannelPacket({ packet, peerId = '', transfers, onPayload }) {
  if (packet.type === 'chat-transfer-meta') {
    transfers.set(`${peerId}:${packet.transferId}`, {
      totalChunks: Number(packet.totalChunks || 0),
      chunks: []
    })
    return
  }

  if (packet.type !== 'chat-transfer-chunk') {
    onPayload(packet, peerId)
    return
  }

  const key = `${peerId}:${packet.transferId}`
  const transfer = transfers.get(key)
  if (!transfer) {
    return
  }

  transfer.chunks[packet.index] = String(packet.chunk || '')
  const receivedChunks = transfer.chunks.filter(Boolean).length
  if (receivedChunks < transfer.totalChunks) {
    return
  }

  transfers.delete(key)

  try {
    const payload = JSON.parse(transfer.chunks.join(''))
    onPayload(payload, peerId)
  } catch {
    // Ignore malformed payloads from incomplete or invalid transfers.
  }
}

export function resolveMeetingRole(nextSession, messageRole = '') {
  return nextSession?.role || messageRole || 'host'
}

export function resolveMeetingShareState(hasDisplayStream, shareActive) {
  return hasDisplayStream ? 'sharing' : shareActive ? 'sharing' : 'idle'
}

export function buildMeetingWelcomeStatusMessage({
  role,
  reconnect,
  hasDisplayStream,
  shareActive
}) {
  if (role === 'host') {
    if (reconnect) {
      return hasDisplayStream
        ? '会议已重新连接，正在恢复静音语音链路和桌面共享。'
        : '会议已重新连接，当前默认静音。'
    }

    return '会议房间已创建，语音链路已建立，当前默认静音。'
  }

  if (reconnect) {
    return shareActive
      ? '已重新加入会议，正在恢复共享画面，当前默认静音。'
      : '已重新加入会议，当前默认静音。'
  }

  return shareActive ? '已加入会议，正在接入共享画面，当前默认静音。' : '已加入会议，当前默认静音。'
}

export function buildMeetingReconnectStatusMessage({ role, attempt, hasDisplayStream }) {
  if (role === 'host') {
    return hasDisplayStream
      ? `会议连接中断，正在重连并恢复语音与桌面共享（第 ${attempt} 次）...`
      : `会议连接中断，正在重连并恢复语音通话（第 ${attempt} 次）...`
  }

  return `会议连接中断，正在重新加入房间（第 ${attempt} 次）...`
}

export function buildMeetingReconnectFailedStatusMessage(role) {
  return role === 'host'
    ? '会议连接已断开，多次重连失败，请重新进入会议。'
    : '会议连接已断开，多次重连失败，请重新加入会议。'
}
