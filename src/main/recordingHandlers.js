/** 文件作用：注册主进程录屏 IPC，并把请求分发给录屏服务层。 */
import { ipcMain, shell } from 'electron'
import { existsSync } from 'fs'
import {
  clearCloudSyncWorker,
  createRecordingSession,
  getActiveRecordingSession,
  getRuntimeSessionForCloudSync,
  resumeAllCloudSyncSessions,
  retryCloudSyncSession,
  stopRecordingSession,
  cancelRecordingSession,
  appendRecordingSessionChunk,
  rotateRecordingSessionSegment
} from './recordingService'
import { cleanupRecordingSessionArtifacts } from './recordingFinalizer'
import {
  createRecordingPlayerWindow,
  getPosterPathByVideoPath,
  getRecordingsDirectoryPath,
  isRecordingFilePath,
  getScreenCapturePermissionDetails,
  listCaptureSources,
  openScreenCaptureSettings,
  resolvePreferredDisplaySource
} from './mediaUtils'
import {
  deleteRecordingFile,
  getRecordingSessionStatus,
  listRecordingItems,
  saveRecordingFromDataUrl
} from './recordingStorage'

// 这里只保留“用户首选录制源 id”这一份轻量状态。
// 目的是让 displayMedia 请求和 IPC 设置源之间共享同一个偏好值。
let preferredDisplaySourceId = ''

/** 根据记录的偏好录制源 id 选出最终录制源。 */
export function resolvePreferredRecordingDisplaySource(sources) {
  return resolvePreferredDisplaySource(sources, preferredDisplaySourceId)
}

/** 一次性注册当前文件中的全部录屏 IPC。 */
export function registerRecordingHandlers() {
  /** 响应功能：创建录屏会话并返回初始化后的状态信息。 */
  ipcMain.handle('startScreenRecordingSession', async (_, payload = {}) => {
    try {
      // create 后立刻返回完整状态，避免渲染层再多发一次状态查询 IPC。
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

  /** 响应功能：向现有录屏会话追加音视频分片。 */
  ipcMain.handle('appendScreenRecordingChunk', async (_, payload = {}) => {
    try {
      return await appendRecordingSessionChunk(payload)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to append recording chunk.'
      }
    }
  })

  /** 响应功能：轮转当前分片文件，切到新的录制片段。 */
  ipcMain.handle('rotateScreenRecordingSegment', async (_, payload = {}) => {
    try {
      return await rotateRecordingSessionSegment(payload)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to rotate recording segment.'
      }
    }
  })

  /** 响应功能：正常停止录屏会话并触发后处理。 */
  ipcMain.handle('stopScreenRecordingSession', async (_, payload = {}) => {
    try {
      return await stopRecordingSession(payload)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to stop recording session.'
      }
    }
  })

  /** 响应功能：取消录屏会话并回收临时产物。 */
  ipcMain.handle('cancelScreenRecordingSession', async (_, payload = {}) => {
    try {
      return await cancelRecordingSession(payload)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to cancel recording session.'
      }
    }
  })

  /** 响应功能：按会话 id 查询实时录制状态。 */
  ipcMain.handle('getScreenRecordingSessionStatus', (_, payload = {}) => {
    return (async () => {
      const runtimeSession = getActiveRecordingSession(payload?.sessionId)
      if (!runtimeSession) {
        // 这里不抛异常而是返回 ok:false，目的是让轮询状态的前端处理更稳定。
        return { ok: false, message: 'Recording session not found.' }
      }
      return {
        ok: true,
        ...(await getRecordingSessionStatus(runtimeSession))
      }
    })()
  })

  /** 响应功能：保存渲染进程传入的录屏数据到文件系统。 */
  ipcMain.handle('saveScreenRecording', async (_, payload = {}) => {
    return await saveRecordingFromDataUrl(payload)
  })

  /** 响应功能：读取并返回本地录屏条目列表。 */
  ipcMain.handle('listScreenRecordings', async () => {
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

  /** 响应功能：重试指定会话的云同步任务。 */
  ipcMain.handle('retryCloudSyncSession', async (_, payload = {}) => {
    try {
      return await retryCloudSyncSession(payload)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to retry cloud sync.'
      }
    }
  })

  /** 响应功能：恢复全部待处理的云同步会话。 */
  ipcMain.handle('resumeAllCloudSyncSessions', async () => {
    try {
      return await resumeAllCloudSyncSessions()
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to resume cloud sync sessions.'
      }
    }
  })

  /** 响应功能：返回录屏目录与样本文件信息，便于排查访问问题。 */
  ipcMain.handle('debugScreenRecordingAccess', async () => {
    // recordingsDir 单独返回，是为了让前端调试时能直接看到实际落盘目录。
    const recordingsDir = getRecordingsDirectoryPath()

    try {
      const items = await listRecordingItems()
      // 只截取少量样本，避免调试接口一次把大量文件信息都传回 renderer。
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

  /** 响应功能：返回屏幕录制权限与系统能力状态。 */
  ipcMain.handle('getScreenRecordingPermissionStatus', () => {
    return {
      ok: true,
      ...getScreenCapturePermissionDetails()
    }
  })

  /** 响应功能：跳转到系统录屏权限设置界面。 */
  ipcMain.handle('openScreenRecordingPermissionSettings', async () => {
    return openScreenCaptureSettings()
  })

  /** 响应功能：获取可用的桌面/窗口录制源。 */
  ipcMain.handle('getScreenRecordingSources', async () => {
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

  /** 响应功能：保存用户选择的首选录制源 id。 */
  ipcMain.handle('setScreenRecordingSource', (_, payload = {}) => {
    // 这里只接受字符串，避免把异常 payload 写进全局偏好状态。
    const sourceId = typeof payload?.sourceId === 'string' ? payload.sourceId : ''
    preferredDisplaySourceId = sourceId
    return { ok: true, sourceId: preferredDisplaySourceId }
  })

  /** 响应功能：根据录屏路径打开播放器窗口。 */
  ipcMain.handle('openScreenRecording', async (_, payload = {}) => {
    const filePath = typeof payload?.path === 'string' ? payload.path : ''
    if (!isRecordingFilePath(filePath)) {
      // 路径校验放在最前面，是为了阻断任意文件路径被传入播放器窗口。
      return { ok: false, message: 'Invalid recording path.' }
    }

    try {
      createRecordingPlayerWindow({ filePath })
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to open player window.'
      }
    }
  })

  /** 响应功能：在系统文件管理器中高亮录屏文件。 */
  ipcMain.handle('revealScreenRecording', (_, payload = {}) => {
    const filePath = typeof payload?.path === 'string' ? payload.path : ''
    if (!isRecordingFilePath(filePath)) {
      return { ok: false, message: 'Invalid recording path.' }
    }

    // 这里不自己实现打开目录逻辑，直接交给系统文件管理器，兼容性更稳定。
    shell.showItemInFolder(filePath)
    return { ok: true }
  })

  /** 响应功能：删除录屏文件并清理关联的云同步/会话资源。 */
  ipcMain.handle('deleteScreenRecording', async (_, payload = {}) => {
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

      // 如果前端同时带了 sessionId，这里顺手把关联的恢复态会话和云同步 worker 也清掉。
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
