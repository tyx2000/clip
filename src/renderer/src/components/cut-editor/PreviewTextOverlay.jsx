import PropTypes from 'prop-types'
import styled from 'styled-components'

import { TEXT_DEFAULTS } from './constants'

function clampAlpha(alpha) {
  const numericAlpha = Number(alpha)
  if (!Number.isFinite(numericAlpha)) {
    return TEXT_DEFAULTS.backgroundAlpha
  }

  return Math.min(Math.max(numericAlpha, 0), 1)
}

function getPreviewBackgroundColor(color, alpha) {
  const normalizedColor = String(color || TEXT_DEFAULTS.backgroundColor).trim()
  const normalizedAlpha = clampAlpha(alpha)
  const shortHex = normalizedColor.match(/^#([0-9a-f]{3})$/i)
  const longHex = normalizedColor.match(/^#([0-9a-f]{6})$/i)
  const hex = shortHex
    ? shortHex[1]
        .split('')
        .map((char) => `${char}${char}`)
        .join('')
    : longHex?.[1]

  if (!hex) {
    return normalizedColor
  }

  const red = Number.parseInt(hex.slice(0, 2), 16)
  const green = Number.parseInt(hex.slice(2, 4), 16)
  const blue = Number.parseInt(hex.slice(4, 6), 16)

  return `rgba(${red}, ${green}, ${blue}, ${normalizedAlpha})`
}

function toPx(value) {
  return `${value}px`
}

function getTextShadow(distance, blur, color) {
  return `0 ${toPx(distance)} ${toPx(blur)} ${color}`
}

function getTextStroke(width, color) {
  return `${toPx(width)} ${color}`
}

const PreviewCaption = styled.div`
  position: absolute;
  left: ${({ $x }) => `${$x}%`};
  top: ${({ $y }) => `${$y}%`};
  box-sizing: border-box;
  max-width: 78%;
  transform: translate(-50%, -50%) scaleX(${({ $axisScale }) => $axisScale});
  border-radius: 999px;
  padding: 8px 18px;
  background: ${({ $backgroundColor, $backgroundAlpha }) =>
    getPreviewBackgroundColor($backgroundColor, $backgroundAlpha)};
  color: ${({ $color }) => $color};
  font-size: ${({ $fontSize }) => toPx($fontSize)};
  font-family: ${({ $fontFamily }) => $fontFamily};
  font-weight: ${({ $fontWeight }) => $fontWeight};
  line-height: ${({ $lineHeight }) => $lineHeight};
  letter-spacing: 0.04em;
  overflow-wrap: anywhere;
  text-align: ${({ $align }) => $align};
  text-shadow: ${({ $shadowBlur, $shadowColor, $shadowDistance }) =>
    getTextShadow($shadowDistance, $shadowBlur, $shadowColor)};
  -webkit-text-stroke: ${({ $strokeColor, $strokeWidth }) =>
    getTextStroke($strokeWidth, $strokeColor)};
  opacity: ${({ $opacity }) => $opacity};
  pointer-events: auto;
  cursor: move;
`

export function PreviewTextOverlay({ clip, onDragStart }) {
  return (
    <PreviewCaption
      $align={clip.align || TEXT_DEFAULTS.align}
      $axisScale={clip.previewTransition?.axisScale ?? 1}
      $backgroundAlpha={clip.backgroundAlpha ?? TEXT_DEFAULTS.backgroundAlpha}
      $backgroundColor={clip.backgroundColor || TEXT_DEFAULTS.backgroundColor}
      $color={clip.color || TEXT_DEFAULTS.color}
      $fontFamily={clip.fontFamily || TEXT_DEFAULTS.fontFamily}
      $fontSize={clip.fontSize || TEXT_DEFAULTS.fontSize}
      $fontWeight={clip.fontWeight || TEXT_DEFAULTS.fontWeight}
      $lineHeight={clip.lineHeight || TEXT_DEFAULTS.lineHeight}
      $opacity={(clip.opacity ?? 1) * (clip.previewTransition?.alpha ?? 1)}
      $shadowBlur={clip.shadowBlur ?? TEXT_DEFAULTS.shadowBlur}
      $shadowColor={clip.shadowColor || TEXT_DEFAULTS.shadowColor}
      $shadowDistance={clip.shadowDistance ?? TEXT_DEFAULTS.shadowDistance}
      $strokeColor={clip.strokeColor || TEXT_DEFAULTS.strokeColor}
      $strokeWidth={clip.strokeWidth ?? TEXT_DEFAULTS.strokeWidth}
      $x={clip.x ?? 50}
      $y={clip.y ?? 84}
      onPointerDown={(event) => onDragStart(event, clip)}
    >
      {clip.label}
    </PreviewCaption>
  )
}

PreviewTextOverlay.propTypes = {
  clip: PropTypes.object.isRequired,
  onDragStart: PropTypes.func.isRequired
}
