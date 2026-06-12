import { contextBridge, ipcRenderer } from 'electron'

const ROOMS_EVENT_CHANNEL = 'onScreenShareRoomsSnapshot'
const MEETING_EVENT_CHANNEL = 'onScreenShareMeetingSocketEvent'

function createEventSubscription(channel, listener) {
  const wrapped = (_, payload) => {
    listener(payload)
  }

  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const api = {
  getScreenShareSources: () => ipcRenderer.invoke('getScreenShareSources'),
  setScreenShareSource: (payload) => ipcRenderer.invoke('setScreenShareSource', payload),
  createScreenShareRoom: (payload) => ipcRenderer.invoke('createScreenShareRoom', payload),
  joinScreenShareRoom: (payload) => ipcRenderer.invoke('joinScreenShareRoom', payload),
  subscribeScreenShareRooms: () => ipcRenderer.invoke('subscribeScreenShareRooms'),
  unsubscribeScreenShareRooms: () => ipcRenderer.send('unsubscribeScreenShareRooms'),
  onScreenShareRoomsSnapshot: (listener) => createEventSubscription(ROOMS_EVENT_CHANNEL, listener),
  connectScreenShareMeetingSocket: (payload) =>
    ipcRenderer.invoke('connectScreenShareMeetingSocket', payload),
  sendScreenShareMeetingMessage: (payload) =>
    ipcRenderer.invoke('sendScreenShareMeetingMessage', payload),
  disconnectScreenShareMeetingSocket: (payload) =>
    ipcRenderer.invoke('disconnectScreenShareMeetingSocket', payload),
  onScreenShareMeetingSocketEvent: (listener) =>
    createEventSubscription(MEETING_EVENT_CHANNEL, listener),
  openScreenShareMeetingWindow: (payload) =>
    ipcRenderer.invoke('openScreenShareMeetingWindow', payload)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.api = api
}
