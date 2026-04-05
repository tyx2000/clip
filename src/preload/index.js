import { contextBridge, ipcRenderer } from 'electron'

const api = {
  createWindow: () => ipcRenderer.invoke('window:create'),
  createSettingsWindow: () => ipcRenderer.invoke('window:create-settings'),
  setWindowTitle: (title) => ipcRenderer.invoke('window:set-title', title),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  getSharedState: () => ipcRenderer.invoke('shared-state:get'),
  setSharedState: (partialState) => ipcRenderer.invoke('shared-state:set', partialState),
  incrementSharedCount: (delta = 1) => ipcRenderer.invoke('shared-state:increment', delta),
  getAppSettings: () => ipcRenderer.invoke('app-settings:get'),
  setAppSetting: (payload) => ipcRenderer.invoke('app-settings:set', payload),
  replaceAppSettings: (nextSettings) => ipcRenderer.invoke('app-settings:replace', nextSettings),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  getUpdateStatus: () => ipcRenderer.invoke('app-update:get-status'),
  checkForUpdates: () => ipcRenderer.invoke('app-update:check'),
  downloadUpdate: () => ipcRenderer.invoke('app-update:download'),
  installUpdate: () => ipcRenderer.invoke('app-update:install'),
  getAuthUser: () => ipcRenderer.invoke('auth:get-user'),
  loginWithGoogle: () => ipcRenderer.invoke('auth:login-google'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  touchAuthActivity: () => ipcRenderer.invoke('auth:touch-activity'),
  ping: () => ipcRenderer.invoke('ipc:ping'),
  sendSystemNotification: (payload) => ipcRenderer.invoke('notification:send', payload),
  onSharedStateUpdated: (callback) => {
    const listener = (_, state) => callback(state)
    ipcRenderer.on('shared-state:updated', listener)

    return () => {
      ipcRenderer.removeListener('shared-state:updated', listener)
    }
  },
  onAuthUserUpdated: (callback) => {
    const listener = (_, user) => callback(user)
    ipcRenderer.on('auth-user:updated', listener)

    return () => {
      ipcRenderer.removeListener('auth-user:updated', listener)
    }
  },
  onUpdateStatus: (callback) => {
    const listener = (_, status) => callback(status)
    ipcRenderer.on('app-update:status', listener)

    return () => {
      ipcRenderer.removeListener('app-update:status', listener)
    }
  },
  onThemeUpdated: (callback) => {
    const listener = (_, theme) => callback(theme)
    ipcRenderer.on('theme:updated', listener)

    return () => {
      ipcRenderer.removeListener('theme:updated', listener)
    }
  }
}

try {
  contextBridge.exposeInMainWorld('api', api)
} catch (error) {
  console.error(error)
}
