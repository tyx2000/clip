import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

const defaultSettings = {
  general: {
    language: 'zh-CN',
    launchOnStartup: false,
    autoUpdate: true,
    compactSidebar: false
  },
  account: {
    displayName: 'Pixel User',
    statusText: 'Ready to build',
    syncProfile: true
  },
  notifications: {
    desktopNotice: true,
    soundNotice: true,
    digestFrequency: 'daily'
  },
  privacy: {
    analyticsEnabled: false,
    crashReportEnabled: true,
    personalizedAds: false
  },
  advanced: {
    defaultOpenDevtools: false,
    hardwareAcceleration: true,
    cacheSizeMb: 512,
    animationLevel: 'full'
  }
}

const cloneDefaultSettings = () => JSON.parse(JSON.stringify(defaultSettings))

const mergeSettings = (nextSettings) => ({
  ...cloneDefaultSettings(),
  ...(nextSettings || {}),
  general: {
    ...defaultSettings.general,
    ...(nextSettings?.general || {})
  },
  account: {
    ...defaultSettings.account,
    ...(nextSettings?.account || {})
  },
  notifications: {
    ...defaultSettings.notifications,
    ...(nextSettings?.notifications || {})
  },
  privacy: {
    ...defaultSettings.privacy,
    ...(nextSettings?.privacy || {})
  },
  advanced: {
    ...defaultSettings.advanced,
    ...(nextSettings?.advanced || {})
  }
})

const useSettingsStore = create(
  persist(
    (set) => ({
      settings: cloneDefaultSettings(),
      restartRequired: false,
      systemMessage: '',
      updateStatus: {
        status: 'idle',
        message: '',
        currentVersion: '',
        availableVersion: '',
        progressPercent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        bytesPerSecond: 0,
        lastCheckedAt: 0,
        lastCheckedAtLabel: '',
        errorCode: '',
        errorDetail: '',
        canDownload: false,
        canInstall: false
      },
      clearSystemMessage: () => set({ systemMessage: '' }),
      hydrateUpdateStatus: async () => {
        const status = await window.api.getUpdateStatus()
        set({ updateStatus: status })
      },
      subscribeUpdateStatus: (callback) => {
        return window.api.onUpdateStatus((status) => {
          set({ updateStatus: status })
          if (callback) callback(status)
        })
      },
      checkForUpdates: async () => {
        const status = await window.api.checkForUpdates()
        set({ updateStatus: status })
      },
      downloadUpdate: async () => {
        const status = await window.api.downloadUpdate()
        set({ updateStatus: status })
      },
      installUpdate: async () => {
        await window.api.installUpdate()
      },
      hydrateFromMain: async () => {
        const remoteSettings = await window.api.getAppSettings()
        set({ settings: mergeSettings(remoteSettings) })
      },
      updateSetting: async (section, key, value) => {
        set((state) => ({
          settings: {
            ...state.settings,
            [section]: {
              ...state.settings[section],
              [key]: value
            }
          }
        }))

        const result = await window.api.setAppSetting({ section, key, value })
        if (result?.settings) {
          set({
            settings: mergeSettings(result.settings),
            restartRequired: Boolean(result.restartRequired),
            systemMessage: result.message || ''
          })
        }
      },
      resetSettings: async () => {
        const nextSettings = cloneDefaultSettings()
        set({ settings: nextSettings })
        const result = await window.api.replaceAppSettings(nextSettings)
        if (result?.settings) {
          set({
            settings: mergeSettings(result.settings),
            restartRequired: Boolean(result.restartRequired),
            systemMessage: result.message || ''
          })
        }
      }
    }),
    {
      name: 'pixel-settings-store',
      storage: createJSONStorage(() => localStorage)
    }
  )
)

export default useSettingsStore
