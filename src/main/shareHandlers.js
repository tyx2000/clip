import { ipcMain } from 'electron'

export function createShareHandlersRegistrar({ listCaptureSources, createMeetingWindow, baseDir }) {
  let preferredShareSourceId = ''

  function resolvePreferredDisplaySource(sources) {
    return (
      sources.find((source) => source.id === preferredShareSourceId) ||
      sources.find((source) => source.id.startsWith('screen:')) ||
      sources[0] ||
      null
    )
  }

  function registerShareHandlers() {
    ipcMain.handle('screen-share:get-sources', async () => {
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

    ipcMain.handle('screen-share:set-source', (_, payload = {}) => {
      const sourceId = typeof payload?.sourceId === 'string' ? payload.sourceId : ''
      preferredShareSourceId = sourceId
      return { ok: true, sourceId: preferredShareSourceId }
    })

    ipcMain.handle('screen-share:open-meeting-window', async (_, payload = {}) => {
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

  return {
    registerShareHandlers,
    resolvePreferredDisplaySource
  }
}
