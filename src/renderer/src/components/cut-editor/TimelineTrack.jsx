import PropTypes from 'prop-types'
import styled from 'styled-components'

import { TRACK_GUTTER_WIDTH } from './constants'

const TrackRow = styled.div`
  display: grid;
  grid-template-columns: ${TRACK_GUTTER_WIDTH}px minmax(0, 1fr);
  min-height: 58px;
`

const TrackLabel = styled.div`
  border-right: 1px solid #252b34;
  border-bottom: 1px solid #202630;
`

const Lane = styled.div`
  position: relative;
  border-bottom: 1px solid #202630;
  background: ${({ $dropState, $kind }) => {
    if ($dropState === 'valid') return 'rgba(55, 211, 139, 0.08)'
    if ($dropState === 'invalid') return 'rgba(255, 91, 91, 0.08)'
    if ($kind === 'video') return '#151a22'
    if ($kind === 'audio') return '#141d1d'
    if ($kind === 'image') return '#191820'
    return '#17191f'
  }};
  opacity: ${({ $dimmed }) => ($dimmed ? 0.45 : 1)};
  cursor: pointer;
`

const ClipPlaceholder = styled.div`
  position: absolute;
  left: ${({ $left }) => `${$left}px`};
  top: 10px;
  width: ${({ $width }) => `${$width}px`};
  height: 38px;
  border: 1px dashed rgba(255, 255, 255, 0.28);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.04);
`

export function TimelineTrack({
  children,
  dimmed,
  dropState,
  draggedClip,
  onLanePointerDown,
  showOriginPlaceholder,
  track,
  zoom
}) {
  return (
    <TrackRow>
      <TrackLabel />
      <Lane
        $dimmed={dimmed}
        $dropState={dropState}
        $kind={track.kind}
        data-track-id={track.id}
        data-track-kind={track.kind}
        data-track-preview={track.isPreview ? 'true' : undefined}
        onPointerDown={onLanePointerDown}
      >
        {showOriginPlaceholder ? (
          <ClipPlaceholder
            $left={draggedClip.startTime * zoom}
            $width={Math.max(28, draggedClip.duration * zoom)}
          />
        ) : null}
        {children}
      </Lane>
    </TrackRow>
  )
}

TimelineTrack.propTypes = {
  children: PropTypes.node.isRequired,
  dimmed: PropTypes.bool.isRequired,
  draggedClip: PropTypes.object,
  dropState: PropTypes.string,
  onLanePointerDown: PropTypes.func.isRequired,
  showOriginPlaceholder: PropTypes.bool.isRequired,
  track: PropTypes.object.isRequired,
  zoom: PropTypes.number.isRequired
}
