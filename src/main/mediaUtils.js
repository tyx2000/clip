/** 文件作用：提供 ffmpeg 调用、媒体信息探测和会话目录扫描等底层工具。 */
import ffmpegPath from 'ffmpeg-static'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'fs'
import { readFile, readdir } from 'fs/promises'
import { join } from 'path'

/** 执行一次 ffmpeg 命令，并在失败时抛出带上下文的错误。 */
export async function runFfmpeg(args) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg binary is not available.')
  }

  await new Promise((resolveCallback, rejectCallback) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    })

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', (error) => {
      rejectCallback(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolveCallback()
        return
      }

      const tail = stderr.trim().split('\n').slice(-5).join('\n')
      rejectCallback(new Error(tail || `ffmpeg exited with code ${code}`))
    })
  })
}

/** 读取视频时长，无法探测时返回 null。 */
export async function probeVideoDurationSec(filePath) {
  if (!ffmpegPath || !filePath || !existsSync(filePath)) {
    return null
  }

  return await new Promise((resolveCallback) => {
    const child = spawn(ffmpegPath, ['-i', filePath], {
      stdio: ['ignore', 'ignore', 'pipe']
    })

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', () => {
      resolveCallback(null)
    })

    child.on('close', () => {
      const matched = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
      if (!matched) {
        resolveCallback(null)
        return
      }

      const [, hoursRaw, minutesRaw, secondsRaw] = matched
      const totalSeconds =
        Number(hoursRaw) * 3600 + Number(minutesRaw) * 60 + Number.parseFloat(secondsRaw)

      if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
        resolveCallback(null)
        return
      }

      resolveCallback(totalSeconds)
    })
  })
}

/** 递归列出会话目录中的所有残留文件，供清理失败时诊断。 */
export async function listSessionArtifactPaths(sessionDir) {
  if (!sessionDir || !existsSync(sessionDir)) {
    return []
  }

  const entries = await readdir(sessionDir, { withFileTypes: true }).catch(() => [])
  const filePaths = []

  for (const entry of entries) {
    const entryPath = join(sessionDir, entry.name)
    if (entry.isDirectory()) {
      filePaths.push(...(await listSessionArtifactPaths(entryPath)))
      continue
    }

    filePaths.push(entryPath)
  }

  return filePaths
}

/** 计算文件内容的 SHA-256 值，用于云同步校验。 */
export async function sha256File(filePath) {
  const buffer = await readFile(filePath)
  return createHash('sha256').update(buffer).digest('hex')
}
