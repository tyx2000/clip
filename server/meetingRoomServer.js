const DEFAULT_OWNER_ROLE = 'host'

function createMeetingRoomServer({
  now,
  createRoomId,
  createPeerId,
  createToken,
  getWsOrigin,
  isSocketOpen,
  maxViewersPerRoom
}) {
  const rooms = new Map()

  function getOnlineViewerCount(room) {
    let count = 0
    for (const viewer of room.viewers.values()) {
      if (isSocketOpen(viewer.socket)) {
        count += 1
      }
    }
    return count
  }

  function hasAnyOnlineParticipant(room) {
    return isSocketOpen(room.host?.socket) || getOnlineViewerCount(room) > 0
  }

  function summarizeParticipants(room) {
    const participants = [
      {
        peerId: room.host.peerId,
        userId: room.host.userId || '',
        role: 'host',
        connected: isSocketOpen(room.host.socket),
        audioEnabled: Boolean(room.host.audioEnabled)
      }
    ]

    for (const viewer of room.viewers.values()) {
      participants.push({
        peerId: viewer.peerId,
        userId: viewer.userId || '',
        role: 'viewer',
        connected: isSocketOpen(viewer.socket),
        audioEnabled: Boolean(viewer.audioEnabled)
      })
    }

    return participants
  }

  function summarizeRoom(room) {
    return {
      roomId: room.roomId,
      ownerUserId: room.ownerUserId || '',
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      hostPresent: isSocketOpen(room.host?.socket),
      viewerCount: getOnlineViewerCount(room),
      shareActive: room.shareActive,
      participants: summarizeParticipants(room),
      role: room.role || DEFAULT_OWNER_ROLE
    }
  }

  function listRoomSummaries() {
    return [...rooms.values()]
      .map((room) => summarizeRoom(room))
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  function ensureRoom(roomId) {
    const room = rooms.get(roomId)
    if (!room) {
      return null
    }
    room.updatedAt = now()
    return room
  }

  function createRoom(req, ownerUserId = '') {
    const roomId = createRoomId()
    const hostToken = createToken()
    const room = {
      roomId,
      ownerUserId,
      createdAt: now(),
      updatedAt: now(),
      shareActive: false,
      shareOwnerPeerId: '',
      host: {
        peerId: 'host',
        userId: ownerUserId,
        token: hostToken,
        socket: null,
        audioEnabled: false
      },
      viewers: new Map()
    }
    rooms.set(roomId, room)

    return {
      ok: true,
      roomId,
      role: 'host',
      peerId: 'host',
      token: hostToken,
      wsUrl: `${getWsOrigin(req)}/ws`,
      ...summarizeRoom(room)
    }
  }

  function joinRoom(req, roomId, userId = '') {
    const room = ensureRoom(roomId)
    if (!room) {
      return { ok: false, statusCode: 404, message: 'Room not found.' }
    }

    if (getOnlineViewerCount(room) >= maxViewersPerRoom) {
      return { ok: false, statusCode: 409, message: 'Viewer limit reached.' }
    }

    const peerId = createPeerId('viewer')
    const token = createToken()
    room.viewers.set(peerId, {
      peerId,
      userId,
      token,
      socket: null,
      audioEnabled: false
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

  function createRoomLocal(ownerUserId = '') {
    return createRoom(null, ownerUserId)
  }

  function joinRoomLocal(roomId, userId = '') {
    return joinRoom(null, roomId, userId)
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

  function deleteRoom(roomId) {
    rooms.delete(roomId)
  }

  function cleanupRooms(cutoffTimestamp) {
    let changed = false
    for (const [roomId, room] of rooms.entries()) {
      const hostOnline = isSocketOpen(room.host?.socket)
      const hasOnlineViewer = [...room.viewers.values()].some((viewer) =>
        isSocketOpen(viewer.socket)
      )
      if (!hostOnline && !hasOnlineViewer && room.updatedAt < cutoffTimestamp) {
        rooms.delete(roomId)
        changed = true
      }
    }

    return changed
  }

  return {
    getOnlineViewerCount,
    hasAnyOnlineParticipant,
    summarizeRoom,
    listRoomSummaries,
    ensureRoom,
    createRoom,
    joinRoom,
    createRoomLocal,
    joinRoomLocal,
    getRoomSummaryLocal,
    getPeer,
    deleteRoom,
    cleanupRooms
  }
}

module.exports = {
  createMeetingRoomServer
}
