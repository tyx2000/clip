import { protocol } from 'electron'
import { RECORDING_MEDIA_SCHEME } from './recordingPaths'
import {
  deleteCloudSessionFromDatabase,
  deleteRecordingSessionFromDatabase,
  createRuntimeSessionFromCloudSyncDatabaseRecord as createCloudSyncRuntimeSessionFromDatabase,
  createRuntimeSessionFromRecordingDatabaseRecord as createLocalRuntimeSessionFromDatabase,
  deleteRecordingMetadataFromDatabase,
  listCloudSyncSessionRowsFromDatabase,
  listLocalRecordingSessionRowsFromDatabase,
  readCloudSyncSessionRowsFromDatabase,
  readRecordingMetadataFromDatabase,
  readRecordingSessionRowsFromDatabase,
  syncCloudSessionToDatabase,
  syncRecordingSessionToDatabase,
  writeRecordingMetadataToDatabase
} from './recordingDb'
import {
  listSessionArtifactPaths,
  probeVideoDurationSec,
  runFfmpeg,
  sha256File
} from './mediaUtils'
import { createCloudSyncRuntime } from './cloudSyncRuntime'
import { createRecordingSessionsRuntime } from './recordingSessions'
import { createRecordingCatalog } from './recordingCatalog'
import { createRecordingHandlersRegistrar } from './recordingHandlers'
import {
  applyRecordingSessionManifestDefaults,
  createCloudSyncState,
  getCloudSyncRetryDelayMs,
  getCloudSyncServerUrl,
  normalizeCloudSyncEnabled,
  normalizeSegmentCloudSyncState,
  normalizeSegmentDurationMs,
  parseChunkPayloadToBuffer,
  parseDataUrl
} from './recordingRuntimeUtils'
import {
  createMainWindow as createMainWindowImpl,
  createRecordingPlayerWindow,
  getScreenCapturePermissionDetails,
  listCaptureSources,
  openScreenCaptureSettings,
  registerRecordingMediaProtocol as registerRecordingMediaProtocolImpl,
  toRecordingMediaUrl
} from './recordingShell'

let recordingSessionsRuntime = null
let recordingCatalog = null
let recordingHandlersRegistrar = null

/** Thin forwarding helper into the sessions runtime so cloud sync can persist state. */
function persistRecordingSessionManifest(...args) {
  return recordingSessionsRuntime.persistRecordingSessionManifest(...args)
}

/** Thin forwarding helper that builds persisted cloud-sync metadata for one output. */
function buildCloudSyncMetadata(...args) {
  return recordingSessionsRuntime.buildCloudSyncMetadata(...args)
}

/** Thin forwarding helper that removes one session's temporary artifacts. */
function cleanupRecordingSessionArtifacts(...args) {
  return recordingSessionsRuntime.cleanupRecordingSessionArtifacts(...args)
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: RECORDING_MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
])

const cloudSyncRuntime = createCloudSyncRuntime({
  getCloudSyncRetryDelayMs,
  persistRecordingSessionManifest,
  buildCloudSyncMetadata,
  writeRecordingMetadata,
  cleanupRecordingSessionArtifacts,
  sha256File
})
const { clearCloudSyncWorker, scheduleCloudSyncProcessing, scheduleCloudSyncFinalize } =
  cloudSyncRuntime
