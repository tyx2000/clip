# Cloud Sync Checklist

## Phase 1: Continuous Local Recording

- [x] Renderer keeps a single continuous `MediaRecorder`.
- [x] Main process continuously appends chunks to one local session file.
- [ ] Local final output no longer depends on multi-segment merge for cloud sync.
- [ ] Stop flow closes local file, renames final output, probes duration, writes SQLite.

## Phase 2: Part Model

- [ ] Replace cloud-sync `segments` with upload `parts`.
- [ ] Define part boundary by stable flushed bytes, not by 5s media segments.
- [ ] Add `cloud_sync_parts` table in SQLite.
- [ ] Track:
  - [ ] `part_index`
  - [ ] `offset_start`
  - [ ] `offset_end`
  - [ ] `size_bytes`
  - [ ] `status`
  - [ ] `checksum`
  - [ ] `retry_count`
  - [ ] `uploaded_at`

## Phase 3: Main Process Upload Queue

- [ ] Generate upload parts from continuously written local file.
- [ ] Queue pending parts in background without blocking recording writes.
- [ ] Limit concurrency to `1` per session.
- [ ] Retry failed parts with exponential backoff.
- [ ] Pause queue when offline.
- [ ] Resume queue when network returns.
- [ ] Recover pending parts from SQLite on app restart.

## Phase 4: Server Protocol

- [ ] Keep `POST /api/cloud-sync/sessions`.
- [ ] Add `PUT /api/cloud-sync/sessions/:sessionId/parts/:partIndex`.
- [ ] Update `POST /api/cloud-sync/sessions/:sessionId/complete` to use `partCount`.
- [ ] Update `GET /api/cloud-sync/sessions/:sessionId` to return part-based progress.
- [ ] Persist per-part metadata durably on server.
- [ ] Keep upload idempotent by `sessionId + partIndex + checksum`.

## Phase 5: Integrity

- [ ] Calculate SHA-256 for each upload part on client.
- [ ] Validate checksum and size on server.
- [ ] Reject checksum conflicts for same `partIndex`.
- [ ] Treat duplicate same-checksum upload as success.

## Phase 6: Recovery

- [ ] Restore unfinished local recording sessions from SQLite.
- [ ] Restore unfinished cloud sync sessions from SQLite.
- [ ] Restore pending and failed parts from SQLite.
- [ ] Continue uploads after restart without scanning manifest files.

## Phase 7: Cleanup

- [ ] Do not delete local temp data until remote `merged`.
- [ ] After remote `merged`, delete temp upload artifacts and part rows.
- [ ] Preserve final local video.
- [ ] Expose cleanup failure as explicit state, not silent success.

## Phase 8: UI

- [ ] Show `pending / uploading / failed` part counts.
- [ ] Show remote merge state clearly.
- [ ] Show retry entry for failed cloud sync session.
- [ ] Warn before deleting a local video with unfinished cloud sync.

## Validation

- [ ] Record 30s with cloud sync on and verify uploads happen during recording.
- [ ] Record 30s on high latency network and verify eventual success.
- [ ] Disconnect network mid-recording and verify local recording continues.
- [ ] Restore network and verify pending parts resume upload.
- [ ] Restart app with pending session and verify SQLite-based recovery.
- [ ] Verify final local video duration matches actual recording closely.
