import PropTypes from 'prop-types'
import styled from 'styled-components'

import { EditorIcon } from './icons'

const ClipFrame = styled.div`
  position: absolute;
  left: ${({ $left }) => `${$left}px`};
  top: 9px;
  width: ${({ $width }) => `${$width}px`};
  height: 40px;
  border: 1px solid
    ${({ $dropState, $selected }) => {
      if ($dropState === 'invalid') return '#ff6b6b'
      if ($dropState === 'valid') return '#37d38b'
      return $selected ? '#5aa7ff' : '#3a4655'
    }};
  border-radius: 2px;
  overflow: hidden;
  background: ${({ $kind }) => {
    if ($kind === 'video') return '#25324a'
    if ($kind === 'audio') return '#21423d'
    if ($kind === 'image') return '#49356d'
    return '#52412e'
  }};
  opacity: ${({ $dragging }) => ($dragging ? 0.74 : 1)};
  transform: translate(
    ${({ $dragDeltaX }) => `${$dragDeltaX}px`},
    ${({ $dragDeltaY }) => `${$dragDeltaY}px`}
  );
  z-index: ${({ $dragging, $selected }) => ($dragging ? 8 : $selected ? 5 : 2)};
  cursor: grab;
  user-select: none;
  transition: ${({ $dragging }) =>
    $dragging
      ? 'border-color 120ms ease, opacity 120ms ease'
      : 'left 160ms ease, width 160ms ease, border-color 120ms ease, opacity 120ms ease'};
`

const ClipThumbs = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  overflow: hidden;
  opacity: 0.72;
  pointer-events: none;
`

const ClipThumb = styled.img`
  width: 54px;
  height: 100%;
  object-fit: cover;
  flex: 0 0 auto;
`

const ClipLabel = styled.div`
  position: absolute;
  inset: 0 9px;
  display: flex;
  align-items: center;
  gap: 6px;
  color: #f5f7fb;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const ClipIcon = styled.span`
  display: inline-grid;
  place-items: center;
`

const EdgeHandle = styled.span`
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  bottom: 0;
  ${({ $side }) => ($side === 'left' ? 'left: 0;' : 'right: 0;')}
  width: 3px;
  height: 70%;
  border-radius: ${({ $side }) => ($side === 'left' ? '0px 5px 5px 0' : '5px 0 0 5px')};
  background: rgb(63, 65, 232);
  cursor: ew-resize;
  z-index: 3;
`

export function ClipEdgeHandle({ clip, side, startDrag }) {
  return (
    <EdgeHandle
      $side={side}
      onPointerDown={(event) =>
        startDrag(event, clip, side === 'left' ? 'trim-left' : 'trim-right')
      }
    />
  )
}

ClipEdgeHandle.propTypes = {
  clip: PropTypes.object.isRequired,
  side: PropTypes.oneOf(['left', 'right']).isRequired,
  startDrag: PropTypes.func.isRequired
}

export function TimelineClip({
  clip,
  clipThumbnails,
  dragPreview,
  left,
  selected,
  startDrag,
  width
}) {
  return (
    <ClipFrame
      data-clip-id={clip.id}
      $dragDeltaX={dragPreview?.deltaX || 0}
      $dragDeltaY={dragPreview?.deltaY || 0}
      $dragging={Boolean(dragPreview)}
      $dropState={dragPreview?.dropState}
      $kind={clip.kind}
      $left={left}
      $selected={selected}
      $width={width}
      title={clip.kind === 'video' ? '视频片段' : clip.label}
      onPointerDown={(event) => startDrag(event, clip, 'move')}
    >
      {clipThumbnails.length > 0 ? (
        <ClipThumbs>
          {clipThumbnails.map((thumb) => (
            <ClipThumb key={thumb.time} src={thumb.dataUrl} alt="" draggable={false} />
          ))}
        </ClipThumbs>
      ) : null}
      {clip.kind === 'image' && clip.sourceUrl ? (
        <ClipThumbs>
          <ClipThumb src={clip.sourceUrl} alt="" draggable={false} />
        </ClipThumbs>
      ) : null}
      <ClipEdgeHandle side="left" clip={clip} startDrag={startDrag} />
      {clip.kind !== 'video' ? (
        <ClipLabel>
          <ClipIcon>
            <EditorIcon id={clip.kind} />
          </ClipIcon>
          {clip.label}
        </ClipLabel>
      ) : null}
      <ClipEdgeHandle side="right" clip={clip} startDrag={startDrag} />
    </ClipFrame>
  )
}

TimelineClip.propTypes = {
  clip: PropTypes.object.isRequired,
  clipThumbnails: PropTypes.arrayOf(PropTypes.object).isRequired,
  dragPreview: PropTypes.object,
  left: PropTypes.number.isRequired,
  selected: PropTypes.bool.isRequired,
  startDrag: PropTypes.func.isRequired,
  width: PropTypes.number.isRequired
}
