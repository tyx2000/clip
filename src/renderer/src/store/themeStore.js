import { create } from 'zustand'

export const themeOptions = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'blue', label: 'Blue' }
]

const validThemeSet = new Set(themeOptions.map((item) => item.id))

const useThemeStore = create((set) => ({
  theme: 'light',
  hydrateFromMain: async () => {
    const theme = await window.api.getTheme()
    if (validThemeSet.has(theme)) {
      set({ theme })
    }
  },
  subscribeTheme: () => {
    return window.api.onThemeUpdated((theme) => {
      if (validThemeSet.has(theme)) {
        set({ theme })
      }
    })
  },
  setTheme: async (nextTheme) => {
    if (!validThemeSet.has(nextTheme)) return
    const theme = await window.api.setTheme(nextTheme)
    if (validThemeSet.has(theme)) {
      set({ theme })
    }
  }
}))

export default useThemeStore
