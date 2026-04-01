const { startCloudSyncServer } = require('./cloudSyncServer')

startCloudSyncServer().catch((error) => {
  console.error('[cloud-sync] failed to bootstrap:', error)
  process.exitCode = 1
})
