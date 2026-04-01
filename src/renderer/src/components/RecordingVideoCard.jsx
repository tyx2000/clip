import PropTypes from 'prop-types'
import styled from 'styled-components'
import {
  formatBytes,
  formatDateTime24,
  formatDuration,
  middleEllipsis
} from '../utils/recordingUtils'

const Card = styled.article`
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  padding: 12px;
  background: var(--color-block-content);
  display: grid;
  grid-template-rows: auto auto auto;
  gap: 12px;
`

const FileName = styled.p`
  margin: 0;
  font-weight: 700;
  font-size: 13px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
`

const PreviewWrap = styled.div`
  position: relative;
`

const VideoPreview = styled.video`
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 8px;
  object-fit: cover;
  background: #000;
  border: 1px solid var(--line-soft);
`

const MetaRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
`

const DurationBadge = styled.div`
  border-radius: 999px;
  padding: 3px 8px;
  background: rgba(15, 23, 42, 0.84);
  color: #ffffff;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  white-space: nowrap;
`

const FloatingActions = styled.div`
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 6px;
  opacity: 0;
  transform: translateY(-3px);
  pointer-events: none;
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;

  ${Card}:hover &,
  ${Card}:focus-within & {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }

  @media (hover: none), (pointer: coarse) {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }
`

const IconButton = styled.button`
  width: 28px;
  height: 28px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line-soft);
  background: rgba(255, 255, 255, 0.9);
  color: var(--color-text);
  cursor: pointer;

  &:hover {
    background: #ffffff;
  }
`

const DeleteButton = styled(IconButton)`
  color: #b91c1c;
`

const RetryButton = styled(IconButton)`
  color: #0f766e;
`

const MetaLine = styled.p`
  margin: 0;
  font-size: 12px;
  color: var(--color-text-soft);
  flex: 1;
  min-width: 0;
`

const SyncMeta = styled.span`
  color: ${({ $failed }) => ($failed ? '#b91c1c' : '#0f766e')};
  font-weight: 600;
`

function OpenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 5H19V10M19 5L11 13"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 5H8C6.343 5 5 6.343 5 8V16C5 17.657 6.343 19 8 19H16C17.657 19 19 17.657 19 16V14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

function RevealIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 8.5C3 7.12 4.12 6 5.5 6H8.2C8.8 6 9.35 6.33 9.63 6.86L10.1 7.8C10.37 8.33 10.92 8.66 11.52 8.66H18.5C19.88 8.66 21 9.78 21 11.16V16.5C21 17.88 19.88 19 18.5 19H5.5C4.12 19 3 17.88 3 16.5V8.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function DeleteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="M8.5 7V5.8C8.5 4.81 9.31 4 10.3 4H13.7C14.69 4 15.5 4.81 15.5 5.8V7"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M18 7L17.44 16.9C17.38 17.99 16.48 18.84 15.39 18.84H8.61C7.52 18.84 6.62 17.99 6.56 16.9L6 7"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M10 10.5V15.5M14 10.5V15.5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

function SyncIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 12A8 8 0 1 1 17.66 6.34"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M20 4V10H14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function getCloudSyncLabel(cloudSync) {
  if (!cloudSync?.enabled) {
    return ''
  }

  if (Number(cloudSync.failedSegments || 0) > 0) {
    return `???? ${Number(cloudSync.failedSegments || 0)} ?`
  }

  if (Number(cloudSync.pendingSegments || 0) > 0) {
    return `??? ${Number(cloudSync.pendingSegments || 0)} ?`
  }

  if (cloudSync.mergeStatus === 'merged') {
    return '?????'
  }

  return '????'
}

function RecordingVideoCard({ item, onOpen, onReveal, onDelete, onRetryCloudSync }) {
  const itemDurationSec = Number(item.durationSec || 0)
  const displayDurationSec =
    Number.isFinite(itemDurationSec) && itemDurationSec > 0 ? Math.floor(itemDurationSec) : 0
  const cloudSync = item.cloudSync || null
  const canRetryCloudSync =
    cloudSync?.enabled &&
    (Number(cloudSync.pendingSegments || 0) > 0 ||
      Number(cloudSync.failedSegments || 0) > 0 ||
      cloudSync.mergeStatus === 'merge_failed')
  const cloudSyncLabel = getCloudSyncLabel(cloudSync)

  return (
    <Card>
      <FileName title={item.name}>{middleEllipsis(item.name, 40)}</FileName>
      <PreviewWrap>
        <VideoPreview controls={false} preload="metadata" playsInline src={item.fileUrl} />
        <FloatingActions>
          {canRetryCloudSync ? (
            <RetryButton
              type="button"
              aria-label="????"
              title="????"
              onClick={() => onRetryCloudSync(item)}
            >
              <SyncIcon />
            </RetryButton>
          ) : null}
          <IconButton
            type="button"
            aria-label="????"
            title="????"
            onClick={() => onOpen(item.path)}
          >
            <OpenIcon />
          </IconButton>
          <IconButton
            type="button"
            aria-label="????"
            title="????"
            onClick={() => onReveal(item.path)}
          >
            <RevealIcon />
          </IconButton>
          <DeleteButton type="button" aria-label="??" title="??" onClick={() => onDelete(item)}>
            <DeleteIcon />
          </DeleteButton>
        </FloatingActions>
      </PreviewWrap>
      <MetaRow>
        <MetaLine>
          {formatDateTime24(item.createdAt)} ? {formatBytes(item.bytes)}
          {cloudSync?.enabled ? (
            <>
              {' ? '}
              <SyncMeta $failed={Number(cloudSync.failedSegments || 0) > 0}>
                {cloudSyncLabel}
              </SyncMeta>
            </>
          ) : null}
        </MetaLine>
        {displayDurationSec > 0 ? (
          <DurationBadge>{formatDuration(displayDurationSec)}</DurationBadge>
        ) : null}
      </MetaRow>
    </Card>
  )
}

RecordingVideoCard.propTypes = {
  item: PropTypes.shape({
    path: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    bytes: PropTypes.number.isRequired,
    createdAt: PropTypes.number.isRequired,
    fileUrl: PropTypes.string.isRequired,
    durationSec: PropTypes.number,
    cloudSync: PropTypes.shape({
      enabled: PropTypes.bool,
      sessionId: PropTypes.string,
      mergeStatus: PropTypes.string,
      failedSegments: PropTypes.number,
      pendingSegments: PropTypes.number
    })
  }).isRequired,
  onOpen: PropTypes.func.isRequired,
  onReveal: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onRetryCloudSync: PropTypes.func.isRequired
}

export default RecordingVideoCard
