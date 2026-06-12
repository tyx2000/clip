import PropTypes from 'prop-types'
import styled from 'styled-components'

import { TRACK_GUTTER_WIDTH } from './constants'
import { TimelineClip } from './TimelineClip'
import { TimelineControls } from './TimelineControls'
import { TimelineRuler } from './TimelineRuler'
import { TimelineTrack } from './TimelineTrack'

const TimelineResizeHandle = styled.div`
  position: relative;
  border-top: 1px solid #252b34;
  border-bottom: 1px solid #252b34;
  background: #15191f;
  cursor: ns-resize;

  &::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 54px;
    height: 2px;
    border-radius: 999px;
    background: #3a424f;
    transform: translate(-50%, -50%);
  }
`

const Timeline = styled.section`
  min-height: 0;
  display: grid;
  grid-template-rows: 36px 24px minmax(0, 1fr);
  background: #111418;
`

const TrackViewport = styled.div`
  min-height: 0;
  overflow: auto;
  scrollbar-color: #242a33 #11161d;
  scrollbar-width: thin;

  &::-webkit-scrollbar {
    width: 7px;
    height: 7px;
  }

  &::-webkit-scrollbar-track {
    background: #11161d;
  }

  &::-webkit-scrollbar-thumb {
    border-radius: 999px;
    background: #242a33;
  }
`

const TrackContent = styled.div`
  position: relative;
  width: 100%;
  min-height: 100%;
  padding-bottom: 24px;
  transition: min-width 160ms ease;
`

const Playhead = styled.div`
  position: absolute;
  top: 0;
  left: var(--playhead-left, ${TRACK_GUTTER_WIDTH}px);
  width: 12px;
  height: 100%;
  transform: translateX(-5px);
  background: transparent;
  z-index: 20;
  cursor: ew-resize;
  transition: left 160ms ease;

  &::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 5px;
    width: 2px;
    background: #ffdf5d;
    box-shadow: 0 0 12px rgba(255, 223, 93, 0.62);
  }
`

export function TimelinePanel({
  draggedTimelineClip,
  duration,
  exportCut,
  exportProgress,
  exportProgressText,
  exportStatus,
  handleLanePointerDown,
  handleTimelineScroll,
  history,
  isExporting,
  isPlaying,
  mediaTools,
  onDeleteSelectedClip,
  onDuplicateSelectedClip,
  onMediaToolAction,
  onPlaybackRateChange,
  onResetProject,
  onSplitSelectedClip,
  onTimelineResizeStart,
  onVolumeChange,
  onZoomChange,
  playbackRate,
  playheadRef,
  redo,
  redoStack,
  rulerTicks,
  rulerViewportRef,
  selectedClip,
  selectedClipId,
  startDrag,
  startPlayheadScrub,
  startRulerScrub,
  timeCodeRef,
  timelineDragPreview,
  timelineTracks,
  timelineWidth,
  trackViewportRef,
  undo,
  volume,
  zoom,
  clipsByTrackId,
  clipThumbnailsById,
  togglePlayback
}) {
  const editActionHandlers = {
    delete: onDeleteSelectedClip,
    duplicate: onDuplicateSelectedClip,
    redo,
    reset: onResetProject,
    split: onSplitSelectedClip,
    undo
  }
  const editActionDisabled = {
    delete: !selectedClip,
    duplicate: !selectedClip,
    redo: !redoStack.length,
    reset: false,
    split: !selectedClip,
    undo: !history.length
  }

  return (
    <>
      <TimelineResizeHandle onPointerDown={onTimelineResizeStart} />

      <Timeline>
        <TimelineControls
          duration={duration}
          editActionDisabled={editActionDisabled}
          editActionHandlers={editActionHandlers}
          exportCut={exportCut}
          exportProgress={exportProgress}
          exportProgressText={exportProgressText}
          exportStatus={exportStatus}
          isExporting={isExporting}
          isPlaying={isPlaying}
          mediaTools={mediaTools}
          onMediaToolAction={onMediaToolAction}
          onPlaybackRateChange={onPlaybackRateChange}
          onVolumeChange={onVolumeChange}
          onZoomChange={onZoomChange}
          playbackRate={playbackRate}
          timeCodeRef={timeCodeRef}
          togglePlayback={togglePlayback}
          volume={volume}
          zoom={zoom}
        />

        <TimelineRuler
          rulerTicks={rulerTicks}
          rulerViewportRef={rulerViewportRef}
          startRulerScrub={startRulerScrub}
          timelineWidth={timelineWidth}
        />

        <TrackViewport ref={trackViewportRef} onScroll={handleTimelineScroll}>
          <TrackContent style={{ minWidth: timelineWidth + TRACK_GUTTER_WIDTH }}>
            <Playhead ref={playheadRef} onPointerDown={startPlayheadScrub} />
            {timelineTracks.map((track) => {
              const showOriginPlaceholder = draggedTimelineClip?.trackId === track.id
              const laneDropState =
                timelineDragPreview?.targetTrackId === track.id
                  ? timelineDragPreview.dropState
                  : undefined
              return (
                <TimelineTrack
                  key={track.id}
                  dimmed={Boolean(timelineDragPreview && draggedTimelineClip?.kind !== track.kind)}
                  draggedClip={draggedTimelineClip}
                  dropState={laneDropState}
                  onLanePointerDown={handleLanePointerDown}
                  showOriginPlaceholder={showOriginPlaceholder}
                  track={track}
                  zoom={zoom}
                >
                  {(clipsByTrackId.get(track.id) || []).map((clip) => {
                    const left = clip.startTime * zoom
                    const width = Math.max(28, clip.duration * zoom)
                    const selected = clip.id === selectedClipId
                    const clipThumbnails = clipThumbnailsById.get(clip.id) || []
                    const dragPreview =
                      timelineDragPreview?.clipId === clip.id ? timelineDragPreview : null
                    return (
                      <TimelineClip
                        key={clip.id}
                        clip={clip}
                        clipThumbnails={clipThumbnails}
                        dragPreview={dragPreview}
                        left={left}
                        selected={selected}
                        startDrag={startDrag}
                        width={width}
                      />
                    )
                  })}
                </TimelineTrack>
              )
            })}
          </TrackContent>
        </TrackViewport>
      </Timeline>
    </>
  )
}

