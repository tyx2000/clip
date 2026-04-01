import { app, BrowserWindow, desktopCapturer, session } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  recoverPendingRecordingSessions,
  registerRecordingHandlers,
  registerRecordingMediaProtocol,
  resolvePreferredDisplaySource,
  createMainWindow
} from './recording'

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.electron.clip-recorder')
  registerRecordingMediaProtocol()
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

  const recoverySummary = await recoverPendingRecordingSessions()
  if (recoverySummary.recovered || recoverySummary.failed) {
    console.info('[recording] recovery summary:', recoverySummary)
  }

  createMainWindow({ iconPath: process.platform === 'linux' ? icon : undefined })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow({ iconPath: process.platform === 'linux' ? icon : undefined })
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
