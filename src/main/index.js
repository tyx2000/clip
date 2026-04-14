import { app, BrowserWindow, desktopCapturer, ipcMain, session } from 'electron'
import { createRequire } from 'node:module'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerShareHandlers, resolvePreferredDisplaySource } from './shareHandlers'
import { createMainWindow } from './shareShell'
import {
  cleanupShareSocketsForWebContents,
  connectScreenShareMeetingSocket,
  disconnectScreenShareMeetingSocket,
  sendScreenShareMeetingMessage,
  subscribeScreenShareRooms,
  unsubscribeScreenShareRooms
} from './shareSocketHub'

const require = createRequire(import.meta.url)
const {
  getScreenShareServerOrigin,
  startScreenShareServer,
  createRoomLocal,
  joinRoomLocal,
  getRoomSummaryLocal
} = require('../../server/screenShareServer')

let screenShareServerHandle = null

async function ensureScreenShareServer() {
  if (screenShareServerHandle) {
    return screenShareServerHandle
  }

  screenShareServerHandle = await startScreenShareServer()
  return screenShareServerHandle
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.electron.clip-share')
  registerShareHandlers(__dirname)
  await ensureScreenShareServer()

  ipcMain.handle('ensureScreenShareServer', async () => {
    await ensureScreenShareServer()
    return {
      ok: true,
      origin: getScreenShareServerOrigin()
    }
  })

  ipcMain.handle('createScreenShareRoom', async (_, payload = {}) => {
    try {
      await ensureScreenShareServer()
      const userId = typeof payload?.userId === 'string' ? payload.userId : ''
      return createRoomLocal(userId)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '创建会议房间失败。'
      }
    }
  })

  ipcMain.handle('joinScreenShareRoom', async (_, payload = {}) => {
    try {
      await ensureScreenShareServer()
      const roomId = typeof payload?.roomId === 'string' ? payload.roomId.trim() : ''
      const userId = typeof payload?.userId === 'string' ? payload.userId : ''
      const result = joinRoomLocal(roomId, userId)
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

  ipcMain.handle('getScreenShareRoom', async (_, payload = {}) => {
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

  ipcMain.handle('subscribeScreenShareRooms', async (event) => {
    try {
      await subscribeScreenShareRooms(event.sender, {
        ensureScreenShareServer,
        getScreenShareServerOrigin
      })
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '订阅会议房间列表失败。'
      }
    }
  })

  ipcMain.on('unsubscribeScreenShareRooms', (event) => {
    unsubscribeScreenShareRooms(event.sender.id)
  })

  ipcMain.handle('connectScreenShareMeetingSocket', async (event, payload = {}) => {
    try {
      await ensureScreenShareServer()
      return await connectScreenShareMeetingSocket(event.sender, payload)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '连接会议房间失败。'
      }
    }
  })

  ipcMain.handle('sendScreenShareMeetingMessage', async (event, payload = {}) => {
    return sendScreenShareMeetingMessage(event.sender.id, payload)
  })

  ipcMain.handle('disconnectScreenShareMeetingSocket', async (event, payload = {}) => {
    return disconnectScreenShareMeetingSocket(event.sender.id, payload)
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
    const webContentsId = window.webContents.id

    window.once('close', () => {
      cleanupShareSocketsForWebContents(webContentsId)
    })

    window.webContents.once('destroyed', () => {
      cleanupShareSocketsForWebContents(webContentsId)
    })
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
