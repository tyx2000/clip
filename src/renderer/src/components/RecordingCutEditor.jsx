import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import styled from 'styled-components'

const MIN_CLIP_DURATION = 0.2
const HISTORY_LIMIT = 80
const TIMELINE_ZOOM_DEFAULT = 10
const TIMELINE_ZOOM_MIN = 4
const TIMELINE_ZOOM_MAX = 80
const DEFAULT_EXPORT = {
  bitrate: 4_000_000,
  fps: 30,
  height: 0,
  width: 0
}
const OVERLAY_FADE_SECONDS = 0.35
const DEFAULT_TRANSITION = 'rotateY'
const TEXT_DEFAULTS = {
  align: 'center',
  backgroundAlpha: 0.58,
  backgroundColor: '#000000',
  color: '#ffffff',
  fontFamily: 'Avenir Next, Helvetica, sans-serif',
  fontSize: 22,
  fontWeight: '800',
  lineHeight: 1.2,
  shadowBlur: 8,
  shadowColor: '#000000',
  shadowDistance: 2,
  strokeColor: '#000000',
  strokeWidth: 0
}

const TRACKS = [
  { id: 'video', label: '视频', kind: 'video' },
  { id: 'audio', label: '音频', kind: 'audio' },
  { id: 'image', label: '叠图', kind: 'image' },
  { id: 'text', label: '字幕', kind: 'text' }
]

const TOOLS = [
  { id: 'select', label: '选择', kind: 'video' },
  { id: 'split', label: '分割', kind: 'video' },
  { id: 'text', label: '文本', kind: 'text' },
  { id: 'image', label: '贴图', kind: 'image' },
  { id: 'audio', label: '音频', kind: 'audio' },
  { id: 'importVideo', label: '导入视频', kind: 'video' },
  { id: 'export', label: '导出', kind: 'video' }
]

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]

const Shell = styled.main`
  height: 100%;
  display: grid;
  grid-template-rows: minmax(0, 1fr) minmax(220px, 34vh);
  background: #111418;
  color: #f5f7fb;
`

const SubTitle = styled.p`
  margin: 0;
  color: #9aa4b2;
  font-size: 12px;
`

const IconButton = styled.button`
  width: 24px;
  height: 24px;
  min-width: 24px;
  border: 1px solid ${({ $active }) => ($active ? '#5aa7ff' : '#303743')};
  border-radius: 6px;
  padding: 0;
  background: ${({ $active, $primary }) =>
    $primary ? '#2f7df6' : $active ? '#1f3557' : '#20252d'};
  color: #f5f7fb;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;

  svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
`

const Workspace = styled.section`
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 318px;
  border-bottom: 1px solid #252b34;
`

const PreviewColumn = styled.section`
  min-height: 0;
  display: grid;
  grid-template-rows: 38px minmax(0, 1fr);
  background: #101318;
`

const PreviewHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px;
  border-bottom: 1px solid #252b34;
  color: #a9b2c0;
  font-size: 12px;
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
  width: min(100%, calc((100vh - 16px - 16px - 38px - max(220px, 34vh)) * 16 / 9));
  max-width: 100%;
  aspect-ratio: 16 / 9;
  position: relative;
  border: 1px solid #343c49;
  border-radius: 8px;
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
`

const PreviewOverlayLayer = styled.div`
  position: absolute;
  inset: 0;
  pointer-events: auto;
`

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
  width: 12px;
  height: 12px;
  border: 2px solid #ffffff;
  border-radius: 999px;
  background: #2f7df6;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
  pointer-events: auto;
  ${({ $corner }) => {
    if ($corner === 'tl') return 'left: -6px; top: -6px; cursor: nwse-resize;'
    if ($corner === 'tr') return 'right: -6px; top: -6px; cursor: nesw-resize;'
    if ($corner === 'bl') return 'left: -6px; bottom: -6px; cursor: nesw-resize;'
    return 'right: -6px; bottom: -6px; cursor: nwse-resize;'
  }}
`

const PreviewCaption = styled.div`
  position: absolute;
  left: ${({ $x }) => `${$x}%`};
  top: ${({ $y }) => `${$y}%`};
  max-width: 78%;
  transform: translate(-50%, -50%) scaleX(${({ $axisScale }) => $axisScale});
  border-radius: 999px;
  padding: 8px 18px;
  background: ${({ $backgroundColor, $backgroundAlpha }) =>
    `${$backgroundColor}${Math.round($backgroundAlpha * 255)
      .toString(16)
      .padStart(2, '0')}`};
  color: ${({ $color }) => $color};
  font-size: ${({ $fontSize }) => `${$fontSize}px`};
  font-family: ${({ $fontFamily }) => $fontFamily};
  font-weight: ${({ $fontWeight }) => $fontWeight};
  line-height: ${({ $lineHeight }) => $lineHeight};
  letter-spacing: 0.04em;
  text-align: ${({ $align }) => $align};
  text-shadow: 0 ${({ $shadowDistance }) => `${$shadowDistance}px`}
    ${({ $shadowBlur }) => `${$shadowBlur}px`} ${({ $shadowColor }) => $shadowColor};
  -webkit-text-stroke: ${({ $strokeWidth }) => `${$strokeWidth}px`}
    ${({ $strokeColor }) => $strokeColor};
  opacity: ${({ $opacity }) => $opacity};
  pointer-events: auto;
  cursor: move;
`

const TimeCode = styled.span`
  color: #cbd3df;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  font-variant-numeric: tabular-nums;
  font-size: 14px;
  text-align: right;
  white-space: nowrap;
`

const Range = styled.input`
  width: 100%;
  accent-color: #4b9cff;
`

const Inspector = styled.aside`
  min-height: 0;
  display: grid;
  align-content: start;
  grid-auto-rows: max-content;
  gap: 10px;
  padding: 12px;
  border-left: 1px solid #252b34;
  background: #15191f;
  overflow-y: auto;
  overscroll-behavior: contain;
`

const Panel = styled.section`
  min-height: 0;
  border: 1px solid #2a303a;
  border-radius: 8px;
  background: #1b2028;
  padding: 10px;
  display: grid;
  gap: 10px;
`

const PanelTitle = styled.h2`
  margin: 0;
  color: #f5f7fb;
  font-size: 13px;
  line-height: 1.2;
`

const FieldGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
`

const Field = styled.label`
  display: grid;
  gap: 5px;
  color: #a9b2c0;
  font-size: 11px;
`

const Input = styled.input`
  width: 100%;
  height: 30px;
  border: 1px solid #303743;
  border-radius: 7px;
  padding: 0 8px;
  background: #11161d;
  color: #f5f7fb;
`

const Select = styled.select`
  width: 100%;
  height: 30px;
  border: 1px solid #303743;
  border-radius: 7px;
  padding: 0 8px;
  background: #11161d;
  color: #f5f7fb;
`

const TodoList = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 7px;
  overflow: auto;
`

const TodoItem = styled.li`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: #a9b2c0;
  font-size: 12px;
`

const TodoState = styled.span`
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 2px 7px;
  background: ${({ $done }) => ($done ? '#163b2c' : '#352d1d')};
  color: ${({ $done }) => ($done ? '#8ce2b5' : '#f0c36a')};
  font-size: 11px;
`

const Timeline = styled.section`
  min-height: 0;
  display: grid;
  grid-template-rows: 36px 24px minmax(0, 1fr);
  background: #111418;
`

const TimelineTop = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 0 10px;
  border-bottom: 1px solid #252b34;
`

const TimelineActions = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
`

const TimelineEditActions = styled(TimelineActions)`
  justify-content: flex-end;
`

const TimelineTransport = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`

const ZoomLabel = styled.span`
  color: #a9b2c0;
  font-size: 12px;
`

const ToolAction = styled(IconButton)`
  width: 24px;
`

const HiddenInput = styled.input`
  display: none;
`

const RulerViewport = styled.div`
  overflow: hidden;
  border-bottom: 1px solid #252b34;
`

const Ruler = styled.div`
  position: relative;
  height: 24px;
  margin-left: 92px;
`

const Tick = styled.span`
  position: absolute;
  left: ${({ $left }) => `${$left}px`};
  top: 0;
  height: 24px;
  color: #7e8998;
  font-size: 10px;
  min-width: 48px;
  transform: translateX(-1px);
  white-space: nowrap;

  &::before {
    content: '';
    display: block;
    width: 1px;
    height: 8px;
    margin-bottom: 2px;
    background: #3a424f;
  }
`

const TrackViewport = styled.div`
  position: relative;
  overflow: auto;
`

const TrackContent = styled.div`
  position: relative;
  min-height: 100%;
  min-width: 100%;
`

const TrackRow = styled.div`
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  min-height: 56px;
  border-bottom: 1px solid #252b34;
`

const TrackLabel = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  border-right: 1px solid #252b34;
  background: #15191f;
  color: #a9b2c0;
  font-size: 12px;
  font-weight: 700;
`

