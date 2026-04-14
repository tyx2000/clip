import { ipcMain } from 'electron'
import { createMeetingWindow, listCaptureSources } from './shareShell'

let preferredShareSourceId = ''

export function resolvePreferredDisplaySource(sources) {
  return (
    sources.find((source) => source.id === preferredShareSourceId) ||
    sources.find((source) => source.id.startsWith('screen:')) ||
    sources[0] ||
    null
  )
}

export function registerShareHandlers(baseDir) {
  ipcMain.handle('getScreenShareSources', async () => {
    try {
      const sources = await listCaptureSources()
      return { ok: true, sources }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to load share sources.'
      }
    }
  })

  ipcMain.handle('setScreenShareSource', (_, payload = {}) => {
    const sourceId = typeof payload?.sourceId === 'string' ? payload.sourceId : ''
    preferredShareSourceId = sourceId
    return { ok: true, sourceId: preferredShareSourceId }
  })

  ipcMain.handle('openScreenShareMeetingWindow', async (_, payload = {}) => {
    try {
      createMeetingWindow({ ...payload, baseDir })
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to open meeting window.'
      }
    }
  })
}
