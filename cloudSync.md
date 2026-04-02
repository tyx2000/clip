# Cloud Sync 可实现方案

## 1. 目标

开启云同步后，系统需要同时满足下面几个目标：

1. 本地录制优先，网络异常不能影响录制完成。
2. 录制链保持连续采集、连续落盘，不依赖 5 秒视频分段合并。
3. 云同步能够在录制过程中持续上传已稳定落盘的数据。
4. 上传失败可重试、断网可续传、重启后可恢复。
5. 最终本地视频时长以本地连续文件为准，不再因前端 stop/start 分段丢时长。

## 2. 结论

旧方案把“本地视频分段”和“云端上传分片”绑定在一起：

- 本地每 5 秒生成一个独立视频段
- 云端按视频段上传
- 最后本地和云端都基于这些视频段合并

这个方案的问题是：

1. 媒体分段和传输分片职责混在一起。
2. 分段边界容易引入时长误差。
3. 本地和云端都依赖多段合并，链路脆弱。
4. 弱网下重传成本高，因为重传的是整个视频段。

新方案应改成：

- 本地连续录制
- 本地连续落盘
- 云同步按 upload part 持续上传
- 上传分片只是传输层概念，不再是独立视频段

## 3. 新架构

建议把链路拆成四层：

### 3.1 录制层

职责：

- 创建单个连续 `MediaRecorder`
- 按固定 timeslice 产出 chunk
- 不关心上传结果

规则：

- 全程只有一个 recorder
- 不再通过 `stop/start recorder` 做 5 秒切段

### 3.2 本地写盘层

职责：

- 每个 chunk 到达后立即写入会话文件
- 维护已落盘字节边界
- 维护 upload part 索引

规则：

- 本地始终只有一个连续文件，例如 `capture.webm.part`
- 停止录制后 rename 为最终文件
- 本地不再基于多个视频段做合并

### 3.3 上传层

职责：

- 从“已稳定落盘”的字节范围中切出 upload parts
- 后台排队上传
- 失败重试
- 更新 SQLite 状态

规则：

- 上传 part 不是视频段
- 上传 part 可以按大小切分，例如 `2MB`
- 上传失败不阻塞录制和写盘

### 3.4 服务端汇总层

职责：

- 接收 upload parts
- 校验完整性
- 按 partIndex 顺序拼接
- complete 后封口

规则：

- 服务端不依赖视频段概念
- 服务端以 part 为基本传输单元

## 4. 新录制链路

### 4.1 客户端录制

前端：

1. 创建单个 `MediaRecorder`
2. `mediaRecorder.start(1000)`
3. 每 1 秒收到一个 chunk
4. chunk 立即通过 IPC 发送给主进程

### 4.2 主进程写盘

主进程：

1. 打开 `sessionDir/capture.webm.part`
2. 每个 chunk 直接 append
3. 记录：
   - `writtenBytes`
   - `flushedBytes`
   - `nextPartOffset`
4. 当满足 part 切分条件时，生成一个 upload part 记录

### 4.3 录制停止

停止时：

1. flush 最后 chunk
2. 关闭写流
3. 生成最后一个不足阈值的尾 part
4. 把 `.part` 文件 rename 成最终视频
5. probe 真实时长
6. 写入 SQLite
7. 若云同步开启，则发 `complete`

## 5. Upload Part 设计

### 5.1 为什么不再用 5 秒视频段

因为 5 秒视频段适合作为“媒体切分单位”，不适合作为“传输切分单位”。

云同步真正需要的是：

- 小粒度
- 可重试
- 幂等
- 可恢复

这些更适合由 upload part 提供，而不是由独立视频段提供。

### 5.2 推荐的 part 切分方式

推荐优先按字节切分，而不是按时间切分。

例如：

- 默认 part 大小：`2MB`
- 最小尾 part：允许不足 `2MB`

也可以使用“若干 chunk 聚合”的方式，但最终仍建议落到字节范围描述：

- `offsetStart`
- `offsetEnd`
- `sizeBytes`

### 5.3 part 状态

每个 part 建议维护：

- `pending`
- `uploading`
- `uploaded`
- `failed`
- `abandoned`

含义：

- `pending`：已稳定落盘，待上传
- `uploading`：正在上传
- `uploaded`：服务端确认接收
- `failed`：上传失败，等待重试
- `abandoned`：会话取消，不再补传

## 6. SQLite 设计

旧设计中的 `segments` 需要逐步让位给 `parts`。

建议至少维护下面几张表：

### 6.1 recordings

保存最终成片：

- `recording_id`
- `path`
- `duration_sec`
- `size_bytes`
- `created_at`

### 6.2 recording_sessions

保存录制会话：

