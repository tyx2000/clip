import PropTypes from 'prop-types'
import styled from 'styled-components'

const PreviewImage = styled.img`
  width: 100%;
  display: block;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
`

const PreviewImageFrame = styled.div`
  position: absolute;
  left: ${({ $x }) => `${$x}%`};
  top: ${({ $y }) => `${$y}%`};
  width: ${({ $scale }) => `${$scale}%`};
  opacity: ${({ $opacity }) => $opacity};
  transform: translate(-50%, -50%) scaleX(${({ $axisScale }) => $axisScale});
  filter: drop-shadow(0 12px 28px rgba(0, 0, 0, 0.52));
  pointer-events: auto;
  cursor: move;
`

const ResizeHandle = styled.span`
  position: absolute;
  width: 3px;
  height: 3px;
  border: 2px solid #ffffff;
  border-radius: 999px;
  background: #2f7df6;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
  pointer-events: auto;
  ${({ $corner }) => {
    if ($corner === 'tl') return 'left: -3px; top: -3px; cursor: nwse-resize;'
    if ($corner === 'tr') return 'right: -3px; top: -3px; cursor: nesw-resize;'
    if ($corner === 'bl') return 'left: -3px; bottom: -3px; cursor: nesw-resize;'
    return 'right: -3px; bottom: -3px; cursor: nwse-resize;'
  }}
`

export function PreviewImageOverlay({ clip, onDragStart, onResizeStart }) {
  return (
    <PreviewImageFrame
      $axisScale={clip.previewTransition?.axisScale ?? 1}
      $opacity={(clip.opacity ?? 1) * (clip.previewTransition?.alpha ?? 1)}
      $scale={clip.scale || 28}
      $x={clip.x ?? 50}
      $y={clip.y ?? 50}
      onPointerDown={(event) => onDragStart(event, clip)}
    >
      <PreviewImage src={clip.sourceUrl} alt="" draggable={false} />
      {['tl', 'tr', 'br', 'bl'].map((corner) => (
        <ResizeHandle
          key={corner}
          $corner={corner}
          onPointerDown={(event) => onResizeStart(event, clip)}
        />
      ))}
    </PreviewImageFrame>
  )
}

PreviewImageOverlay.propTypes = {
  clip: PropTypes.object.isRequired,
  onDragStart: PropTypes.func.isRequired,
  onResizeStart: PropTypes.func.isRequired
}