const Lane = styled.div`
  position: relative;
  min-height: 56px;
  background: ${({ $kind }) =>
    $kind === 'video'
      ? '#121b25'
      : $kind === 'audio'
        ? '#111d19'
        : $kind === 'text'
          ? '#1a1825'
          : '#1c1a12'};
`

const Clip = styled.div`
  position: absolute;
  top: 8px;
  left: ${({ $left }) => `${$left}px`};
  width: ${({ $width }) => `${$width}px`};
  min-width: 28px;
  height: 40px;
  border: 1px solid ${({ $selected }) => ($selected ? '#ffffff' : 'rgba(255, 255, 255, 0.22)')};
  border-radius: 8px;
  background: ${({ $kind }) =>
    $kind === 'video'
      ? '#24598f'
      : $kind === 'audio'
        ? '#1f7a53'
        : $kind === 'text'
          ? '#6f4db7'
          : '#8a6a24'};
  box-shadow: ${({ $selected }) => ($selected ? '0 0 0 2px #4b9cff' : 'none')};
  cursor: grab;
  overflow: hidden;
  user-select: none;
`

const ClipThumbs = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  opacity: 0.82;
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
  inset: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  color: #ffffff;
  font-size: 12px;
  font-weight: 700;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.48);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const ClipIcon = styled.span`
  width: 16px;
  min-width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  color: #ffffff;

  svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
`

const Waveform = styled.div`
  position: absolute;
  inset: 7px 18px;
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0.84;
  pointer-events: none;
`

const WaveBar = styled.span`
  flex: 1 1 0;
  min-width: 1px;
  height: ${({ $value }) => `${Math.max(12, Math.round($value * 100))}%`};
  border-radius: 999px;
  background: rgba(210, 255, 229, 0.86);
`

const EdgeHandle = styled.span`
  position: absolute;
  top: 0;
  bottom: 0;
  width: 14px;
  ${({ $side }) => ($side === 'left' ? 'left: 0;' : 'right: 0;')}
  cursor: ew-resize;
  background: linear-gradient(
    ${({ $side }) => ($side === 'left' ? '90deg' : '270deg')},
    rgba(255, 255, 255, 0.28),
    rgba(255, 255, 255, 0)
  );
  z-index: 2;
`

const Playhead = styled.div`
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--playhead-left, 92px);
  width: 12px;
  transform: translateX(-5px);
  background: transparent;
  cursor: ew-resize;
  pointer-events: auto;
  z-index: 10;

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

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function roundTime(value) {
  return Math.round(value * 100) / 100
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function cloneClips(clips) {
  return clips.map((clip) => ({ ...clip }))
}

function formatEditorTime(value) {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0
  const totalMilliseconds = Math.floor(safeValue * 1000)
  const milliseconds = totalMilliseconds % 1000
  const totalSeconds = Math.floor(totalMilliseconds / 1000)
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  const secondText = String(seconds).padStart(2, '0')
  const millisecondText = String(milliseconds).padStart(3, '0')

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${secondText}.${millisecondText}`
  }

  return `${String(minutes).padStart(2, '0')}:${secondText}.${millisecondText}`
}

