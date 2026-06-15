import { useState } from 'react'
import styled from 'styled-components'
import RecordingVideoCard from './components/RecordingVideoCard'
import SourcePickerModal from './components/SourcePickerModal'
import { formatBytes, formatDuration, getPreferredRecorderMimeType } from './utils/recordingUtils'
import { useScreenRecordingController } from './hooks/useScreenRecordingController'

const Page = styled.main`
  height: 100%;
  padding: 22px;
  display: grid;
  grid-template-rows: auto auto 1fr;
  gap: 14px;
`

const TopBar = styled.section`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--line-soft);
  background: var(--color-block-card-strong);
`

const TitleGroup = styled.div`
  display: grid;
  gap: 6px;
`

const Title = styled.h1`
  margin: 0;
  font-size: 22px;
  line-height: 1.2;
`

const StatusText = styled.span`
  margin: 0;
  color: var(--color-text-soft);
  font-size: 12px;
`

const MetricsRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`

const MetricPill = styled.span`
  border-radius: 999px;
  padding: 5px 9px;
  border: 1px solid
    ${({ $danger, $warning }) => ($danger ? '#991b1b' : $warning ? '#fecaca' : 'var(--line-soft)')};
  background: ${({ $danger, $warning }) =>
    $danger ? '#fee2e2' : $warning ? '#fef2f2' : 'var(--color-block-input)'};
  color: ${({ $danger, $warning }) =>
    $danger ? '#7f1d1d' : $warning ? '#b91c1c' : 'var(--color-text-soft)'};
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
`

const TopActions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
`

const RecordTimeBadge = styled.span`
  min-width: 68px;
  text-align: center;
  border-radius: 10px;
  padding: 9px 12px;
  border: 1px solid ${({ $active }) => ($active ? '#fecaca' : 'var(--line-soft)')};
  background: ${({ $active }) => ($active ? '#fef2f2' : 'var(--color-block-input)')};
  color: ${({ $active }) => ($active ? '#b91c1c' : 'var(--color-text)')};
  font-weight: 700;
  font-variant-numeric: tabular-nums;
`

const Button = styled.button`
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  padding: 9px 12px;
  min-width: 112px;
  background: var(--color-block-input);
  color: var(--color-text);
  font-weight: 600;
  cursor: pointer;

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`

const RecordButton = styled(Button)`
  border: none;
  background: ${({ $active }) => ($active ? '#b42318' : 'var(--color-block-button)')};
  color: #ffffff;
`

const ListWrap = styled.section`
  border-radius: 12px;
  border: 1px solid var(--line-soft);
  background: var(--color-block-card);
  padding: 14px;
`

const ListHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
`

const VideosGrid = styled.div`
  min-height: 320px;
  display: grid;
  place-items: ${({ $hasItems }) => ($hasItems ? 'stretch' : 'center')};
`

const SectionTitle = styled.h2`
  margin: 0;
  font-size: 16px;
`

const EmptyState = styled.p`
  margin: 0;
  font-size: 13px;
  color: var(--color-text-soft);
  text-align: center;
`

const RecordingGrid = styled.div`
  width: 100%;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  align-items: start;
  gap: 12px;
`

const PlayerPage = styled.main`
  height: 100%;
  display: grid;
  grid-template-rows: auto 1fr;
  background: #0b1020;
  color: #e5e7eb;
`

const PlayerHeader = styled.header`
  padding: 10px 14px;
  border-bottom: 1px solid #1f2937;
  color: #93c5fd;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const PlayerBody = styled.section`
  padding: 12px;
  display: grid;
  place-items: center;
`

const PlayerVideo = styled.video`
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
  border-radius: 8px;
