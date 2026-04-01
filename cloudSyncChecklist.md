# Cloud Sync Checklist

## Phase 1: Protocol

- [x] Renderer sends `cloudSyncEnabled` with session start.
- [x] Main process persists `cloudSyncEnabled` into recording session manifest.
- [x] Main process creates a remote cloud-sync session before first segment upload.
- [ ] Segment upload client sends:
  - [x] `sessionId`
  - [x] `segmentIndex`
  - [x] raw segment bytes
  - [x] `X-Checksum-Sha256`
  - [x] `X-File-Size`
- [x] Client notifies `/complete` after final local segment is finalized.
- [x] Client polls session status until `merged` or `merge_failed`.

## Phase 2: Local Persistence

- [x] Extend local session manifest to include:
  - [x] `cloudSyncEnabled`
  - [x] remote upload state
  - [x] per-segment upload status
  - [x] retry count
  - [x] checksum
  - [x] remote object key / etag
- [x] Keep local segments until remote merge succeeds.
- [x] Recover pending uploads on app restart.

## Phase 3: Upload Queue

- [x] Add background upload queue separate from recording writes.
- [x] Limit upload concurrency to `1` per session.
- [x] Add exponential backoff retries.
- [ ] Pause queue when offline.
- [ ] Resume queue when network returns.
- [x] Make uploads idempotent by `sessionId + segmentIndex + checksum`.

## Phase 4: Server

- [x] `POST /api/cloud-sync/sessions`
- [x] `PUT /api/cloud-sync/sessions/:sessionId/segments/:index`
- [x] `POST /api/cloud-sync/sessions/:sessionId/complete`
- [x] `GET /api/cloud-sync/sessions/:sessionId`
- [x] `GET /api/cloud-sync/sessions/:sessionId/merged`
- [x] Split server startup shell from cloud-sync business module.
- [ ] Persist upload token / auth validation.
- [ ] Store per-segment metadata in durable manifest.
- [ ] Add merge worker retry policy.
- [ ] Add cleanup retention policy.

## Phase 5: Integrity

- [x] Calculate SHA-256 for uploaded segments on server.
- [x] Calculate SHA-256 on client after local segment finalization.
- [x] Reject mismatched checksum with explicit retry path.
- [x] Reject conflicting checksum for same segment index.

## Phase 6: UI

- [x] Show cloud session status in recording metrics.
- [x] Show uploaded / pending / failed segment counts.
- [ ] Show cloud merge result on video cards or detail panel.
- [ ] Add retry sync button for failed sessions.
- [ ] Add "sync pending" warning before deleting local files.

## Phase 7: Edge Cases

- [ ] Handle final segment shorter than 5s.
- [ ] Ignore zero-byte final segment safely.
- [x] Recover from app crash during upload.
- [x] Recover from app crash during merge polling.
- [ ] Preserve local output if remote merge fails.
- [x] Delay local cleanup until remote merge succeeds.

## Validation

- [ ] Record 30s on strong network and verify remote merge.
- [ ] Record 30s on throttled/high-latency network and verify eventual merge.
- [ ] Disconnect network mid-recording and verify local recording continues.
- [ ] Restore network and verify pending segments resume upload.
- [ ] Restart app with pending cloud-sync session and verify recovery.
