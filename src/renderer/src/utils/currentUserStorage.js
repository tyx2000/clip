const STORAGE_KEY = 'clip-current-user-id'

function getStorage() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  return window.localStorage
}

function createRandomUserId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `user-${Math.random().toString(16).slice(2, 10)}`
}

export function ensureCurrentUserId() {
  const storage = getStorage()
  if (!storage) {
    return createRandomUserId()
  }

  const existing = storage.getItem(STORAGE_KEY)
  if (existing) {
    return existing
  }

  const nextUserId = createRandomUserId()
  storage.setItem(STORAGE_KEY, nextUserId)
  return nextUserId
}
