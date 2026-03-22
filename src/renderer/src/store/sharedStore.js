import { create } from 'zustand'

const mapSharedState = (state) => ({
  count: Number.isFinite(state?.count) ? state.count : 0,
  message: typeof state?.message === 'string' ? state.message : ''
})

const useSharedStore = create((set) => ({
  count: 0,
  message: '',
  hydrated: false,
  syncFromMain: (state) => {
    if (!state) return
    set({ ...mapSharedState(state), hydrated: true })
  },
  hydrate: async () => {
    const state = await window.api.getSharedState()
    set({ ...mapSharedState(state), hydrated: true })
  },
  setMessage: async (message) => {
    const state = await window.api.setSharedState({ message })
    set({ ...mapSharedState(state), hydrated: true })
  },
  increment: async (delta = 1) => {
    const state = await window.api.incrementSharedCount(delta)
    set({ ...mapSharedState(state), hydrated: true })
  }
}))

export default useSharedStore
