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

function persistRecordingSessionManifest(...args) {
  return recordingSessionsRuntime.persistRecordingSessionManifest(...args)
}

function buildCloudSyncMetadata(...args) {
  return recordingSessionsRuntime.buildCloudSyncMetadata(...args)
}

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
recordingCatalog = createRecordingCatalog({
  readRecordingMetadata,
  writeRecordingMetadata,
  probeVideoDurationSec,
  toRecordingMediaUrl,
  parseDataUrl,
  deleteRecordingMetadataFromDatabase
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
const {
  isRecordingFilePath,
  buildRecordingItem,
  listRecordingItems,
  saveRecordingFromDataUrl,
  deleteRecordingFile
} = recordingCatalog
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

export async function recoverPendingRecordingSessions() {
  return await recoverPendingRecordingSessionsImpl()
}

async function readRecordingMetadata(filePath) {
  return readRecordingMetadataFromDatabase(filePath)
}

async function writeRecordingMetadata(filePath, metadata) {
  writeRecordingMetadataToDatabase(filePath, metadata)
}

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

  await persistRecordingSessionManifest(runtimeSession)
  scheduleCloudSyncProcessing(runtimeSession)

  return {
    ok: true,
    sessionId: runtimeSession.id,
    ...(await getRecordingSessionStatus(runtimeSession))
  }
}

export function createMainWindow({ iconPath } = {}) {
  return createMainWindowImpl({ iconPath, baseDir: __dirname })
}

export { resolvePreferredDisplaySource }

export function registerRecordingMediaProtocol() {
  return registerRecordingMediaProtocolImpl({ isRecordingFilePath })
}
export function registerRecordingHandlers() {
  return registerRecordingHandlersImpl()
}
