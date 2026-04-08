import { app, BrowserWindow, desktopCapturer, ipcMain, session } from 'electron'
import { createRequire } from 'node:module'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createShareHandlersRegistrar } from './shareHandlers'
import { createMainWindow, createMeetingWindow, listCaptureSources } from './shareShell'

const require = createRequire(import.meta.url)
const {
  getScreenShareServerOrigin,
  startScreenShareServer,
  createRoomLocal,
  joinRoomLocal,
  getRoomSummaryLocal
} = require('../../server/screenShareServer')

let screenShareServerHandle = null

const { registerShareHandlers, resolvePreferredDisplaySource } = createShareHandlersRegistrar({
  listCaptureSources,
  createMeetingWindow,
  baseDir: __dirname
})

async function ensureScreenShareServer() {
  if (screenShareServerHandle) {
    return screenShareServerHandle
  }

  screenShareServerHandle = await startScreenShareServer()
  return screenShareServerHandle
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.electron.clip-share')
  registerShareHandlers()
  await ensureScreenShareServer()

  ipcMain.handle('screen-share:ensure-server', async () => {
    await ensureScreenShareServer()
    return {
      ok: true,
      origin: getScreenShareServerOrigin()
    }
  })

  ipcMain.handle('screen-share:create-room', async () => {
    try {
      await ensureScreenShareServer()
      return createRoomLocal()
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '创建会议房间失败。'
      }
    }
  })

  ipcMain.handle('screen-share:join-room', async (_, payload = {}) => {
    try {
      await ensureScreenShareServer()
      const roomId = typeof payload?.roomId === 'string' ? payload.roomId.trim() : ''
      const result = joinRoomLocal(roomId)
      if (!result?.ok) {
        return {
          ok: false,
          message: result?.message || '加入会议房间失败。'
        }
      }
      return result
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '加入会议房间失败。'
      }
    }
  })

  ipcMain.handle('screen-share:get-room', async (_, payload = {}) => {
    try {
      await ensureScreenShareServer()
      const roomId = typeof payload?.roomId === 'string' ? payload.roomId.trim() : ''
      const room = getRoomSummaryLocal(roomId)
      if (!room) {
        return {
          ok: false,
          message: 'Room not found.'
        }
      }
      return room
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '读取会议房间失败。'
      }
    }
  })

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

app.on('before-quit', () => {
  try {
    screenShareServerHandle?.wss?.close?.()
    screenShareServerHandle?.server?.close?.()
  } catch (error) {
    console.warn(
      '[screen-share] failed to close server:',
      error instanceof Error ? error.message : error
    )
  }
})