- `session_id`
- `cloud_sync_enabled`
- `status`
- `mime_type`
- `extension`
- `started_at`
- `stopped_at`
- `local_file_path`
- `written_bytes`
- `flushed_bytes`
- `next_part_index`

### 6.3 cloud_sync_sessions

保存云同步会话：

- `session_id`
- `remote_session_created`
- `upload_status`
- `merge_status`
- `remote_video_url`
- `last_error`
- `last_attempt_at`
- `next_retry_at`

### 6.4 cloud_sync_parts

保存 part 索引：

- `session_id`
- `part_index`
- `offset_start`
- `offset_end`
- `size_bytes`
- `status`
- `checksum`
- `etag`
- `retry_count`
- `uploaded_at`

## 7. 服务端协议

现有 `segments` 接口需要升级成 `parts` 接口。

### 7.1 创建会话

`POST /api/cloud-sync/sessions`

请求：

```json
{
  "sessionId": "session-20260402-220001-abcd12",
  "mimeType": "video/webm",
  "extension": "webm",
  "startedAt": 1770000000000
}
```

### 7.2 上传 part

`PUT /api/cloud-sync/sessions/:sessionId/parts/:partIndex`

请求头建议：

- `Content-Type: application/octet-stream`
- `X-Checksum-Sha256`
- `X-File-Size`
- `X-Offset-Start`
- `X-Offset-End`
- `X-Is-Final-Part`

请求体：

- 该 part 对应的原始二进制数据

### 7.3 通知完成

`POST /api/cloud-sync/sessions/:sessionId/complete`

请求：

```json
{
  "stoppedAt": 1770000030000,
  "partCount": 9,
  "totalBytes": 12499881
}
```

### 7.4 查询状态

`GET /api/cloud-sync/sessions/:sessionId`

返回：

```json
{
  "ok": true,
  "sessionId": "session-20260402-220001-abcd12",
  "uploadStatus": "uploading",
  "mergeStatus": "pending",
  "uploadedParts": 7,
  "totalParts": 9,
  "remoteVideoUrl": "",
  "lastError": ""
}
```

## 8. 服务端行为

### 8.1 接收 part

服务端收到 part 时：

1. 校验 checksum
2. 校验 size
3. 记录 `partIndex / offset / checksum`
4. 持久化该 part

### 8.2 幂等

幂等键建议为：

- `sessionId`
- `partIndex`
- `checksum`

重复上传时：

- 若 checksum 一致，直接返回成功
- 若 checksum 冲突，返回冲突错误

### 8.3 完成会话

收到 `complete` 后：

1. 记录 `expectedPartCount`
2. 校验是否所有 part 已到齐
3. 到齐后进入拼接
4. 拼接完成后更新 `mergeStatus = merged`

## 9. 弱网与恢复

### 9.1 断网

- 录制继续
- 本地持续落盘
- part 状态停在 `pending/failed`
- 网络恢复后继续上传

### 9.2 应用崩溃

重启后：

1. 从 SQLite 读取未完成的 `recording_sessions`
2. 恢复 `cloud_sync_sessions`
3. 恢复 `cloud_sync_parts`
4. 继续上传未完成的 parts

### 9.3 高延迟

- part 上传应有独立超时
- 超时后按幂等方式安全重试

## 10. 清理策略

### 10.1 本地临时文件

本地临时目录不能在以下时机清理：

- 录制刚停止
- 最终文件刚生成
- 仅部分 parts 上传成功

### 10.2 允许清理的条件

只有同时满足：

1. 本地最终视频已生成
2. 所有 parts 已上传
3. 服务端已 `merged`
4. 客户端已收到成功状态

才允许删除临时上传状态和中间文件。

## 11. UI 建议

UI 不再显示“当前第几视频段”，而是显示：

- 本地录制状态
- 上传队列状态
- 云端状态

例如：

- `录制中`
- `待上传 2 / 上传中 1 / 失败 0`
- `云端处理中`
- `云端已完成`

## 12. 推荐实施顺序

### 阶段一

- 本地连续录制和连续落盘稳定
- 主进程支持 upload part 索引
- SQLite 新增 `cloud_sync_parts`

### 阶段二

- 服务端新增 `parts` 接口
- 客户端上传从 `segments` 切到 `parts`
- complete 改成基于 `partCount`

### 阶段三

- 删除旧的 segment 上传逻辑
- 删除基于 segment 的服务端合并逻辑
- 删除旧的前端 5 秒分段心智

## 13. 成功标准

1. 开启云同步后，录制过程中可持续上传已落盘数据。
2. 本地录制完成不依赖网络完成。
3. 本地最终视频时长与实际录制时长接近一致。
4. 断网恢复后可继续上传未完成 parts。
5. 重启应用后可恢复未完成会话。
6. 旧的 5 秒视频段不再是云同步主链路的一部分。
