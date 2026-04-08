import { contextBridge, ipcRenderer } from 'electron'

const api = {
  startScreenRecordingSession: (payload) =>
    ipcRenderer.invoke('screen-recording:session-start', payload),
  appendScreenRecordingChunk: (payload) =>
    ipcRenderer.invoke('screen-recording:session-append-chunk', payload),
  rotateScreenRecordingSegment: (payload) =>
    ipcRenderer.invoke('screen-recording:session-rotate', payload),
  stopScreenRecordingSession: (payload) =>
    ipcRenderer.invoke('screen-recording:session-stop', payload),
  cancelScreenRecordingSession: (payload) =>
    ipcRenderer.invoke('screen-recording:session-cancel', payload),
  getScreenRecordingSessionStatus: (payload) =>
    ipcRenderer.invoke('screen-recording:session-status', payload),
  saveScreenRecording: (payload) => ipcRenderer.invoke('screen-recording:save', payload),
  listScreenRecordings: () => ipcRenderer.invoke('screen-recording:list'),
  retryCloudSyncSession: (payload) =>
    ipcRenderer.invoke('screen-recording:cloud-sync-retry', payload),
  resumeAllCloudSyncSessions: () => ipcRenderer.invoke('screen-recording:cloud-sync-resume-all'),
  getScreenRecordingPermissionStatus: () =>
    ipcRenderer.invoke('screen-recording:permission-status'),
  openScreenRecordingPermissionSettings: () =>
    ipcRenderer.invoke('screen-recording:open-permission-settings'),
  getScreenRecordingSources: () => ipcRenderer.invoke('screen-recording:get-sources'),
  setScreenRecordingSource: (payload) => ipcRenderer.invoke('screen-recording:set-source', payload),
  openScreenRecording: (payload) => ipcRenderer.invoke('screen-recording:open', payload),
  revealScreenRecording: (payload) => ipcRenderer.invoke('screen-recording:reveal', payload),
  deleteScreenRecording: (payload) => ipcRenderer.invoke('screen-recording:delete', payload),
  debugScreenRecordingAccess: () => ipcRenderer.invoke('screen-recording:debug-access')
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
