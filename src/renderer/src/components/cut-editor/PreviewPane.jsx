import PropTypes from 'prop-types'
import styled from 'styled-components'

import { PreviewImageOverlay } from './PreviewImageOverlay'
import { PreviewTextOverlay } from './PreviewTextOverlay'

const PreviewColumn = styled.section`
  min-height: 0;
  background: #101318;
`

const PreviewStage = styled.div`
  min-height: 0;
  display: grid;
  place-items: center;
  padding: 16px;
  overflow: hidden;
  background:
    linear-gradient(45deg, #0c0f14 25%, transparent 25%),
    linear-gradient(-45deg, #0c0f14 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #0c0f14 75%),
    linear-gradient(-45deg, transparent 75%, #0c0f14 75%);
  background-color: #090b0f;
  background-position:
    0 0,
    0 10px,
    10px -10px,
    -10px 0;
  background-size: 20px 20px;
`

const PreviewFrame = styled.div`
  width: min(100%, calc((100vh - var(--timeline-height) - 39px) * 16 / 9));
  max-width: 100%;
  max-height: 100%;
  aspect-ratio: 16 / 9;
  position: relative;
  border: 1px solid #343c49;
  border-radius: 2px;
  background: #000000;
  overflow: hidden;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.36);
`

const Video = styled.video`
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000000;
  visibility: ${({ $visible }) => ($visible ? 'visible' : 'hidden')};
  cursor: pointer;
`

const PreviewOverlayLayer = styled.div`
  position: absolute;
  inset: 0;
  pointer-events: none;
`

const CenterGuide = styled.span`
  position: absolute;
  display: ${({ $visible }) => ($visible ? 'block' : 'none')};
  pointer-events: none;
  z-index: 20;

  ${({ $axis }) =>
    $axis === 'x'
      ? `
        top: 0;
        bottom: 0;
        left: 50%;
        border-left: 1px dashed rgba(90, 167, 255, 0.92);
      `
      : `
        left: 0;
        right: 0;
        top: 50%;
        border-top: 1px dashed rgba(90, 167, 255, 0.92);
      `}

  &::after {
    content: '';
    position: absolute;
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: #5aa7ff;
    box-shadow: 0 0 0 3px rgba(90, 167, 255, 0.16);
    ${({ $axis }) =>
      $axis === 'x'
        ? `
          top: 50%;
          left: -4px;
          transform: translateY(-50%);
        `
        : `
          left: 50%;
          top: -4px;
          transform: translateX(-50%);
        `}
  }
`

export function PreviewPane({
  centerGuides,
  isPreviewVideoVisible,
  mediaUrl,
  onImageResizeStart,
  onOverlayDragStart,
  onPreviewVideoPointerDown,
  videoRef,
  visiblePreviewClips
}) {
  return (
    <PreviewColumn>
      <PreviewStage>
        <PreviewFrame>
          <Video
            ref={videoRef}
            src={mediaUrl}
            preload="auto"
            controls={false}
            $visible={isPreviewVideoVisible}
            onPointerDown={onPreviewVideoPointerDown}
          />
          <PreviewOverlayLayer>
            <CenterGuide $axis="x" $visible={centerGuides.x} />
            <CenterGuide $axis="y" $visible={centerGuides.y} />
            {visiblePreviewClips
              .filter((clip) => clip.kind === 'image' && clip.sourceUrl)
              .map((clip) => (
                <PreviewImageOverlay
                  key={clip.id}
                  clip={clip}
                  onDragStart={onOverlayDragStart}
                  onResizeStart={onImageResizeStart}
                />
              ))}
            {visiblePreviewClips
              .filter((clip) => clip.kind === 'text')
              .map((clip) => (
                <PreviewTextOverlay key={clip.id} clip={clip} onDragStart={onOverlayDragStart} />
              ))}
          </PreviewOverlayLayer>
        </PreviewFrame>
      </PreviewStage>
    </PreviewColumn>
  )
}

PreviewPane.propTypes = {
  centerGuides: PropTypes.shape({
    x: PropTypes.bool,
    y: PropTypes.bool
  }).isRequired,
  isPreviewVideoVisible: PropTypes.bool.isRequired,
  mediaUrl: PropTypes.string.isRequired,
  onImageResizeStart: PropTypes.func.isRequired,
  onOverlayDragStart: PropTypes.func.isRequired,
  onPreviewVideoPointerDown: PropTypes.func.isRequired,
  videoRef: PropTypes.shape({
    current: PropTypes.object
  }).isRequired,
  visiblePreviewClips: PropTypes.arrayOf(PropTypes.object).isRequired
}
