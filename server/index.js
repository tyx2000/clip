const { startScreenShareServer } = require('./screenShareServer')

startScreenShareServer().catch((error) => {
  console.error('[server] failed to bootstrap:', error)
  process.exitCode = 1
})
