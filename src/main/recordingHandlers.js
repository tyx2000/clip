import { ipcMain, shell } from 'electron'
import { existsSync } from 'fs'
import { getPosterPathByVideoPath, getRecordingsDirectoryPath } from './recordingPaths'

export function createRecordingHandlersRegistrar({
  getActiveRecordingSession,
  getRecordingSessionStatus,
  createRecordingSession,
  appendRecordingSessionChunk,
  rotateRecordingSessionSegment,
  stopRecordingSession,
  cancelRecordingSession,
  listRecordingItems,
  saveRecordingFromDataUrl,
  retryCloudSyncSession,
  resumeAllCloudSyncSessions,
  getScreenCapturePermissionDetails,
  openScreenCaptureSettings,
  listCaptureSources,
  isRecordingFilePath,
  createRecordingPlayerWindow,
  deleteRecordingFile,
  getRuntimeSessionForCloudSync,
  clearCloudSyncWorker,
  cleanupRecordingSessionArtifacts,
  baseDir
}) {
  let preferredDisplaySourceId = ''

  function resolvePreferredDisplaySource(sources) {
    return (
      sources.find((source) => source.id === preferredDisplaySourceId) ||
      sources.find((source) => source.id.startsWith('screen:')) ||
      sources[0] ||
      null
    )
  }

  function registerSessionHandlers() {
    ipcMain.handle('screen-recording:session-start', async (_, payload = {}) => {
      try {
        const runtimeSession = await createRecordingSession(payload)
        return {
          ok: true,
          ...(await getRecordingSessionStatus(runtimeSession))
        }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'Failed to start recording session.'
        }
      }
    })

    ipcMain.handle('screen-recording:session-append-chunk', async (_, payload = {}) => {
      try {
        return await appendRecordingSessionChunk(payload)
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'Failed to append recording chunk.'
        }
      }
    })

    ipcMain.handle('screen-recording:session-rotate', async (_, payload = {}) => {
      try {
        return await rotateRecordingSessionSegment(payload)
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'Failed to rotate recording segment.'
        }
      }
    })

    ipcMain.handle('screen-recording:session-stop', async (_, payload = {}) => {
      try {
        return await stopRecordingSession(payload)
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'Failed to stop recording session.'
        }
      }
    })

    ipcMain.handle('screen-recording:session-cancel', async (_, payload = {}) => {
      try {
        return await cancelRecordingSession(payload)
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'Failed to cancel recording session.'
        }
      }
    })

    ipcMain.handle('screen-recording:session-status', (_, payload = {}) => {
      return (async () => {
        const runtimeSession = getActiveRecordingSession(payload?.sessionId)
        if (!runtimeSession) {
          return { ok: false, message: 'Recording session not found.' }
        }
        return {
          ok: true,
          ...(await getRecordingSessionStatus(runtimeSession))
        }
      })()
    })
  }

  function registerLibraryHandlers() {
    ipcMain.handle('screen-recording:save', async (_, payload = {}) => {
      return await saveRecordingFromDataUrl(payload)
    })

    ipcMain.handle('screen-recording:list', async () => {
      try {
        const items = await listRecordingItems()
        return { ok: true, items }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'Failed to load recordings.'
        }
      }
    })

    ipcMain.handle('screen-recording:cloud-sync-retry', async (_, payload = {}) => {
      try {
        return await retryCloudSyncSession(payload)
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'Failed to retry cloud sync.'
        }
      }
    })

    ipcMain.handle('screen-recording:cloud-sync-resume-all', async () => {
      try {
        return await resumeAllCloudSyncSessions()
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'Failed to resume cloud sync sessions.'
        }
      }
    })

    ipcMain.handle('screen-recording:debug-access', async () => {
      const recordingsDir = getRecordingsDirectoryPath()

      try {
        const items = await listRecordingItems()
        const sample = items.slice(0, 8).map((item) => ({
          name: item.name,
          path: item.path,
          posterPath: getPosterPathByVideoPath(item.path),
          fileExists: existsSync(item.path),
          posterExists: existsSync(getPosterPathByVideoPath(item.path)),
          fileUrl: item.fileUrl,
          posterUrl: item.posterUrl || ''
        }))

        return {
          ok: true,
          recordingsDir,
          count: items.length,
          sample
        }
      } catch (error) {
        return {
          ok: false,
          recordingsDir,
          message: error instanceof Error ? error.message : 'Debug access failed.'
        }
      }
    })
  }

  function registerSystemHandlers() {
    ipcMain.handle('screen-recording:permission-status', () => {
      return {
        ok: true,
        ...getScreenCapturePermissionDetails()
      }
    })

    ipcMain.handle('screen-recording:open-permission-settings', async () => {
      return openScreenCaptureSettings()
    })

    ipcMain.handle('screen-recording:get-sources', async () => {
      try {
        const sources = await listCaptureSources()
        return { ok: true, sources }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'Failed to load capture sources.'
        }
      }
    })

    ipcMain.handle('screen-recording:set-source', (_, payload = {}) => {
      const sourceId = typeof payload?.sourceId === 'string' ? payload.sourceId : ''
      preferredDisplaySourceId = sourceId
      return { ok: true, sourceId: preferredDisplaySourceId }
    })
  }

  function registerFileHandlers() {
    ipcMain.handle('screen-recording:open', async (_, payload = {}) => {
      const filePath = typeof payload?.path === 'string' ? payload.path : ''
      if (!isRecordingFilePath(filePath)) {
        return { ok: false, message: 'Invalid recording path.' }
      }

      try {
        createRecordingPlayerWindow({ filePath, baseDir })
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'Failed to open player window.'
        }
      }
    })

    ipcMain.handle('screen-recording:reveal', (_, payload = {}) => {
      const filePath = typeof payload?.path === 'string' ? payload.path : ''
      if (!isRecordingFilePath(filePath)) {
        return { ok: false, message: 'Invalid recording path.' }
      }

      shell.showItemInFolder(filePath)
      return { ok: true }
    })

    ipcMain.handle('screen-recording:delete', async (_, payload = {}) => {
      const filePath = typeof payload?.path === 'string' ? payload.path : ''
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!isRecordingFilePath(filePath)) {
        return { ok: false, message: 'Invalid recording path.' }
      }

      try {
        const deleteResult = await deleteRecordingFile(filePath)
        if (!deleteResult.ok) {
          return deleteResult
        }

        const runtimeSession = sessionId ? await getRuntimeSessionForCloudSync({ sessionId }) : null
        if (runtimeSession) {
          clearCloudSyncWorker(runtimeSession.id)
          await cleanupRecordingSessionArtifacts(runtimeSession)
        }

        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'Failed to delete recording.'
        }
      }
    })
  }

  function registerRecordingHandlers() {
    registerSessionHandlers()
    registerLibraryHandlers()
    registerSystemHandlers()
    registerFileHandlers()
  }

  return {
    registerRecordingHandlers,
    resolvePreferredDisplaySource
  }
}
