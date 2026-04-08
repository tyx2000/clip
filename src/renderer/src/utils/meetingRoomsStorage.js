const STORAGE_KEY = 'clip-meeting-rooms'

function getStorage() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  return window.localStorage
}

export function readMeetingRooms() {
  const storage = getStorage()
  if (!storage) {
    return []
  }

  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function writeMeetingRooms(items) {
  const storage = getStorage()
  if (!storage) {
    return
  }

  storage.setItem(STORAGE_KEY, JSON.stringify(items))
}

export function upsertMeetingRoom(room) {
  const nextItems = [...readMeetingRooms()]
  const index = nextItems.findIndex((item) => item.roomId === room.roomId)

  if (index >= 0) {
    nextItems[index] = {
      ...nextItems[index],
      ...room
    }
  } else {
    nextItems.unshift(room)
  }

  writeMeetingRooms(nextItems)
  return nextItems
}

export function removeMeetingRoom(roomId) {
  const nextItems = readMeetingRooms().filter((item) => item.roomId !== roomId)
  writeMeetingRooms(nextItems)
  return nextItems
}
