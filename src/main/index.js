import { app, BrowserWindow, desktopCapturer, session } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createRecordingHandlersRegistrar } from './recordingHandlers'
import { createRecordingService } from './recordingService'
import {
  createMainWindow,
  createRecordingPlayerWindow,
  getScreenCapturePermissionDetails,
  listCaptureSources,
  openScreenCaptureSettings,
  registerRecordingMediaProtocol
} from './recordingShell'

const recordingService = createRecordingService()
const { registerRecordingHandlers, resolvePreferredDisplaySource } =
  createRecordingHandlersRegistrar({
    getActiveRecordingSession: recordingService.getActiveRecordingSession,
    getRecordingSessionStatus: recordingService.getRecordingSessionStatus,
    createRecordingSession: recordingService.createRecordingSession,
    appendRecordingSessionChunk: recordingService.appendRecordingSessionChunk,
    rotateRecordingSessionSegment: recordingService.rotateRecordingSessionSegment,
    stopRecordingSession: recordingService.stopRecordingSession,
    cancelRecordingSession: recordingService.cancelRecordingSession,
    listRecordingItems: recordingService.listRecordingItems,
    saveRecordingFromDataUrl: recordingService.saveRecordingFromDataUrl,
    retryCloudSyncSession: recordingService.retryCloudSyncSession,
    resumeAllCloudSyncSessions: recordingService.resumeAllCloudSyncSessions,
    getScreenCapturePermissionDetails,
    openScreenCaptureSettings,
    listCaptureSources,
    isRecordingFilePath: recordingService.isRecordingFilePath,
    createRecordingPlayerWindow,
    deleteRecordingFile: recordingService.deleteRecordingFile,
    getRuntimeSessionForCloudSync: recordingService.getRuntimeSessionForCloudSync,
    clearCloudSyncWorker: recordingService.clearCloudSyncWorker,
    cleanupRecordingSessionArtifacts: recordingService.cleanupRecordingSessionArtifacts,
    baseDir: __dirname
  })

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.electron.clip-recorder')
  registerRecordingMediaProtocol({ isRecordingFilePath: recordingService.isRecordingFilePath })
  registerRecordingHandlers()

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 }
      })

      const preferredSource = resolvePreferredDisplaySource(sources)
      if (!preferredSource) {
        callback({})
        return
      }

      callback({
        video: preferredSource,
        audio: request.audioRequested && process.platform !== 'darwin' ? 'loopback' : undefined
      })
    } catch {
      callback({})
    }
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const recoverySummary = await recordingService.recoverPendingRecordingSessions()
  if (recoverySummary.recovered || recoverySummary.failed) {
    console.info('[recording] recovery summary:', recoverySummary)
  }

  createMainWindow({
    iconPath: process.platform === 'linux' ? icon : undefined,
    baseDir: __dirname
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow({
        iconPath: process.platform === 'linux' ? icon : undefined,
        baseDir: __dirname
      })
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