`

function applySessionStats(result, setRecordingStats) {
  if (!result) {
    return
  }

  setRecordingStats({
    partCount: Number(result.partCount || 0),
    currentPartIndex: Number(result.currentPartIndex || 0),
    currentPartBytes: Number(result.currentPartBytes || 0),
    totalBytes: Number(result.totalBytes || 0),
    freeBytes: Number(result.storage?.freeBytes || 0),
    lowDiskSpace: Boolean(result.storage?.lowDiskSpace),
    criticalDiskSpace: Boolean(result.storage?.criticalDiskSpace),
    cloudSyncEnabled: Boolean(result.cloudSyncEnabled),
    cloudSync: result.cloudSync || null
  })
}

function App() {
  const playerParams = new URLSearchParams(window.location.search)
  const playerUrl = playerParams.get('player') || ''
  const playerName = playerParams.get('name') || '录制回放'
  const isPlayerWindow = Boolean(playerUrl)
  const [preferredMimeType] = useState(() => getPreferredRecorderMimeType())

  const {
    recordings,
    isLoadingList,
    pickerOpen,
    pickerLoading,
    pickerSources,
    pickerSelectedSourceId,
    pickerCloudSyncEnabled,
    setPickerSelectedSourceId,
    setPickerCloudSyncEnabled,
    elapsedSec,
    statusMessage,
    recordingStats,
    displayedCurrentPartBytes,
    isRecording,
    isBusy,
    loadRecordings,
    handleRecordButtonClick,
    cancelRecording,
    handleConfirmSourceAndStart,
    handleCancelPicker,
    handleOpenRecording,
    handleRevealRecording,
    handleDeleteRecordingWithGuard,
    handleRetryCloudSync
  } = useScreenRecordingController({
    isPlayerWindow,
    playerName,
    preferredMimeType,
    applySessionStats
  })

  if (isPlayerWindow) {
    return (
      <PlayerPage>
        <PlayerHeader title={playerName}>{playerName}</PlayerHeader>
        <PlayerBody>
          <PlayerVideo controls preload="metadata" src={playerUrl} />
        </PlayerBody>
      </PlayerPage>
    )
  }

  return (
    <>
      <Page>
        <TopBar>
          <TitleGroup>
            <Title>
              屏幕录制 <StatusText>{statusMessage}</StatusText>
            </Title>
            {recordingStats ? (
              <MetricsRow>
                <MetricPill>已写入 {formatBytes(recordingStats.totalBytes)}</MetricPill>
                <MetricPill>
                  当前分片 #{recordingStats.currentPartIndex || 1} ·{' '}
                  {formatBytes(displayedCurrentPartBytes)}
                </MetricPill>
                <MetricPill>分片数 {recordingStats.partCount}</MetricPill>
                <MetricPill>
                  {recordingStats.cloudSyncEnabled
                    ? `云同步开启 · 待传 ${Number(recordingStats.cloudSync?.pendingParts || 0)} · 失败 ${Number(recordingStats.cloudSync?.failedParts || 0)}`
                    : '云同步关闭'}
                </MetricPill>
                <MetricPill
                  $warning={recordingStats.lowDiskSpace}
                  $danger={recordingStats.criticalDiskSpace}
                >
                  {recordingStats.criticalDiskSpace ? '空间临界' : '可用空间'}{' '}
                  {formatBytes(recordingStats.freeBytes)}
                </MetricPill>
              </MetricsRow>
            ) : null}
          </TitleGroup>
          <TopActions>
            <RecordTimeBadge $active={isRecording}>{formatDuration(elapsedSec)}</RecordTimeBadge>
            {isRecording ? (
              <Button type="button" onClick={cancelRecording} disabled={isBusy}>
                取消录制
              </Button>
            ) : null}
            <RecordButton
              type="button"
              onClick={handleRecordButtonClick}
              disabled={isBusy}
              $active={isRecording}
            >
              {isRecording ? '停止录制' : isBusy ? '处理中...' : '开始录制'}
            </RecordButton>
          </TopActions>
        </TopBar>

        <ListWrap>
          <ListHeader>
            <SectionTitle>已录制视频</SectionTitle>
            <Button type="button" onClick={loadRecordings} disabled={isLoadingList || isBusy}>
              {isLoadingList ? '加载中...' : '刷新列表'}
            </Button>
          </ListHeader>

          <VideosGrid $hasItems={!isLoadingList && recordings.length > 0}>
            {isLoadingList ? (
              <EmptyState>正在加载录屏列表...</EmptyState>
            ) : recordings.length === 0 ? (
              <EmptyState>暂无录屏文件</EmptyState>
            ) : (
              <RecordingGrid>
                {recordings.map((item) => (
                  <RecordingVideoCard
                    key={item.path}
                    item={item}
                    onOpen={handleOpenRecording}
                    onReveal={handleRevealRecording}
                    onDelete={handleDeleteRecordingWithGuard}
                    onRetryCloudSync={handleRetryCloudSync}
                  />
                ))}
              </RecordingGrid>
            )}
          </VideosGrid>
        </ListWrap>
      </Page>

      <SourcePickerModal
        open={pickerOpen}
        loading={pickerLoading}
        sources={pickerSources}
        selectedSourceId={pickerSelectedSourceId}
        cloudSyncEnabled={pickerCloudSyncEnabled}
        isBusy={isBusy}
        onSelect={setPickerSelectedSourceId}
        onToggleCloudSync={setPickerCloudSyncEnabled}
        onCancel={handleCancelPicker}
        onConfirm={handleConfirmSourceAndStart}
      />
    </>
  )
}

export default App