function formatRulerTime(value) {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0
  const totalSeconds = Math.floor(safeValue)
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  const secondText = String(seconds).padStart(2, '0')

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${secondText}`
  }

  return `${String(minutes).padStart(2, '0')}:${secondText}`
}

function getTimelineEnd(clips, fallbackDuration) {
  return Math.max(
    fallbackDuration,
    1,
    ...clips.map((clip) => Number(clip.startTime || 0) + Number(clip.duration || 0))
  )
}

function getTrackEnd(clips, trackId) {
  return Math.max(
    0,
    ...clips
      .filter((clip) => clip.trackId === trackId)
      .map((clip) => Number(clip.startTime || 0) + Number(clip.duration || 0))
  )
}

function getClipEnd(clip) {
  return Number(clip.startTime || 0) + Number(clip.duration || 0)
}

function getClipSourceEnd(clip) {
  return Number(clip.sourceStart || 0) + Number(clip.duration || 0)
}

function findVideoClipAtTime(clips, time) {
  return clips.find((clip) => time >= clip.startTime && time < getClipEnd(clip))
}

function getClipThumbnails(clip, thumbnails) {
  if (clip.kind !== 'video' || !thumbnails.length) {
    return clip.kind === 'video' && clip.thumbnails?.length ? clip.thumbnails : []
  }

  const sourceThumbnails = clip.thumbnails?.length ? clip.thumbnails : thumbnails
  const sourceStart = Number(clip.sourceStart || 0)
  const sourceEnd = sourceStart + Number(clip.duration || 0)
  const clippedThumbnails = sourceThumbnails.filter(
    (thumb) => thumb.time >= sourceStart && thumb.time <= sourceEnd
  )

  return clippedThumbnails.length ? clippedThumbnails : sourceThumbnails
}

function getClipWaveform(clip) {
  const waveform = clip.waveform?.length ? clip.waveform : createFallbackWaveform()
  const sourceDuration = Math.max(MIN_CLIP_DURATION, Number(clip.sourceDuration || clip.duration))
  const sourceStart = Math.max(0, Number(clip.sourceStart || 0))
  const sourceEnd = Math.min(sourceDuration, sourceStart + Number(clip.duration || 0))
  const startIndex = Math.floor((sourceStart / sourceDuration) * waveform.length)
  const endIndex = Math.ceil((sourceEnd / sourceDuration) * waveform.length)
  const sliced = waveform.slice(startIndex, Math.max(startIndex + 1, endIndex))

  return sliced.length ? sliced : waveform
}

function isClipActiveAtTime(clip, time) {
  return time >= clip.startTime && time < getClipEnd(clip)
}

function easeInOut(value) {
  return value * value * (3 - 2 * value)
}

function getOverlayTransitionAtTime(clip, time) {
  const start = Number(clip.startTime || 0)
  const end = getClipEnd(clip)
  if (time < start || time >= end) {
    return { alpha: 0, axisScale: 1 }
  }

  const transitionSeconds =
    Number(clip.transitionSeconds) >= 0 ? Number(clip.transitionSeconds) : OVERLAY_FADE_SECONDS
  const fadeIn = transitionSeconds > 0 ? Math.min((time - start) / transitionSeconds, 1) : 1
  const fadeOut = transitionSeconds > 0 ? Math.min((end - time) / transitionSeconds, 1) : 1
  const progress = easeInOut(Math.min(fadeIn, fadeOut))
  const transitionType = clip.transitionType || DEFAULT_TRANSITION

  if (transitionType === 'none') {
    return { alpha: progress > 0 ? 1 : 0, axisScale: 1 }
  }

  return {
    alpha: progress,
    axisScale: transitionType === 'rotateY' ? Math.cos((1 - progress) * (Math.PI / 2)) : 1
  }
}

function getVisiblePreviewClips(clips, time) {
  return clips
    .filter(
      (clip) => (clip.kind === 'image' || clip.kind === 'text') && isClipActiveAtTime(clip, time)
    )
    .map((clip) => ({ ...clip, previewTransition: getOverlayTransitionAtTime(clip, time) }))
    .sort((a, b) => a.startTime - b.startTime)
}

function getPreviewOverlaySignature(clips) {
  return clips
    .map((clip) =>
      [
        clip.id,
        clip.kind,
        clip.label,
        clip.x,
        clip.y,
        clip.scale,
        clip.opacity,
        clip.transitionType,
        clip.transitionSeconds,
        clip.color,
        clip.fontFamily,
        clip.fontSize,
        clip.fontWeight,
        clip.align,
        clip.lineHeight,
        clip.strokeColor,
        clip.strokeWidth,
        clip.shadowColor,
        clip.shadowBlur,
        clip.shadowDistance,
        clip.backgroundColor,
        clip.backgroundAlpha,
        clip.previewTransition?.alpha,
        clip.previewTransition?.axisScale
      ].join(':')
    )
    .join('|')
}

function getOverlayBoundsFromElement(element) {
  const layer = element.parentElement
  const layerRect = layer?.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  if (!layerRect || !layerRect.width || !layerRect.height) {
    return null
  }

  const halfWidth = (elementRect.width / layerRect.width) * 50
  const halfHeight = (elementRect.height / layerRect.height) * 50
  return {
    height: layerRect.height,
    maxX: 100 - halfWidth,
    maxY: 100 - halfHeight,
    minX: halfWidth,
    minY: halfHeight,
    width: layerRect.width
  }
}

function clampOverlayPosition(x, y, bounds) {
  if (!bounds) {
    return {
      x: clamp(x, 0, 100),
      y: clamp(y, 0, 100)
    }
  }

  return {
    x: clamp(x, bounds.minX, bounds.maxX),
    y: clamp(y, bounds.minY, bounds.maxY)
  }
}

function createFallbackWaveform(bucketCount = 72) {
  return Array.from({ length: bucketCount }, (_, index) => {
    const phase = index / Math.max(1, bucketCount - 1)
    return 0.18 + Math.abs(Math.sin(phase * Math.PI * 5)) * 0.72
  })
}

async function analyzeAudioFile(file, bucketCount = 88) {
  const AudioContext = window.AudioContext || window.webkitAudioContext
  if (!AudioContext) {
    return { duration: 3, waveform: createFallbackWaveform(bucketCount) }
  }

  const context = new AudioContext()
  try {
    const audioBuffer = await context.decodeAudioData(await file.arrayBuffer())
    const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) =>
      audioBuffer.getChannelData(index)
    )
    const bucketSize = Math.max(1, Math.floor(audioBuffer.length / bucketCount))
    const rmsBuckets = Array.from({ length: bucketCount }, (_, index) => {
      const start = index * bucketSize
      const end = Math.min(audioBuffer.length, start + bucketSize)
      let sum = 0
      let count = 0
      for (let cursor = start; cursor < end; cursor += 1) {
        const mixed =
          channels.reduce((total, channel) => total + Math.abs(channel[cursor] || 0), 0) /
          Math.max(1, channels.length)
        sum += mixed * mixed
        count += 1
      }
      return Math.sqrt(sum / Math.max(1, count))
    })
    const maxRms = Math.max(0.001, ...rmsBuckets)
    const waveform = rmsBuckets.map((value) => Math.max(0.08, Math.min(1, value / maxRms)))

    return { duration: audioBuffer.duration, waveform }
  } finally {
    await context.close?.()
  }
}

function loadVideoFileInfo(sourceUrl) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.onloadedmetadata = () => {
      resolve({
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        height: video.videoHeight || 0,
        width: video.videoWidth || 0
      })
    }
    video.onerror = () => reject(new Error('视频文件读取失败'))
    video.src = sourceUrl
  })
}

async function extractVideoFileThumbnails(sourceUrl, duration, count = 10) {
  const safeDuration = Math.max(0, Number(duration) || 0)
  if (!safeDuration) {
    return []
  }

  const video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  video.src = sourceUrl

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve
    video.onerror = () => reject(new Error('视频缩略图读取失败'))
  })

  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 72
  const context = canvas.getContext('2d')
  if (!context) {
    return []
  }

  const frameCount = Math.min(12, Math.max(4, count))
  const thumbnails = []
  for (let index = 0; index < frameCount; index += 1) {
    const ratio = frameCount === 1 ? 0 : index / (frameCount - 1)
    const time = Math.max(0, Math.min(safeDuration - 0.05, safeDuration * ratio))
    await new Promise((resolve) => {
      video.onseeked = resolve
      video.currentTime = time
    })
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    thumbnails.push({ time, dataUrl: canvas.toDataURL('image/jpeg', 0.72) })
  }

  return thumbnails
}

function applySeek(nextTime, { onTimeChange, setCurrentTime, timelineDuration }) {
  const clamped = clamp(nextTime, 0, Math.max(1, timelineDuration))

  onTimeChange?.(clamped)
  setCurrentTime(clamped)
}

function getRulerStep(zoom) {
  const minStep = 88 / Math.max(zoom, 1)
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800]
  return steps.find((step) => step >= minStep) || 3600
}

function createVideoClip(duration, name) {
  return {
    duration,
    id: createId('video'),
    kind: 'video',
    label: name || 'Video',
    muted: false,
    sourceStart: 0,
    sourceDuration: duration,
    startTime: 0,
    trackId: 'video',
    volume: 1
  }
}

function ToolIcon({ toolId }) {
  if (toolId === 'image') {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="4" y="5" width="16" height="14" rx="2" />
        <circle cx="9" cy="10" r="1.5" />
        <path d="M5 17l4.2-4.2 3.2 3.2 2.1-2.1L19 18" />
      </svg>
    )
  }

  if (toolId === 'importVideo') {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="4" y="6" width="12" height="12" rx="2" />
        <path d="M16 10l4-2.5v9L16 14" />
        <path d="M9 9v6M6 12h6" />
      </svg>
    )
  }

  if (toolId === 'select') return '↖'
  if (toolId === 'split') return '✂'
  if (toolId === 'text') return 'T'
  if (toolId === 'audio') return '♪'
  return '⇩'
}

ToolIcon.propTypes = {
  toolId: PropTypes.string.isRequired
}

function RecordingCutEditor({ videoUrl, fileUrl, sourcePath, displayName }) {
  const videoRef = useRef(null)
  const playheadRef = useRef(null)
  const timeCodeRef = useRef(null)
  const dragRef = useRef(null)
  const scrubDragRef = useRef(null)
  const wasPlayingBeforeScrubRef = useRef(false)
  const audioInputRef = useRef(null)
  const imageInputRef = useRef(null)
  const videoInputRef = useRef(null)
  const objectVideoUrlRef = useRef('')
  const objectAssetUrlsRef = useRef(new Set())
  const audioElementsRef = useRef(new Map())
  const visibleOverlayKeyRef = useRef('')
  const activeVideoClipIdRef = useRef('')
  const previewVideoVisibleRef = useRef(true)
  const timelinePlaybackRef = useRef({ startedAt: 0, startTime: 0 })
  const overlayDragRef = useRef(null)
  const mediaMetadataInitializedRef = useRef(false)
  const animationFrameRef = useRef(0)
  const currentTimeRef = useRef(0)
  const durationRef = useRef(0)
  const timelineDurationRef = useRef(1)
  const zoomRef = useRef(TIMELINE_ZOOM_DEFAULT)
  const clipsRef = useRef([])
  const videoClipsRef = useRef([])
  const [activeTool, setActiveTool] = useState('select')
  const [duration, setDuration] = useState(0)
  const [, setCurrentTime] = useState(0)
  const [clips, setClips] = useState([])
  const [selectedClipId, setSelectedClipId] = useState('')
  const [playbackRate, setPlaybackRate] = useState(1)
  const [volume, setVolume] = useState(1)
  const [zoom, setZoom] = useState(TIMELINE_ZOOM_DEFAULT)
  const [isPlaying, setIsPlaying] = useState(false)
  const [history, setHistory] = useState([])
  const [redoStack, setRedoStack] = useState([])
  const [thumbnails, setThumbnails] = useState([])
  const [thumbStatus, setThumbStatus] = useState('idle')
  const [exportSettings, setExportSettings] = useState(DEFAULT_EXPORT)
  const [exportStatus, setExportStatus] = useState('')
  const [playbackStatus, setPlaybackStatus] = useState('')
  const [mediaUrl, setMediaUrl] = useState(fileUrl || videoUrl)
  const [mediaName] = useState(displayName)
  const [isPreviewVideoVisible, setIsPreviewVideoVisible] = useState(true)
  const [visiblePreviewClips, setVisiblePreviewClips] = useState([])

  const selectedClip = useMemo(
    () => clips.find((clip) => clip.id === selectedClipId) || null,
    [clips, selectedClipId]
  )
  const timelineDuration = getTimelineEnd(clips, duration)
  const timelineWidth = Math.max(820, Math.ceil(timelineDuration * zoom) + 160)

  const rulerTicks = useMemo(() => {
    const step = getRulerStep(zoom)
    const count = Math.ceil(timelineDuration / step) + 1
    return Array.from({ length: count }, (_, index) => {
      const time = index * step
      return {
        label: formatRulerTime(time),
        left: time * zoom
      }
    })
  }, [timelineDuration, zoom])

  const videoClips = useMemo(
    () => clips.filter((clip) => clip.kind === 'video').sort((a, b) => a.startTime - b.startTime),
    [clips]
  )

  function pushHistory(nextClips = clips) {
    setHistory((previous) => [...previous.slice(-HISTORY_LIMIT + 1), cloneClips(nextClips)])
    setRedoStack([])
  }

  function applyClips(updater, { record = true } = {}) {
    setClips((previous) => {
      const next = typeof updater === 'function' ? updater(previous) : updater
      if (record) {
        setHistory((historyValue) => [
          ...historyValue.slice(-HISTORY_LIMIT + 1),
          cloneClips(previous)
        ])
        setRedoStack([])
      }
      return next
    })
  }

  const ensureVideoClip = useEffectEvent((nextDuration, { resetTime = false } = {}) => {
    if (!(nextDuration > 0)) {
      return
    }

    const initialClip = createVideoClip(nextDuration, mediaName)
    const existingVideoClip = clips.find((clip) => clip.kind === 'video')
    durationRef.current = nextDuration
    setDuration(nextDuration)
    setClips((previous) => {
      const previousVideoClip = previous.find((clip) => clip.kind === 'video')
      if (!previousVideoClip) {
        return [initialClip, ...previous]
      }

      return previous.map((clip) =>
        clip.id === previousVideoClip.id
          ? {
              ...clip,
              duration: Math.max(clip.duration, nextDuration),
              label: clip.label || mediaName
            }
          : clip
      )
    })
    setSelectedClipId((selected) => selected || existingVideoClip?.id || initialClip.id)

    if (resetTime) {
      currentTimeRef.current = 0
      setCurrentTime(0)
      syncTimelineUi(0)
    } else {
      syncTimelineUi()
    }
  })

  function captureFallbackThumbnail() {
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) {
      return
    }

    try {
      const canvas = document.createElement('canvas')
      canvas.width = 128
      canvas.height = 72
      const context = canvas.getContext('2d')
      if (!context) {
        return
      }

      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      setThumbnails([
        { time: video.currentTime || 0, dataUrl: canvas.toDataURL('image/jpeg', 0.72) }
      ])
      setThumbStatus('fallback')
    } catch {
      // Canvas can fail for unsupported/cross-origin media; ffmpeg extraction remains primary.
    }
  }

  function getAudioElement(clip) {
    if (!clip.sourceUrl) {
      return null
    }

    const existing = audioElementsRef.current.get(clip.id)
    if (existing?.src === clip.sourceUrl) {
      return existing
    }

    existing?.pause()
    const audio = new Audio(clip.sourceUrl)
    audio.preload = 'auto'
    audioElementsRef.current.set(clip.id, audio)
    return audio
  }

  function getVideoClipSource(clip) {
    return clip?.sourceUrl || mediaUrl
  }

  function setPreviewVideoVisible(nextVisible) {
    if (previewVideoVisibleRef.current === nextVisible) {
      return
    }

    previewVideoVisibleRef.current = nextVisible
    setIsPreviewVideoVisible(nextVisible)
  }

  function stopAllAudio() {
    for (const audio of audioElementsRef.current.values()) {
      audio.pause()
    }
  }

  function syncVideoPlayback(time, playing = false) {
    const video = videoRef.current
    if (!video) {
      return
    }

    const clip = findVideoClipAtTime(videoClipsRef.current, time)
    if (!clip) {
      activeVideoClipIdRef.current = ''
      video.pause()
      setPreviewVideoVisible(false)
      return
    }

    const sourceUrl = getVideoClipSource(clip)
    if (video.dataset.sourceUrl !== sourceUrl) {
      video.pause()
      video.src = sourceUrl
      video.dataset.sourceUrl = sourceUrl
      activeVideoClipIdRef.current = ''
    }

    const sourceTime = clamp(
      Number(clip.sourceStart || 0) + (time - clip.startTime),
      Number(clip.sourceStart || 0),
      getClipSourceEnd(clip)
    )
    const enteredClip = activeVideoClipIdRef.current !== clip.id
    activeVideoClipIdRef.current = clip.id
    setPreviewVideoVisible(true)
    video.playbackRate = playbackRate
    video.volume = volume

    if (enteredClip || Math.abs(video.currentTime - sourceTime) > 0.12 || !playing) {
      video.currentTime = sourceTime
    }

    if (playing && video.paused) {
      video.play().catch((error) => {
        const message = error instanceof Error ? error.message : '播放失败'
        setPlaybackStatus(message)
      })
    } else if (!playing) {
      video.pause()
    }
  }

  function syncPreviewOverlays(time) {
    const overlays = getVisiblePreviewClips(clipsRef.current, time)
    const overlayKey = getPreviewOverlaySignature(overlays)
    if (overlayKey === visibleOverlayKeyRef.current) {
      return
    }

    visibleOverlayKeyRef.current = overlayKey
    setVisiblePreviewClips(overlays)
  }

  function syncAudioPlayback(
    time,
    playing = Boolean(videoRef.current && !videoRef.current.paused)
  ) {
    let hasActiveAudio = false

    for (const clip of clipsRef.current) {
      if (clip.kind !== 'audio' || !clip.sourceUrl) {
        continue
      }

      const audio = getAudioElement(clip)
      if (!audio) {
        continue
      }

      const active = isClipActiveAtTime(clip, time)
      if (!active || clip.muted) {
        audio.pause()
        continue
      }

      hasActiveAudio = true
      const sourceTime = Number(clip.sourceStart || 0) + (time - clip.startTime)
      audio.volume = clamp(Number(clip.volume ?? 1) * volume, 0, 1)
      audio.playbackRate = playbackRate
      if (Math.abs(audio.currentTime - sourceTime) > 0.08 || audio.paused) {
        audio.currentTime = Math.max(0, sourceTime)
      }

      if (playing && audio.paused) {
        audio.play().catch(() => {
          setPlaybackStatus('音频预览播放失败')
        })
      } else if (!playing) {
        audio.pause()
      }
    }

    if (!hasActiveAudio && !playing) {
      stopAllAudio()
    }
  }

  function syncTimelineUi(nextTime = currentTimeRef.current, { playing = false } = {}) {
    const safeTime = Math.max(0, Number(nextTime) || 0)
    currentTimeRef.current = safeTime

    if (timeCodeRef.current) {
      timeCodeRef.current.textContent = `${formatEditorTime(safeTime)} / ${formatEditorTime(
        timelineDurationRef.current
      )}`
    }

    if (playheadRef.current) {
      playheadRef.current.style.setProperty(
        '--playhead-left',
        `${safeTime * zoomRef.current + 92}px`
      )
    }

    syncPreviewOverlays(safeTime)
    syncVideoPlayback(safeTime, playing)
    syncAudioPlayback(safeTime, playing)
  }

  function stopTimelineAnimation() {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = 0
    }
  }

  function pauseTimelinePlayback() {
    stopTimelineAnimation()
    setIsPlaying(false)
    syncTimelineUi(currentTimeRef.current, { playing: false })
  }

  function startTimelinePlayback(startTime = currentTimeRef.current) {
    const safeStart = startTime >= timelineDurationRef.current ? 0 : Math.max(0, startTime)
    timelinePlaybackRef.current = {
      startedAt: performance.now(),
      startTime: safeStart
    }
    setIsPlaying(true)
    setPlaybackStatus('')
    stopTimelineAnimation()

    const tick = (now) => {
      const elapsed = ((now - timelinePlaybackRef.current.startedAt) / 1000) * playbackRate
      const nextTime = Math.min(
        timelineDurationRef.current,
        timelinePlaybackRef.current.startTime + elapsed
      )
      syncTimelineUi(nextTime, { playing: true })

      if (nextTime >= timelineDurationRef.current - 0.001) {
        pauseTimelinePlayback()
        syncTimelineUi(timelineDurationRef.current, { playing: false })
        return
      }

      animationFrameRef.current = requestAnimationFrame(tick)
    }

    syncTimelineUi(safeStart, { playing: true })
    animationFrameRef.current = requestAnimationFrame(tick)
  }

  useEffect(() => {
    document.title = `视频剪辑 - ${displayName}`
  }, [displayName])

  useEffect(() => {
    durationRef.current = duration
    timelineDurationRef.current = timelineDuration
    zoomRef.current = zoom
    clipsRef.current = clips
    videoClipsRef.current = videoClips
    syncTimelineUi()
  })

  useEffect(() => {
    const objectAssetUrls = objectAssetUrlsRef.current
    return () => {
      stopTimelineAnimation()
      stopAllAudio()
      for (const assetUrl of objectAssetUrls) {
        URL.revokeObjectURL(assetUrl)
      }
      if (objectVideoUrlRef.current) {
        URL.revokeObjectURL(objectVideoUrlRef.current)
        objectVideoUrlRef.current = ''
      }
    }
  }, [])

  useEffect(() => {
    const clipIds = new Set(clips.map((clip) => clip.id))
    for (const [clipId, audio] of audioElementsRef.current.entries()) {
      if (!clipIds.has(clipId)) {
        audio.pause()
        audioElementsRef.current.delete(clipId)
      }
    }
    syncTimelineUi()
    // syncTimelineUi reads refs intentionally; adding it would re-run this cleanup sync every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips])

  useEffect(() => {
    const video = videoRef.current
    if (!video) {
      return undefined
    }

    const handleLoadedMetadata = () => {
      if (video.currentSrc && video.currentSrc !== mediaUrl) {
        return
      }
      if (mediaMetadataInitializedRef.current) {
        return
      }
      const nextDuration = Number.isFinite(video.duration) ? video.duration : 0
      if (nextDuration <= 0) {
        return
      }
      mediaMetadataInitializedRef.current = true
      ensureVideoClip(nextDuration, { resetTime: true })
      setHistory([])
      setRedoStack([])
      window.setTimeout(captureFallbackThumbnail, 0)
    }
    const handleMediaError = () => {
      const code = video.error?.code
      const message = video.error?.message || `媒体加载失败${code ? `(${code})` : ''}`
      if (mediaUrl === videoUrl && fileUrl && fileUrl !== videoUrl) {
        setMediaUrl(fileUrl)
        setPlaybackStatus('已切换到本地文件源')
        return
      }
      setPlaybackStatus(message)
    }

    video.addEventListener('loadedmetadata', handleLoadedMetadata)
    video.addEventListener('error', handleMediaError)
    if (video.readyState >= 1) {
      handleLoadedMetadata()
    }

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      video.removeEventListener('error', handleMediaError)
    }
  }, [fileUrl, mediaName, mediaUrl, videoUrl])

  useEffect(() => {
    if (
      !sourcePath ||
      duration > 0 ||
      typeof window.api?.getRecordingEditorMediaInfo !== 'function'
    ) {
      return undefined
    }

    let cancelled = false
    window.api
      .getRecordingEditorMediaInfo({ path: sourcePath })
      .then((result) => {
        if (cancelled || !result?.ok || !(result.durationSec > 0)) {
          return
        }

        const nextDuration = Number(result.durationSec)
        mediaMetadataInitializedRef.current = true
        ensureVideoClip(nextDuration, { resetTime: true })
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [duration, mediaName, sourcePath])

  useEffect(() => {
    const video = videoRef.current
    if (video) {
      video.playbackRate = playbackRate
    }
    syncAudioPlayback(currentTimeRef.current)
    // syncAudioPlayback reads live refs and should not cause media effect rebinding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackRate])

  useEffect(() => {
    const video = videoRef.current
    if (video) {
      video.volume = volume
    }
    syncAudioPlayback(currentTimeRef.current)
    // syncAudioPlayback reads live refs and should not cause media effect rebinding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume])

  useEffect(() => {
    if (
      !sourcePath ||
      !duration ||
      mediaUrl.startsWith('blob:') ||
      typeof window.api?.extractRecordingEditorThumbnails !== 'function'
    ) {
      return undefined
    }

    let cancelled = false
    const frameCount = Math.min(14, Math.max(6, Math.ceil(duration / 4)))
    const times = Array.from({ length: frameCount }, (_, index) => {
      const ratio = frameCount === 1 ? 0 : index / (frameCount - 1)
      return Math.max(0, Math.min(duration - 0.05, duration * ratio))
    })

    const loadingTimer = window.setTimeout(() => {
      if (!cancelled) {
        setThumbStatus('loading')
      }
    }, 0)

    window.api
      .extractRecordingEditorThumbnails({ path: sourcePath, times, width: 128, height: 72 })
      .then((result) => {
        if (cancelled) {
          return
        }
        if (result?.ok) {
          setThumbnails(Array.isArray(result.thumbnails) ? result.thumbnails : [])
          setThumbStatus('ready')
        } else {
          setThumbStatus('failed')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThumbStatus('failed')
        }
      })

    return () => {
      cancelled = true
      window.clearTimeout(loadingTimer)
    }
  }, [duration, mediaUrl, sourcePath])

  useEffect(() => {
    const handleMove = (event) => {
      const overlayDrag = overlayDragRef.current
      if (overlayDrag) {
        if (overlayDrag.mode === 'resize') {
          const pointerXPercent = ((event.clientX - overlayDrag.left) / overlayDrag.width) * 100
          const pointerYPercent = ((event.clientY - overlayDrag.top) / overlayDrag.height) * 100
          const widthFromX = Math.abs(pointerXPercent - overlayDrag.x) * 2
          const heightFromY = Math.abs(pointerYPercent - overlayDrag.y) * 2
          const widthFromY =
            heightFromY * (overlayDrag.height / overlayDrag.width) * overlayDrag.aspectRatio
          const heightLimitPercent = Math.min(overlayDrag.y, 100 - overlayDrag.y) * 2
          const widthLimitFromHeight =
            heightLimitPercent * (overlayDrag.height / overlayDrag.width) * overlayDrag.aspectRatio
          const widthLimitFromWidth = Math.min(overlayDrag.x, 100 - overlayDrag.x) * 2
          const nextScale = clamp(
            Math.max(widthFromX, widthFromY),
            8,
            Math.max(8, Math.min(80, widthLimitFromWidth, widthLimitFromHeight))
          )
          setClips((previous) =>
            previous.map((clip) =>
              clip.id === overlayDrag.clipId ? { ...clip, scale: roundTime(nextScale) } : clip
            )
          )
          return
        }

        const nextPosition = clampOverlayPosition(
          overlayDrag.x + ((event.clientX - overlayDrag.clientX) / overlayDrag.width) * 100,
          overlayDrag.y + ((event.clientY - overlayDrag.clientY) / overlayDrag.height) * 100,
          overlayDrag.bounds
        )
        setClips((previous) =>
          previous.map((clip) =>
            clip.id === overlayDrag.clipId
              ? { ...clip, x: roundTime(nextPosition.x), y: roundTime(nextPosition.y) }
              : clip
          )
        )
        return
      }

      const scrubDrag = scrubDragRef.current
      if (scrubDrag) {
        const nextTime = (event.clientX - scrubDrag.left) / zoom
        applySeek(nextTime, {
          onTimeChange: syncTimelineUi,
          setCurrentTime,
          timelineDuration
        })
        return
      }

      const drag = dragRef.current
      if (!drag) {
        return
      }

      const deltaTime = (event.clientX - drag.clientX) / zoom
      setClips((previous) =>
        previous.map((clip) => {
          if (clip.id !== drag.clipId) {
            return clip
          }

          if (drag.mode === 'move') {
            return {
              ...clip,
              startTime: roundTime(Math.max(0, drag.startTime + deltaTime))
            }
          }

          if (drag.mode === 'trim-left') {
            const maxStart = drag.startTime + drag.duration - MIN_CLIP_DURATION
            const nextStart = clamp(drag.startTime + deltaTime, 0, maxStart)
            const trimDelta = nextStart - drag.startTime
            return {
              ...clip,
              duration: roundTime(Math.max(MIN_CLIP_DURATION, drag.duration - trimDelta)),
              sourceStart:
                drag.kind === 'video' || drag.kind === 'audio'
                  ? roundTime(Math.max(0, drag.sourceStart + trimDelta))
                  : drag.sourceStart,
              startTime: roundTime(nextStart)
            }
          }

          const sourceLimit =
            drag.kind === 'video'
              ? Math.max(MIN_CLIP_DURATION, duration - drag.sourceStart)
              : drag.kind === 'audio'
                ? Math.max(MIN_CLIP_DURATION, drag.sourceDuration - drag.sourceStart)
                : Math.max(MIN_CLIP_DURATION, timelineDuration + 60)
          const nextDuration = clamp(drag.duration + deltaTime, MIN_CLIP_DURATION, sourceLimit)
          return {
            ...clip,
            duration: roundTime(nextDuration)
          }
        })
      )
    }
    const handleEnd = () => {
      if (scrubDragRef.current && wasPlayingBeforeScrubRef.current) {
        startTimelinePlayback(currentTimeRef.current)
      }
      dragRef.current = null
      overlayDragRef.current = null
      scrubDragRef.current = null
      wasPlayingBeforeScrubRef.current = false
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)

    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
    }
    // Pointer listeners use refs and current drag state; syncTimelineUi is intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, timelineDuration, videoClips, zoom])

  function seekTo(nextTime) {
    applySeek(nextTime, {
      onTimeChange: syncTimelineUi,
      setCurrentTime,
      timelineDuration
    })
  }

  function togglePlayback() {
    if (isPlaying) {
      pauseTimelinePlayback()
      return
    }

    startTimelinePlayback(currentTimeRef.current)
  }

  function startDrag(event, clip, mode) {
    event.preventDefault()
    event.stopPropagation()
    setSelectedClipId(clip.id)
    pushHistory(clips)
    dragRef.current = {
      clientX: event.clientX,
      clipId: clip.id,
      duration: clip.duration,
      kind: clip.kind,
      mode,
      sourceStart: clip.sourceStart || 0,
      sourceDuration: clip.sourceDuration || clip.duration,
      startTime: clip.startTime
    }
  }

  function startOverlayDrag(event, clip) {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.parentElement.getBoundingClientRect()
    const bounds = getOverlayBoundsFromElement(event.currentTarget)
    const position = clampOverlayPosition(Number(clip.x ?? 50), Number(clip.y ?? 50), bounds)
    setSelectedClipId(clip.id)
    pushHistory(clips)
    overlayDragRef.current = {
      bounds,
      clientX: event.clientX,
      clientY: event.clientY,
      clipId: clip.id,
      height: Math.max(1, rect.height),
      mode: 'move',
      width: Math.max(1, rect.width),
      x: position.x,
      y: position.y
    }
  }

  function startImageResize(event, clip) {
    event.preventDefault()
    event.stopPropagation()
    const element = event.currentTarget.parentElement
    const layer = element.parentElement
    const elementRect = element.getBoundingClientRect()
    const layerRect = layer.getBoundingClientRect()
    setSelectedClipId(clip.id)
    pushHistory(clips)
    overlayDragRef.current = {
      aspectRatio: elementRect.width / Math.max(1, elementRect.height),
      clipId: clip.id,
      height: Math.max(1, layerRect.height),
      left: layerRect.left,
      mode: 'resize',
      top: layerRect.top,
      width: Math.max(1, layerRect.width),
      x: Number(clip.x ?? 50),
      y: Number(clip.y ?? 50)
    }
  }

  function handleLanePointerDown(event) {
    const rect = event.currentTarget.getBoundingClientRect()
    seekTo((event.clientX - rect.left) / zoom)
  }

  function startPlayheadDrag(event) {
    event.preventDefault()
    event.stopPropagation()
    wasPlayingBeforeScrubRef.current = isPlaying
    if (wasPlayingBeforeScrubRef.current) {
      pauseTimelinePlayback()
    }
    const rect = event.currentTarget.parentElement.getBoundingClientRect()
    scrubDragRef.current = {
      left: rect.left + 92
    }
    seekTo((event.clientX - scrubDragRef.current.left) / zoom)
  }

  function addClip(kind) {
    const track = TRACKS.find((item) => item.kind === kind) || TRACKS[0]
    const time = currentTimeRef.current
    const clipDuration = kind === 'video' ? Math.min(4, Math.max(1, duration - time)) : 3
    const clip = {
      duration: Math.max(MIN_CLIP_DURATION, clipDuration),
      id: createId(kind),
      kind,
      label:
        kind === 'text' ? '字幕' : kind === 'image' ? '贴图' : kind === 'audio' ? '音频' : '视频',
      muted: false,
      opacity: 1,
      scale: kind === 'image' ? 28 : 1,
      sourceStart: kind === 'video' ? clamp(time, 0, duration) : 0,
      startTime: roundTime(time),
      trackId: track.id,
      transitionSeconds: 0.25,
      transitionType: DEFAULT_TRANSITION,
      volume: 1,
      x: 50,
      y: kind === 'text' ? 84 : 50,
      ...(kind === 'text' ? TEXT_DEFAULTS : {})
    }

    applyClips((previous) => [...previous, clip])
    setSelectedClipId(clip.id)
  }

  async function handleAudioFileSelected(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }

    const track = TRACKS.find((item) => item.kind === 'audio') || TRACKS[1]
    const sourceUrl = URL.createObjectURL(file)
    objectAssetUrlsRef.current.add(sourceUrl)
    const audioInfo = await analyzeAudioFile(file).catch(() => ({
      duration: 3,
      waveform: createFallbackWaveform()
    }))
    const clip = {
      duration: Math.max(MIN_CLIP_DURATION, Number(audioInfo.duration) || 3),
      id: createId('audio'),
      kind: 'audio',
      label: file.name || '音频',
      muted: false,
      sourceStart: 0,
      sourceDuration: Math.max(MIN_CLIP_DURATION, Number(audioInfo.duration) || 3),
      sourceUrl,
      startTime: roundTime(currentTimeRef.current),
      trackId: track.id,
      volume: 1,
      waveform: audioInfo.waveform
    }

    applyClips((previous) => [...previous, clip])
    setSelectedClipId(clip.id)
    setActiveTool('select')
  }

  function handleImageFileSelected(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }

    const track = TRACKS.find((item) => item.kind === 'image') || TRACKS[2]
    const sourceUrl = URL.createObjectURL(file)
    objectAssetUrlsRef.current.add(sourceUrl)
    const clip = {
      duration: 3,
      id: createId('image'),
      kind: 'image',
      label: file.name || '贴图',
      muted: false,
      opacity: 1,
      scale: 28,
      sourceStart: 0,
      sourceUrl,
      startTime: roundTime(currentTimeRef.current),
      trackId: track.id,
      transitionSeconds: 0.25,
      transitionType: DEFAULT_TRANSITION,
      volume: 1,
      x: 50,
      y: 50
    }

    applyClips((previous) => [...previous, clip])
    setSelectedClipId(clip.id)
    setActiveTool('select')
  }

  async function handleVideoFileSelected(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }

    const nextUrl = URL.createObjectURL(file)
    objectAssetUrlsRef.current.add(nextUrl)
    try {
      const info = await loadVideoFileInfo(nextUrl)
      const nextDuration = Math.max(MIN_CLIP_DURATION, Number(info.duration) || 3)
      const clip = {
        duration: nextDuration,
        id: createId('video'),
        kind: 'video',
        label: file.name || '导入视频',
        muted: false,
        sourceDuration: nextDuration,
        sourceStart: 0,
        sourceUrl: nextUrl,
        startTime: roundTime(getTrackEnd(clipsRef.current, 'video')),
        thumbnails: await extractVideoFileThumbnails(nextUrl, nextDuration).catch(() => []),
        trackId: 'video',
        volume: 1
      }
      applyClips((previous) => [...previous, clip])
      setSelectedClipId(clip.id)
      setPlaybackStatus('导入视频已追加到视频轨，导出暂未合并外部视频')
    } catch (error) {
      URL.revokeObjectURL(nextUrl)
      objectAssetUrlsRef.current.delete(nextUrl)
      const message = error instanceof Error ? error.message : '导入视频失败'
      setPlaybackStatus(message)
    }
    setActiveTool('select')
  }

  function handleToolAction(tool) {
    setActiveTool(tool.id)
    if (tool.id === 'importVideo') {
      videoInputRef.current?.click()
      return
    }

    if (tool.id === 'split') {
      splitSelectedClip()
      return
    }

    if (tool.id === 'audio') {
      audioInputRef.current?.click()
      return
    }

    if (tool.id === 'image') {
      imageInputRef.current?.click()
      return
    }

    if (tool.id === 'text') {
      addClip(tool.kind)
      return
    }

    if (tool.id === 'export') {
      exportCut()
    }
  }

  function splitSelectedClip() {
    if (!selectedClip) {
      return
    }

    const splitTime = currentTimeRef.current
    const clipStart = selectedClip.startTime
    const clipEnd = selectedClip.startTime + selectedClip.duration
    if (splitTime <= clipStart + MIN_CLIP_DURATION || splitTime >= clipEnd - MIN_CLIP_DURATION) {
      return
    }

    const leftDuration = splitTime - clipStart
    const rightDuration = clipEnd - splitTime
    const rightClip = {
      ...selectedClip,
      duration: roundTime(rightDuration),
      id: createId(selectedClip.kind),
      sourceStart:
        selectedClip.kind === 'video' || selectedClip.kind === 'audio'
          ? roundTime((selectedClip.sourceStart || 0) + leftDuration)
          : selectedClip.sourceStart,
      startTime: roundTime(splitTime)
    }

    applyClips((previous) =>
      previous.flatMap((clip) => {
        if (clip.id !== selectedClip.id) {
          return clip
        }
        return [{ ...clip, duration: roundTime(leftDuration) }, rightClip]
      })
    )
    setSelectedClipId(rightClip.id)
  }

  function duplicateSelectedClip() {
    if (!selectedClip) {
      return
    }

    const duplicate = {
      ...selectedClip,
      id: createId(selectedClip.kind),
      label: `${selectedClip.label} copy`,
      startTime: roundTime(selectedClip.startTime + selectedClip.duration + 0.2)
    }

    applyClips((previous) => [...previous, duplicate])
    setSelectedClipId(duplicate.id)
  }

  function deleteSelectedClip() {
    if (!selectedClip) {
      return
    }

    applyClips((previous) => previous.filter((clip) => clip.id !== selectedClip.id))
    setSelectedClipId('')
  }

  function resetProject() {
    if (!duration) {
      return
    }

    const initialClip = createVideoClip(duration, mediaName)
    applyClips([initialClip])
    setSelectedClipId(initialClip.id)
    seekTo(0)
  }

  function undo() {
    if (!history.length) {
      return
    }

    const previous = history[history.length - 1]
    setRedoStack((stack) => [cloneClips(clips), ...stack])
    setHistory((stack) => stack.slice(0, -1))
    setClips(cloneClips(previous))
    setSelectedClipId(previous[0]?.id || '')
  }

  function redo() {
    if (!redoStack.length) {
      return
    }

    const next = redoStack[0]
    setHistory((stack) => [...stack, cloneClips(clips)])
    setRedoStack((stack) => stack.slice(1))
    setClips(cloneClips(next))
    setSelectedClipId(next[0]?.id || '')
  }

  function updateSelectedClip(patch) {
    if (!selectedClip) {
      return
    }

    applyClips((previous) =>
      previous.map((clip) => (clip.id === selectedClip.id ? { ...clip, ...patch } : clip))
    )
  }

  async function exportCut() {
    if (!sourcePath || typeof window.api?.exportRecordingEditorCut !== 'function') {
      setExportStatus('导出 TODO: 缺少主进程导出接口')
      return
    }

    if (!videoClips.length) {
      setExportStatus('没有可导出的视频片段')
      return
    }

    setExportStatus('导出中')
    const result = await window.api.exportRecordingEditorCut({
      path: sourcePath,
      clips: videoClips.map((clip) => ({
        duration: clip.duration,
        sourceStart: clip.sourceStart || 0,
        startTime: clip.startTime
      })),
      output: exportSettings
    })

    if (!result?.ok) {
      setExportStatus(result?.message || '导出失败')
      return
    }

    setExportStatus(`已导出 ${result.item?.name || result.outputPath || ''}`)
  }

  const activeToolMeta = TOOLS.find((tool) => tool.id === activeTool) || TOOLS[0]
  const selectedTrack = TRACKS.find((track) => track.id === selectedClip?.trackId)
  const selectedSupportsAudio = selectedClip?.kind === 'video' || selectedClip?.kind === 'audio'
  const selectedIsOverlay = selectedClip?.kind === 'image' || selectedClip?.kind === 'text'
  const selectedIsText = selectedClip?.kind === 'text'
  const timelineTools = TOOLS.filter((tool) => tool.id !== 'export')
  const capabilityState = [
    { done: true, label: '视频裁剪拼接' },
    { done: true, label: '时间线缩略图' },
    { done: true, label: '逐帧定位' },
    { done: false, label: '音频混音导出' },
    { done: false, label: '贴图/字幕烘焙' }
  ]

  return (
    <Shell>
      <HiddenInput
        ref={audioInputRef}
        type="file"
        accept="audio/*"
        onChange={handleAudioFileSelected}
      />
      <HiddenInput
        ref={imageInputRef}
        type="file"
        accept="image/*"
        onChange={handleImageFileSelected}
      />
      <HiddenInput
        ref={videoInputRef}
        type="file"
        accept="video/*"
        onChange={handleVideoFileSelected}
      />
      <Workspace>
        <PreviewColumn>
          <PreviewHeader>
            <span>{activeToolMeta.label}</span>
            <span>
              {playbackStatus ||
                (selectedClip
                  ? `${selectedTrack?.label || ''} · ${selectedClip.label}`
                  : 'No selection')}
            </span>
          </PreviewHeader>
          <PreviewStage>
            <PreviewFrame>
              <Video
                ref={videoRef}
                src={mediaUrl}
                preload="auto"
                controls={false}
                $visible={isPreviewVideoVisible}
              />
              <PreviewOverlayLayer>
                {visiblePreviewClips
                  .filter((clip) => clip.kind === 'image' && clip.sourceUrl)
                  .map((clip) => (
                    <PreviewImageFrame
                      key={clip.id}
                      $axisScale={clip.previewTransition?.axisScale ?? 1}
                      $opacity={(clip.opacity ?? 1) * (clip.previewTransition?.alpha ?? 1)}
                      $scale={clip.scale || 28}
                      $x={clip.x ?? 50}
                      $y={clip.y ?? 50}
                      onPointerDown={(event) => startOverlayDrag(event, clip)}
                    >
                      <PreviewImage src={clip.sourceUrl} alt="" draggable={false} />
                      {['tl', 'tr', 'br', 'bl'].map((corner) => (
                        <ResizeHandle
                          key={corner}
                          $corner={corner}
                          onPointerDown={(event) => startImageResize(event, clip)}
                        />
                      ))}
                    </PreviewImageFrame>
                  ))}
                {visiblePreviewClips
                  .filter((clip) => clip.kind === 'text')
                  .map((clip) => (
                    <PreviewCaption
                      key={clip.id}
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
                      onPointerDown={(event) => startOverlayDrag(event, clip)}
                    >
                      {clip.label}
                    </PreviewCaption>
                  ))}
              </PreviewOverlayLayer>
            </PreviewFrame>
          </PreviewStage>
        </PreviewColumn>

        <Inspector>
          <Panel>
            <PanelTitle>属性</PanelTitle>
            <FieldGrid>
              <Field>
                开始
                <Input
                  type="number"
                  step="0.01"
                  value={selectedClip ? selectedClip.startTime : 0}
                  disabled={!selectedClip}
                  onChange={(event) =>
                    updateSelectedClip({ startTime: Math.max(0, Number(event.target.value) || 0) })
                  }
                />
              </Field>
              <Field>
                时长
                <Input
                  type="number"
                  step="0.01"
                  value={selectedClip ? selectedClip.duration : 0}
                  disabled={!selectedClip}
                  onChange={(event) =>
                    updateSelectedClip({
                      duration: Math.max(MIN_CLIP_DURATION, Number(event.target.value) || 0)
                    })
                  }
                />
              </Field>
              <Field>
                结束
                <Input
                  type="number"
                  step="0.01"
                  value={selectedClip ? selectedClip.startTime + selectedClip.duration : 0}
                  disabled={!selectedClip}
                  onChange={(event) => {
                    const nextEnd = Math.max(0, Number(event.target.value) || 0)
                    const startTime = selectedClip?.startTime || 0
                    updateSelectedClip({
                      duration: Math.max(MIN_CLIP_DURATION, nextEnd - startTime)
                    })
                  }}
                />
              </Field>
            </FieldGrid>
            {selectedSupportsAudio ? (
              <FieldGrid>
                <Field>
                  音量
                  <Input
                    type="number"
                    min="0"
                    max="2"
                    step="0.01"
                    value={selectedClip ? selectedClip.volume : 1}
                    onChange={(event) =>
                      updateSelectedClip({ volume: clamp(Number(event.target.value) || 0, 0, 2) })
                    }
                  />
                </Field>
                <Field>
                  静音
                  <Input
                    type="checkbox"
                    checked={Boolean(selectedClip?.muted)}
                    onChange={(event) => updateSelectedClip({ muted: event.target.checked })}
                  />
                </Field>
              </FieldGrid>
            ) : null}
            {selectedClip?.kind === 'text' ? (
              <Field>
                字幕内容
                <Input
                  type="text"
                  value={selectedClip.label}
                  onChange={(event) => updateSelectedClip({ label: event.target.value })}
                />
              </Field>
            ) : null}
            {selectedIsOverlay ? (
              <FieldGrid>
                <Field>
                  转场
                  <Select
                    value={selectedClip?.transitionType || DEFAULT_TRANSITION}
                    onChange={(event) => updateSelectedClip({ transitionType: event.target.value })}
                  >
                    <option value="none">none</option>
                    <option value="fade">fade</option>
                    <option value="rotateY">rotateY</option>
                  </Select>
                </Field>
                <Field>
                  转场时长
                  <Input
                    type="number"
                    min="0"
                    max="5"
                    step="0.05"
                    value={selectedClip?.transitionSeconds ?? 0.25}
                    onChange={(event) =>
                      updateSelectedClip({
                        transitionSeconds: clamp(Number(event.target.value) || 0, 0, 5)
                      })
                    }
                  />
                </Field>
              </FieldGrid>
            ) : null}
            {selectedIsText ? (
              <FieldGrid>
                <Field>
                  字色
                  <Input
                    type="color"
                    value={selectedClip?.color || TEXT_DEFAULTS.color}
                    onChange={(event) => updateSelectedClip({ color: event.target.value })}
                  />
                </Field>
                <Field>
                  字号
                  <Input
                    type="number"
                    min="8"
                    max="96"
                    step="1"
                    value={selectedClip?.fontSize || TEXT_DEFAULTS.fontSize}
                    onChange={(event) =>
                      updateSelectedClip({
                        fontSize: clamp(Number(event.target.value) || TEXT_DEFAULTS.fontSize, 8, 96)
                      })
                    }
                  />
                </Field>
                <Field>
                  字重
                  <Select
                    value={String(selectedClip?.fontWeight || TEXT_DEFAULTS.fontWeight)}
                    onChange={(event) => updateSelectedClip({ fontWeight: event.target.value })}
                  >
                    <option value="400">400</option>
                    <option value="500">500</option>
                    <option value="700">700</option>
                    <option value="800">800</option>
                    <option value="900">900</option>
                  </Select>
                </Field>
                <Field>
                  字体
                  <Select
                    value={selectedClip?.fontFamily || TEXT_DEFAULTS.fontFamily}
                    onChange={(event) => updateSelectedClip({ fontFamily: event.target.value })}
                  >
                    <option value="Avenir Next, Helvetica, sans-serif">Avenir Next</option>
                    <option value="PingFang SC, sans-serif">PingFang SC</option>
                    <option value="Georgia, serif">Georgia</option>
                    <option value="SFMono-Regular, Consolas, monospace">Mono</option>
                  </Select>
                </Field>
                <Field>
                  对齐
                  <Select
                    value={selectedClip?.align || TEXT_DEFAULTS.align}
                    onChange={(event) => updateSelectedClip({ align: event.target.value })}
                  >
                    <option value="left">left</option>
                    <option value="center">center</option>
                    <option value="right">right</option>
                  </Select>
                </Field>
                <Field>
                  行高
                  <Input
                    type="number"
                    min="0.8"
                    max="3"
                    step="0.05"
                    value={selectedClip?.lineHeight || TEXT_DEFAULTS.lineHeight}
                    onChange={(event) =>
                      updateSelectedClip({
                        lineHeight: clamp(
                          Number(event.target.value) || TEXT_DEFAULTS.lineHeight,
                          0.8,
                          3
                        )
                      })
                    }
                  />
                </Field>
                <Field>
                  描边
                  <Input
                    type="number"
                    min="0"
                    max="20"
                    step="0.5"
                    value={selectedClip?.strokeWidth ?? TEXT_DEFAULTS.strokeWidth}
                    onChange={(event) =>
                      updateSelectedClip({
                        strokeWidth: clamp(Number(event.target.value) || 0, 0, 20)
                      })
                    }
                  />
                </Field>
                <Field>
                  描边色
                  <Input
                    type="color"
                    value={selectedClip?.strokeColor || TEXT_DEFAULTS.strokeColor}
                    onChange={(event) => updateSelectedClip({ strokeColor: event.target.value })}
                  />
                </Field>
                <Field>
                  阴影色
                  <Input
                    type="color"
                    value={selectedClip?.shadowColor || TEXT_DEFAULTS.shadowColor}
                    onChange={(event) => updateSelectedClip({ shadowColor: event.target.value })}
                  />
                </Field>
                <Field>
                  阴影模糊
                  <Input
                    type="number"
                    min="0"
                    max="40"
                    step="1"
                    value={selectedClip?.shadowBlur ?? TEXT_DEFAULTS.shadowBlur}
                    onChange={(event) =>
                      updateSelectedClip({
                        shadowBlur: clamp(Number(event.target.value) || 0, 0, 40)
                      })
                    }
                  />
                </Field>
                <Field>
                  阴影距离
                  <Input
                    type="number"
                    min="0"
                    max="40"
                    step="1"
                    value={selectedClip?.shadowDistance ?? TEXT_DEFAULTS.shadowDistance}
                    onChange={(event) =>
                      updateSelectedClip({
                        shadowDistance: clamp(Number(event.target.value) || 0, 0, 40)
                      })
                    }
                  />
                </Field>
                <Field>
                  背景色
                  <Input
                    type="color"
                    value={selectedClip?.backgroundColor || TEXT_DEFAULTS.backgroundColor}
                    onChange={(event) =>
                      updateSelectedClip({ backgroundColor: event.target.value })
                    }
                  />
                </Field>
                <Field>
                  背景透明
                  <Input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    value={selectedClip?.backgroundAlpha ?? TEXT_DEFAULTS.backgroundAlpha}
                    onChange={(event) =>
                      updateSelectedClip({
                        backgroundAlpha: clamp(Number(event.target.value) || 0, 0, 1)
                      })
                    }
                  />
                </Field>
              </FieldGrid>
            ) : null}
          </Panel>

          <Panel>
            <PanelTitle>预览</PanelTitle>
            <FieldGrid>
              <Field>
                倍速
                <Select
                  value={String(playbackRate)}
                  onChange={(event) => setPlaybackRate(Number(event.target.value))}
                >
                  {SPEED_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}x
                    </option>
                  ))}
                </Select>
              </Field>
              <Field>
                主音量
                <Input
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={(event) => setVolume(clamp(Number(event.target.value) || 0, 0, 1))}
                />
              </Field>
            </FieldGrid>
            <Range
              type="range"
              min={TIMELINE_ZOOM_MIN}
              max={TIMELINE_ZOOM_MAX}
              step="1"
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
            />
          </Panel>

          <Panel>
            <PanelTitle>导出</PanelTitle>
            <FieldGrid>
              <Field>
                FPS
                <Input
                  type="number"
                  value={exportSettings.fps}
                  onChange={(event) =>
                    setExportSettings((settings) => ({
                      ...settings,
                      fps: Number(event.target.value) || 30
                    }))
                  }
                />
              </Field>
              <Field>
                Mbps
                <Input
                  type="number"
                  value={Math.round(exportSettings.bitrate / 1_000_000)}
                  onChange={(event) =>
                    setExportSettings((settings) => ({
                      ...settings,
                      bitrate: Math.max(1, Number(event.target.value) || 4) * 1_000_000
                    }))
                  }
                />
              </Field>
            </FieldGrid>
            <SubTitle>{exportStatus || `Thumbnails: ${thumbStatus}`}</SubTitle>
            <TodoList>
              {capabilityState.map((item) => (
                <TodoItem key={item.label}>
                  <span>{item.label}</span>
                  <TodoState $done={item.done}>{item.done ? 'ready' : 'todo'}</TodoState>
                </TodoItem>
              ))}
            </TodoList>
          </Panel>
        </Inspector>
      </Workspace>

      <Timeline>
        <TimelineTop>
          <TimelineActions>
            {timelineTools.map((tool) => (
              <ToolAction
                key={tool.id}
                type="button"
                title={tool.label}
                $active={tool.id === activeTool}
                onClick={() => handleToolAction(tool)}
              >
                <ToolIcon toolId={tool.id} />
              </ToolAction>
            ))}
          </TimelineActions>
          <TimelineTransport>
            <IconButton
              type="button"
              title={isPlaying ? '暂停' : '播放'}
              $primary
              onClick={togglePlayback}
            >
              {isPlaying ? 'Ⅱ' : '▶'}
            </IconButton>
            <TimeCode ref={timeCodeRef}>
              {formatEditorTime(0)} / {formatEditorTime(durationRef.current)}
            </TimeCode>
          </TimelineTransport>
          <TimelineEditActions>
            <IconButton type="button" title="Undo" onClick={undo} disabled={!history.length}>
              ↶
            </IconButton>
            <IconButton type="button" title="Redo" onClick={redo} disabled={!redoStack.length}>
              ↷
            </IconButton>
            <IconButton
              type="button"
              title="Duplicate"
              onClick={duplicateSelectedClip}
              disabled={!selectedClip}
            >
              ⧉
            </IconButton>
            <IconButton
              type="button"
              title="Delete"
              onClick={deleteSelectedClip}
              disabled={!selectedClip}
            >
              ⌫
            </IconButton>
            <IconButton type="button" title="Reset" onClick={resetProject}>
              ↺
            </IconButton>
            <IconButton type="button" title="Export" $primary onClick={exportCut}>
              ⇩
            </IconButton>
            <ZoomLabel>{Math.round(zoom)} px/s</ZoomLabel>
          </TimelineEditActions>
        </TimelineTop>

        <RulerViewport>
          <Ruler style={{ width: timelineWidth }}>
            {rulerTicks.map((tick) => (
              <Tick key={`${tick.left}-${tick.label}`} $left={tick.left}>
                {tick.label}
              </Tick>
            ))}
          </Ruler>
        </RulerViewport>

        <TrackViewport>
          <TrackContent style={{ width: timelineWidth + 92 }}>
            <Playhead ref={playheadRef} onPointerDown={startPlayheadDrag} />
            {TRACKS.map((track) => (
              <TrackRow key={track.id}>
                <TrackLabel>{track.label}</TrackLabel>
                <Lane $kind={track.kind} onPointerDown={handleLanePointerDown}>
                  {clips
                    .filter((clip) => clip.trackId === track.id)
                    .map((clip) => {
                      const left = clip.startTime * zoom
                      const width = Math.max(28, clip.duration * zoom)
                      const selected = clip.id === selectedClipId
                      const clipThumbnails = getClipThumbnails(clip, thumbnails)
                      return (
                        <Clip
                          key={clip.id}
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
                                <ClipThumb
                                  key={thumb.time}
                                  src={thumb.dataUrl}
                                  alt=""
                                  draggable={false}
                                />
                              ))}
                            </ClipThumbs>
                          ) : null}
                          {clip.kind === 'image' && clip.sourceUrl ? (
                            <ClipThumbs>
                              <ClipThumb src={clip.sourceUrl} alt="" draggable={false} />
                            </ClipThumbs>
                          ) : null}
                          {clip.kind === 'audio' ? (
                            <Waveform>
                              {getClipWaveform(clip).map((value, index) => (
                                <WaveBar key={`${clip.id}-${index}`} $value={value} />
                              ))}
                            </Waveform>
                          ) : null}
                          <EdgeHandle
                            $side="left"
                            onPointerDown={(event) => startDrag(event, clip, 'trim-left')}
                          />
                          {clip.kind !== 'video' ? (
                            <ClipLabel>
                              <ClipIcon>
                                <ToolIcon toolId={clip.kind} />
                              </ClipIcon>
                              {clip.label}
                            </ClipLabel>
                          ) : null}
                          <EdgeHandle
                            $side="right"
                            onPointerDown={(event) => startDrag(event, clip, 'trim-right')}
                          />
                        </Clip>
                      )
                    })}
                </Lane>
              </TrackRow>
            ))}
          </TrackContent>
        </TrackViewport>
      </Timeline>
    </Shell>
  )
}

RecordingCutEditor.propTypes = {
  displayName: PropTypes.string.isRequired,
  fileUrl: PropTypes.string,
  sourcePath: PropTypes.string.isRequired,
  videoUrl: PropTypes.string.isRequired
}

RecordingCutEditor.defaultProps = {
  fileUrl: ''
}

export default RecordingCutEditor
