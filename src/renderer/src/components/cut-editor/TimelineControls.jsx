import PropTypes from 'prop-types'
import styled from 'styled-components'

import {
  SPEED_OPTIONS,
  TIMELINE_EDIT_ACTIONS,
  TIMELINE_ZOOM_MAX,
  TIMELINE_ZOOM_MIN
} from './constants'
import { EditorButton } from './EditorButton'
import { formatEditorTime, formatExportProgress } from './timelineModel'

const TimelineTop = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 6px 10px;
  border-bottom: 1px solid #252b34;
`

const TimelineActions = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
`

const ToolbarDivider = styled.span`
  width: 1px;
  height: 18px;
  margin: 0 3px;
  background: #303743;
`

const TimelinePreviewActions = styled(TimelineActions)`
  justify-content: flex-end;
`

const TimelineTransport = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
`

const TimeCode = styled.span`
  color: #cbd3df;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  font-variant-numeric: tabular-nums;
  font-size: 14px;
  text-align: right;
  white-space: nowrap;
`

const InlineStatus = styled.span`
  max-width: 168px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #9aa4b2;
  font-size: 11px;
`

const HoverControl = styled.div`
  position: relative;
  display: inline-flex;
  align-items: center;

  &::before {
    content: '';
    position: absolute;
    left: -12px;
    right: -12px;
    bottom: 100%;
    height: 10px;
    display: none;
  }

  &:hover > div,
  &:focus-within > div {
    display: grid;
  }

  &:hover::before,
  &:focus-within::before {
    display: block;
  }
`

const Popover = styled.div`
  position: absolute;
  left: 50%;
  bottom: calc(100% + 8px);
  width: ${({ $narrow }) => ($narrow ? '72px' : '174px')};
  display: none;
  gap: 8px;
  padding: 10px;
  border: 1px solid #303743;
  border-radius: 8px;
  background: #171c23;
  box-shadow: 0 16px 42px rgba(0, 0, 0, 0.38);
  transform: translateX(-50%);
  z-index: 40;
`

const PopoverTitle = styled.div`
  color: #d7dde7;
  font-size: 12px;
  font-weight: 700;
`

const PopoverValue = styled.div`
  color: #8e99aa;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: center;
`

const SpeedOptions = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
`

const SpeedOption = styled.button`
  border: 1px solid #303743;
  border-radius: 6px;
  padding: 4px 6px;
  background: ${({ $active }) => ($active ? '#2f7df6' : '#20252d')};
  color: #f5f7fb;
  font-size: 11px;
  cursor: pointer;
`

const VolumeColumn = styled.div`
  height: 118px;
  display: grid;
  justify-items: center;
  gap: 8px;
`

const VolumeRange = styled.input`
  width: 28px;
  height: 92px;
  writing-mode: vertical-rl;
  direction: rtl;
  accent-color: #4b9cff;
`

export function TimelineControls({
  duration,
  editActionHandlers,
  editActionDisabled,
  exportCut,
  exportProgress,
  exportProgressText,
  exportStatus,
  isExporting,
  isPlaying,
  mediaTools,
  onMediaToolAction,
  onPlaybackRateChange,
  onVolumeChange,
  onZoomChange,
  playbackRate,
  timeCodeRef,
  togglePlayback,
  volume,
  zoom
}) {
  const zoomOut = () => onZoomChange(Math.max(TIMELINE_ZOOM_MIN, zoom - 5))
  const zoomIn = () => onZoomChange(Math.min(TIMELINE_ZOOM_MAX, zoom + 5))

  return (
    <TimelineTop>
      <TimelineActions>
        {mediaTools.map((tool) => (
          <EditorButton
            key={tool.id}
            icon={tool.id}
            title={tool.label}
            onClick={() => onMediaToolAction(tool)}
          />
        ))}
        <ToolbarDivider />
        {TIMELINE_EDIT_ACTIONS.map((action) => (
          <EditorButton
            key={action.id}
            icon={action.id}
            title={action.label}
            onClick={editActionHandlers[action.id]}
            disabled={editActionDisabled[action.id]}
          />
        ))}
      </TimelineActions>
      <TimelineTransport>
        <EditorButton icon="zoomOut" title="缩小时间刻度" onClick={zoomOut} />
        <EditorButton
          icon={isPlaying ? 'pause' : 'play'}
          title={isPlaying ? '暂停' : '播放'}
          primary
          onClick={togglePlayback}
        />
        <EditorButton icon="zoomIn" title="放大时间刻度" onClick={zoomIn} />
        <TimeCode ref={timeCodeRef}>
          {formatEditorTime(0)} / {formatEditorTime(duration)}
        </TimeCode>
      </TimelineTransport>
      <TimelinePreviewActions>
        <HoverControl>
          <EditorButton icon="speed" title="倍速" onClick={() => {}} />
          <Popover>
            <PopoverTitle>倍速</PopoverTitle>
            <SpeedOptions>
              {SPEED_OPTIONS.map((option) => (
                <SpeedOption
                  key={option}
                  type="button"
                  $active={option === playbackRate}
                  onClick={() => onPlaybackRateChange(option)}
                >
                  {option}x
                </SpeedOption>
              ))}
            </SpeedOptions>
          </Popover>
        </HoverControl>
        <HoverControl>
          <EditorButton icon="volume" title="音量" onClick={() => {}} />
          <Popover $narrow>
            <PopoverTitle>音量</PopoverTitle>
            <VolumeColumn>
              <VolumeRange
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                onChange={(event) => onVolumeChange(Number(event.target.value))}
              />
              <PopoverValue>{Math.round(volume * 100)}%</PopoverValue>
            </VolumeColumn>
          </Popover>
        </HoverControl>
        <EditorButton icon="reset" title="重置剪辑工程" onClick={editActionHandlers.reset} />
        <EditorButton
          icon="export"
          title={isExporting ? '取消当前导出任务' : '导出剪辑视频'}
          primary
          wide={isExporting}
          onClick={exportCut}
        >
          {isExporting ? formatExportProgress(exportProgress) : null}
        </EditorButton>
        {!isExporting && (exportProgressText || exportStatus) ? (
          <InlineStatus title={exportProgressText || exportStatus}>
            {exportProgressText || exportStatus}
          </InlineStatus>
        ) : null}
      </TimelinePreviewActions>
    </TimelineTop>
  )
}

TimelineControls.propTypes = {
  duration: PropTypes.number.isRequired,
  editActionDisabled: PropTypes.object.isRequired,
  editActionHandlers: PropTypes.objectOf(PropTypes.func).isRequired,
  exportCut: PropTypes.func.isRequired,
  exportProgress: PropTypes.number.isRequired,
  exportProgressText: PropTypes.string.isRequired,
  exportStatus: PropTypes.string.isRequired,
  isExporting: PropTypes.bool.isRequired,
  isPlaying: PropTypes.bool.isRequired,
  mediaTools: PropTypes.arrayOf(PropTypes.object).isRequired,
  onMediaToolAction: PropTypes.func.isRequired,
  onPlaybackRateChange: PropTypes.func.isRequired,
  onVolumeChange: PropTypes.func.isRequired,
  onZoomChange: PropTypes.func.isRequired,
  playbackRate: PropTypes.number.isRequired,
  timeCodeRef: PropTypes.shape({ current: PropTypes.object }).isRequired,
  togglePlayback: PropTypes.func.isRequired,
  volume: PropTypes.number.isRequired,
  zoom: PropTypes.number.isRequired
}
