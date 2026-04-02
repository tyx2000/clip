# electron-playground

An Electron application with React

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

## 录屏封面与播放问题复盘

### 现象

1. 录制视频文件和封面文件都已保存，但应用内列表不显示封面。
2. 点击“打开文件”后，新窗口无法正常播放视频。

### 排查结论

1. 不是磁盘读写权限问题。  
   调试接口返回 `fileExists: true`、`posterExists: true`，说明文件实际存在。
2. 主要问题在渲染层媒体访问链路：  
   直接用 `file://` 或不完整的自定义协议实现，容易在 Electron + CSP + `<video>` 场景下出现加载失败。
3. `<video>` 播放还依赖 HTTP Range 语义。  
   如果自定义协议没有正确返回 `206 Partial Content` / `Content-Range`，播放器可能无法工作。

### 最终方案

1. 保存目录统一为 `~/Downloads/Recording`。
2. 封面生成改为主进程 `ffmpeg` 抽帧，策略如下：  
   先尝试 `1.916667s`（第一秒后的第 12 帧），失败回退到 `1s`，再回退到首帧。
3. 列表卡片只使用 `img` 显示封面，不再用 `video` 组件承担封面展示。
4. 主进程注册 `recording://` 自定义协议用于受控访问录屏目录中的媒体资源。  
   协议实现补齐了 Range 支持（`206`、`Content-Range`、`Accept-Ranges`），确保 `<video>` 可正常播放。
5. “打开文件”改为应用内播放器窗口（不是系统浏览器），并设置 `preload="metadata"`，不自动播放。
6. 增加诊断接口 `window.api.debugScreenRecordingAccess()`，用于快速确认：
   - 录屏目录是否正确
   - `ffmpeg` 路径是否可用
   - 视频/封面文件是否存在
   - 返回给前端的媒体 URL 是否正确

### 调试建议

当再次出现“封面显示或播放失败”时，按顺序检查：

1. 在渲染进程控制台执行：

```js
await window.api.debugScreenRecordingAccess()
```

2. 查看主进程日志中是否有：
   - `[recording] poster ... failed`
   - `[recording] media protocol failed`
   - `[recording] player console: ...`

3. 确认关键前置条件：
   - `recordingsDir` 指向 `~/Downloads/Recording`
   - `ffmpegPath` 可执行
   - `fileExists/posterExists` 均为 `true`
## Recording And Cloud Sync Pipeline

### End To End Work Chain

The current recording pipeline is split into three layers:

1. Renderer capture layer  
   `src/renderer/src/hooks/useScreenRecordingController.js`  
   The renderer owns screen permission, `getDisplayMedia`, the single continuous `MediaRecorder`, and periodic `ondataavailable` chunk emission.

2. Main-process persistence and orchestration layer  
   `src/main/recording.js` and the `src/main/recording*.js` modules  
   The main process owns session lifecycle, SQLite persistence, disk writes, local output finalization, cloud sync queue scheduling, and recovery.

3. Cloud sync server layer  
   `server/cloudSyncServer.js`  
   The server accepts upload parts, stores them by `partIndex`, and merges them by byte order after the client completes the session.

### Call Chain

#### Local recording start

1. The renderer calls `window.api.startScreenRecordingSession(...)`.
2. `src/main/recordingHandlers.js` forwards the IPC call into `createRecordingSession(...)`.
3. `src/main/recordingSessions.js` creates a runtime session and opens the first writable target.
4. Session state is persisted into SQLite through `persistRecordingSessionManifest(...)`.

#### Continuous capture and disk writes

1. The renderer creates a single `MediaRecorder`.
2. `MediaRecorder.start(1000)` emits one chunk roughly every second.
3. Each chunk is sent through `window.api.appendScreenRecordingChunk(...)`.
4. `src/main/recordingSegments.js` parses the payload into a `Buffer`.
5. The buffer is appended to disk immediately.

#### Local-only recording

When cloud sync is disabled:

- The main process writes directly into the current local segment file.
- Stop recording finalizes the last segment.
- If there is more than one local segment, the main process merges them into the final local video.
- After the final output is ready, the session directory is deleted.

#### Cloud-sync recording

When cloud sync is enabled:

- The main process writes every chunk into one continuous local capture file: `capture.<ext>.part`
- The same chunk is also written into the current transport part file: `part-0001.bin`, `part-0002.bin`, and so on
- Transport parts are cut by size threshold, not by a timed recorder restart
- Once a part reaches the configured threshold, it is sealed and queued for upload
- The continuous local capture file stays open until the user stops recording
- Stop recording closes the continuous capture file and renames it into the final local video

### Disk Persistence Strategy

#### Local output strategy

- A recording session always has a dedicated session directory under `~/Downloads/Recording/sessions/<sessionId>`
- Local metadata is persisted in SQLite, not in `manifest.json`
- During recording, chunks are written immediately to disk so the renderer does not keep the full recording in memory

#### Cloud-sync strategy

- The local source of truth for playback is the continuous capture file
- Upload parts are transport artifacts only
- Upload parts are stored in the session directory until the server reports `merged`
- After cloud merge succeeds, the session directory is cleaned

### Upload Strategy

The upload model is `parts`, not media segments.

- A part is a transport unit for retry and resume
- A part is not assumed to be an independently playable video file
- The client uploads each completed part to `PUT /api/cloud-sync/sessions/:sessionId/parts/:partIndex`
- The client later calls `POST /api/cloud-sync/sessions/:sessionId/complete`
- The server merges uploaded parts by byte order, not by ffmpeg media concat

### Why This Design

This design solves three problems from the earlier implementation:

1. It avoids recorder `stop/start` gaps that shortened the final duration.
2. It avoids keeping the full recording in renderer memory.
3. It separates local playback correctness from cloud transport batching.

### Main Modules

- `src/main/recording.js`  
  Composition root for the recording system.
- `src/main/recordingHandlers.js`  
  IPC registration layer.
- `src/main/recordingSessions.js`  
  Recording session lifecycle orchestration.
- `src/main/recordingSegments.js`  
  Chunk append, part cut, stream finalization.
- `src/main/recordingRecovery.js`  
  Local merge, cleanup, and recovery flows.
- `src/main/cloudSyncRuntime.js`  
  Background upload, retry, complete, and status polling.
- `src/main/recordingSessionState.js`  
  Runtime summary building and SQLite sync orchestration.
- `src/main/recordingDbCore.js`  
  SQLite connection and transaction primitives.
- `src/main/recordingDb.js`  
  Recording and cloud-sync persistence access layer.
- `server/cloudSyncServer.js`  
  Cloud sync HTTP server and remote part merge implementation.
