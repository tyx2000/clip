import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getScreenShareSources: () => ipcRenderer.invoke('screen-share:get-sources'),
  setScreenShareSource: (payload) => ipcRenderer.invoke('screen-share:set-source', payload),
  ensureScreenShareServer: () => ipcRenderer.invoke('screen-share:ensure-server'),
  createScreenShareRoom: () => ipcRenderer.invoke('screen-share:create-room'),
  joinScreenShareRoom: (payload) => ipcRenderer.invoke('screen-share:join-room', payload),
  getScreenShareRoom: (payload) => ipcRenderer.invoke('screen-share:get-room', payload),
  openScreenShareMeetingWindow: (payload) =>
    ipcRenderer.invoke('screen-share:open-meeting-window', payload)
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
