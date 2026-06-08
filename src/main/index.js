/** 文件作用：Electron 主进程入口，负责初始化录屏能力、协议、IPC 与主窗口。 */
import { app, BrowserWindow, desktopCapturer, session } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/3a65b18c3a85d213e62263b539fdf183_compress.jpg?asset'
import {
  registerRecordingHandlers,
  resolvePreferredRecordingDisplaySource
} from './recordingHandlers'
import {
  createMainWindow,
  registerRecordingMediaProtocol,
  registerRecordingMediaProtocolScheme
} from './mediaUtils'
import { recoverPendingRecordingSessions } from './recordingService'

registerRecordingMediaProtocolScheme()

/** 应用准备完成后，初始化主进程录屏能力并启动主窗口。 */
app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.electron.clip-recorder')
  registerRecordingMediaProtocol()
  registerRecordingHandlers()

  /** 拦截渲染进程的屏幕采集请求，并按偏好返回录制源。 */
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 }
      })

      const preferredSource = resolvePreferredRecordingDisplaySource(sources)
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

  /** 为新创建的窗口附加开发辅助快捷键。 */
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const recoverySummary = await recoverPendingRecordingSessions()
  if (recoverySummary.recovered || recoverySummary.failed) {
    console.info('[recording] recovery summary:', recoverySummary)
  }

  createMainWindow({
    iconPath: process.platform === 'linux' ? icon : undefined
  })

  /** 在 macOS 上重新激活应用时补建主窗口。 */
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow({
        iconPath: process.platform === 'linux' ? icon : undefined
      })
    }
  })
})

/** 在非 macOS 平台关闭最后一个窗口后退出应用。 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