recordingCatalog = createRecordingCatalog({
  readRecordingMetadata,
  writeRecordingMetadata,
  probeVideoDurationSec,
  toRecordingMediaUrl,
  parseDataUrl,
  deleteRecordingMetadataFromDatabase
})
const {
  isRecordingFilePath,
  buildRecordingItem,
  listRecordingItems,
  saveRecordingFromDataUrl,
  deleteRecordingFile
} = recordingCatalog
recordingSessionsRuntime = createRecordingSessionsRuntime({
  normalizeSegmentDurationMs,
  normalizeCloudSyncEnabled,
  getCloudSyncServerUrl,
  createCloudSyncState,
  normalizeSegmentCloudSyncState,
  applyRecordingSessionManifestDefaults,
  syncRecordingSessionToDatabase,
  syncCloudSessionToDatabase,
  writeRecordingMetadataToDatabase,
  listSessionArtifactPaths,
  deleteRecordingSessionFromDatabase,
  deleteCloudSessionFromDatabase,
  runFfmpeg,
  probeVideoDurationSec,
  buildRecordingItem,
  writeRecordingMetadata,
  listLocalRecordingSessionRowsFromDatabase,
  readRecordingSessionRowsFromDatabase,
  createLocalRuntimeSessionFromDatabase,
  listCloudSyncSessionRowsFromDatabase,
  readCloudSyncSessionRowsFromDatabase,
  createCloudSyncRuntimeSessionFromDatabase,
  scheduleCloudSyncProcessing,
  scheduleCloudSyncFinalize,
  clearCloudSyncWorker,
  parseChunkPayloadToBuffer
})
const {
  createRecordingSession,
  getActiveRecordingSession,
  getRecordingSessionStatus,
  appendRecordingSessionChunk,
  rotateRecordingSessionSegment,
  stopRecordingSession,
  cancelRecordingSession,
  recoverPendingRecordingSessions: recoverPendingRecordingSessionsImpl,
  getRuntimeSessionForCloudSync,
  resumeAllCloudSyncSessions
} = recordingSessionsRuntime
recordingHandlersRegistrar = createRecordingHandlersRegistrar({
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
  baseDir: __dirname
})
const { registerRecordingHandlers: registerRecordingHandlersImpl, resolvePreferredDisplaySource } =
  recordingHandlersRegistrar

/** Restores unfinished local/cloud sessions on application startup. */
export async function recoverPendingRecordingSessions() {
  return await recoverPendingRecordingSessionsImpl()
}

/** Reads persisted metadata for one finalized recording output path. */
async function readRecordingMetadata(filePath) {
  return readRecordingMetadataFromDatabase(filePath)
}

/** Writes persisted metadata for one finalized recording output path. */
async function writeRecordingMetadata(filePath, metadata) {
  writeRecordingMetadataToDatabase(filePath, metadata)
}

/** Forces a failed or paused cloud-sync session back into the upload queue. */
async function retryCloudSyncSession(payload = {}) {
  const runtimeSession = await getRuntimeSessionForCloudSync(payload)
  if (!runtimeSession) {
    throw new Error('Cloud sync session not found.')
  }

  if (!runtimeSession.manifest.cloudSyncEnabled) {
    throw new Error('This recording did not enable cloud sync.')
  }

  runtimeSession.manifest.cloudSync.lastError = ''
  runtimeSession.manifest.cloudSync.uploadStatus = 'pending'
  runtimeSession.manifest.cloudSync.nextRetryAt = null

  for (const segment of runtimeSession.manifest.segments) {
    if (segment.status === 'ready' && segment.uploadStatus !== 'uploaded') {
      segment.uploadStatus = 'pending'
    }
  }

  runtimeSession.manifest.cloudSync.uploadedParts = runtimeSession.manifest.segments.filter(
    (segment) => segment.uploadStatus === 'uploaded'
  ).length
  runtimeSession.manifest.cloudSync.totalParts = runtimeSession.manifest.segments.length

  await persistRecordingSessionManifest(runtimeSession)
  scheduleCloudSyncProcessing(runtimeSession)

  return {
    ok: true,
    sessionId: runtimeSession.id,
    ...(await getRecordingSessionStatus(runtimeSession))
  }
}

/** Creates the main Electron application window used by the renderer UI. */
export function createMainWindow({ iconPath } = {}) {
  return createMainWindowImpl({ iconPath, baseDir: __dirname })
}

export { resolvePreferredDisplaySource }

/** Registers the custom `recording://` protocol used by cards and player windows. */
export function registerRecordingMediaProtocol() {
  return registerRecordingMediaProtocolImpl({ isRecordingFilePath })
}
/** Registers all recording-related IPC handlers on the Electron main process. */
export function registerRecordingHandlers() {
  return registerRecordingHandlersImpl()
}
