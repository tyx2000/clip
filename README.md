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