TimelinePanel.propTypes = {
  clipThumbnailsById: PropTypes.instanceOf(Map).isRequired,
  clipsByTrackId: PropTypes.instanceOf(Map).isRequired,
  draggedTimelineClip: PropTypes.object,
  duration: PropTypes.number.isRequired,
  exportCut: PropTypes.func.isRequired,
  exportProgress: PropTypes.number.isRequired,
  exportProgressText: PropTypes.string.isRequired,
  exportStatus: PropTypes.string.isRequired,
  handleLanePointerDown: PropTypes.func.isRequired,
  handleTimelineScroll: PropTypes.func.isRequired,
  history: PropTypes.arrayOf(PropTypes.object).isRequired,
  isExporting: PropTypes.bool.isRequired,
  isPlaying: PropTypes.bool.isRequired,
  mediaTools: PropTypes.arrayOf(PropTypes.object).isRequired,
  onDeleteSelectedClip: PropTypes.func.isRequired,
  onDuplicateSelectedClip: PropTypes.func.isRequired,
  onMediaToolAction: PropTypes.func.isRequired,
  onPlaybackRateChange: PropTypes.func.isRequired,
  onResetProject: PropTypes.func.isRequired,
  onSplitSelectedClip: PropTypes.func.isRequired,
  onTimelineResizeStart: PropTypes.func.isRequired,
  onVolumeChange: PropTypes.func.isRequired,
  onZoomChange: PropTypes.func.isRequired,
  playbackRate: PropTypes.number.isRequired,
  playheadRef: PropTypes.shape({ current: PropTypes.object }).isRequired,
  redo: PropTypes.func.isRequired,
  redoStack: PropTypes.arrayOf(PropTypes.object).isRequired,
  rulerTicks: PropTypes.arrayOf(PropTypes.object).isRequired,
  rulerViewportRef: PropTypes.shape({ current: PropTypes.object }).isRequired,
  selectedClip: PropTypes.object,
  selectedClipId: PropTypes.string.isRequired,
  startDrag: PropTypes.func.isRequired,
  startPlayheadScrub: PropTypes.func.isRequired,
  startRulerScrub: PropTypes.func.isRequired,
  timeCodeRef: PropTypes.shape({ current: PropTypes.object }).isRequired,
  timelineDragPreview: PropTypes.object,
  timelineTracks: PropTypes.arrayOf(PropTypes.object).isRequired,
  timelineWidth: PropTypes.number.isRequired,
  togglePlayback: PropTypes.func.isRequired,
  trackViewportRef: PropTypes.shape({ current: PropTypes.object }).isRequired,
  undo: PropTypes.func.isRequired,
  volume: PropTypes.number.isRequired,
  zoom: PropTypes.number.isRequired
}
