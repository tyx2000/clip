import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { pathToFileURL } from 'node:url'

const api = {
  /** 响应功能：创建录屏会话并返回会话状态。 */
  startScreenRecordingSession: (payload) =>
    ipcRenderer.invoke('startScreenRecordingSession', payload),
  /** 响应功能：向当前录屏会话追加媒体分片数据。 */
  appendScreenRecordingChunk: (payload) =>
    ipcRenderer.invoke('appendScreenRecordingChunk', payload),
  /** 响应功能：触发分片轮转，开始写入新的录制片段。 */
  rotateScreenRecordingSegment: (payload) =>
    ipcRenderer.invoke('rotateScreenRecordingSegment', payload),
  /** 响应功能：停止录屏会话并执行收尾流程。 */
  stopScreenRecordingSession: (payload) =>
    ipcRenderer.invoke('stopScreenRecordingSession', payload),
  /** 响应功能：取消录屏会话并清理临时资源。 */
  cancelScreenRecordingSession: (payload) =>
    ipcRenderer.invoke('cancelScreenRecordingSession', payload),
  /** 响应功能：查询指定录屏会话的最新状态。 */
  getScreenRecordingSessionStatus: (payload) =>
    ipcRenderer.invoke('getScreenRecordingSessionStatus', payload),
  /** 响应功能：将 dataURL 录制数据落盘保存。 */
  saveScreenRecording: (payload) => ipcRenderer.invoke('saveScreenRecording', payload),
  /** 响应功能：读取本地录屏列表。 */
  listScreenRecordings: () => ipcRenderer.invoke('listScreenRecordings'),
  /** 响应功能：重试指定会话的云同步。 */
  retryCloudSyncSession: (payload) => ipcRenderer.invoke('retryCloudSyncSession', payload),
  /** 响应功能：恢复所有待重试的云同步任务。 */
  resumeAllCloudSyncSessions: () => ipcRenderer.invoke('resumeAllCloudSyncSessions'),
  /** 响应功能：获取系统屏幕录制权限状态。 */
  getScreenRecordingPermissionStatus: () =>
    ipcRenderer.invoke('getScreenRecordingPermissionStatus'),
  /** 响应功能：打开系统屏幕录制权限设置页面。 */
  openScreenRecordingPermissionSettings: () =>
    ipcRenderer.invoke('openScreenRecordingPermissionSettings'),
  /** 响应功能：获取当前可选的屏幕录制源列表。 */
  getScreenRecordingSources: () => ipcRenderer.invoke('getScreenRecordingSources'),
  /** 响应功能：设置首选屏幕录制源。 */
  setScreenRecordingSource: (payload) => ipcRenderer.invoke('setScreenRecordingSource', payload),
  /** 响应功能：打开录屏文件播放器窗口。 */
  openScreenRecording: (payload) => ipcRenderer.invoke('openScreenRecording', payload),
  /** 响应功能：打开录屏文件剪辑窗口。 */
  openScreenRecordingEditor: (payload) => ipcRenderer.invoke('openScreenRecordingEditor', payload),
  /** 响应功能：读取剪辑媒体信息。 */
  getRecordingEditorMediaInfo: (payload) =>
    ipcRenderer.invoke('getRecordingEditorMediaInfo', payload),
  /** 响应功能：抽取录屏剪辑时间线缩略图。 */
  extractRecordingEditorThumbnails: (payload) =>
    ipcRenderer.invoke('extractRecordingEditorThumbnails', payload),
  /** 响应功能：导出录屏剪辑结果。 */
  exportRecordingEditorCut: (payload) => ipcRenderer.invoke('exportRecordingEditorCut', payload),
  /** 响应功能：读取用户选择文件的真实本地路径，供 ffmpeg 导出使用。 */
  getPathForFile: (file) => webUtils.getPathForFile(file),
  /** 响应功能：将本地路径转换为 renderer 可加载的 file URL。 */
  toFileUrl: (filePath) => pathToFileURL(filePath).toString(),
  /** 响应功能：在系统文件管理器中定位录屏文件。 */
  revealScreenRecording: (payload) => ipcRenderer.invoke('revealScreenRecording', payload),
  /** 响应功能：删除录屏文件并同步清理关联会话。 */
  deleteScreenRecording: (payload) => ipcRenderer.invoke('deleteScreenRecording', payload),
  /** 响应功能：输出录屏目录与样本文件调试信息。 */
  debugScreenRecordingAccess: () => ipcRenderer.invoke('debugScreenRecordingAccess')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.api = api
}
