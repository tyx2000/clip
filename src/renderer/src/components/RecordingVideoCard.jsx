import PropTypes from 'prop-types'
import { ExternalLink, FolderOpen, RefreshCw, Scissors, Trash2 } from 'lucide-react'
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

  svg {
    width: 16px;
    height: 16px;
    stroke-width: 1;
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

function getCloudSyncLabel(cloudSync) {
  if (!cloudSync?.enabled) {
    return ''
  }

  if (Number(cloudSync.failedParts || 0) > 0) {
    return `???? ${Number(cloudSync.failedParts || 0)} ?`
  }

  if (Number(cloudSync.pendingParts || 0) > 0) {
    return `??? ${Number(cloudSync.pendingParts || 0)} ?`
  }

  if (cloudSync.status === 'completed') {
    return '?????'
  }

  if (cloudSync.status === 'merging') {
    return '????'
  }

  return '???'
}

function RecordingVideoCard({ item, onOpen, onCut, onReveal, onDelete, onRetryCloudSync }) {
  const itemDurationSec = Number(item.durationSec || 0)
  const displayDurationSec =
    Number.isFinite(itemDurationSec) && itemDurationSec > 0 ? Math.floor(itemDurationSec) : 0
  const cloudSync = item.cloudSync || null
  const canRetryCloudSync =
    cloudSync?.enabled &&
    (Number(cloudSync.pendingParts || 0) > 0 ||
      Number(cloudSync.failedParts || 0) > 0 ||
      cloudSync.status === 'failed')
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
              aria-label="重试云同步"
              title="重试云同步"
              onClick={() => onRetryCloudSync(item)}
            >
              <RefreshCw aria-hidden="true" />
            </RetryButton>
          ) : null}
          <IconButton
            type="button"
            aria-label="打开剪辑"
            title="打开剪辑"
            onClick={() => onCut(item.path)}
          >
            <Scissors aria-hidden="true" />
          </IconButton>
          <IconButton
            type="button"
            aria-label="打开播放"
            title="打开播放"
            onClick={() => onOpen(item.path)}
          >
            <ExternalLink aria-hidden="true" />
          </IconButton>
          <IconButton
            type="button"
            aria-label="在文件夹中显示"
            title="在文件夹中显示"
            onClick={() => onReveal(item.path)}
          >
            <FolderOpen aria-hidden="true" />
          </IconButton>
          <DeleteButton
            type="button"
            aria-label="删除视频"
            title="删除视频"
            onClick={() => onDelete(item)}
          >
            <Trash2 aria-hidden="true" />
          </DeleteButton>
        </FloatingActions>
      </PreviewWrap>
      <MetaRow>
        <MetaLine>
          {formatDateTime24(item.createdAt)} - {formatBytes(item.bytes)}
          {cloudSync?.enabled ? (
            <SyncMeta $failed={Number(cloudSync.failedParts || 0) > 0}>{cloudSyncLabel}</SyncMeta>
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
      status: PropTypes.string,
      failedParts: PropTypes.number,
      pendingParts: PropTypes.number
    })
  }).isRequired,
  onOpen: PropTypes.func.isRequired,
  onCut: PropTypes.func.isRequired,
  onReveal: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onRetryCloudSync: PropTypes.func.isRequired
}

export default RecordingVideoCard
