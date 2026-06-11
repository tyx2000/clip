import { DEFAULT_TRANSITION, MIN_CLIP_DURATION, TEXT_DEFAULTS } from './constants'
import { clamp, createId, getAvailableTrackId, getKindEnd, roundTime } from './timelineModel'

export function createToolClip({ clips, duration, kind, time }) {
  const clipDuration = kind === 'video' ? Math.min(4, Math.max(1, duration - time)) : 3
  const startTime = roundTime(time)
  const safeDuration = Math.max(MIN_CLIP_DURATION, clipDuration)

  return {
    duration: safeDuration,
    id: createId(kind),
    kind,
    label:
      kind === 'text' ? '字幕' : kind === 'image' ? '贴图' : kind === 'audio' ? '音频' : '视频',
    muted: false,
    opacity: 1,
    scale: kind === 'image' ? 28 : 1,
    sourceStart: kind === 'video' ? clamp(time, 0, duration) : 0,
    startTime,
    trackId: getAvailableTrackId(clips, kind, startTime, safeDuration),
    transitionSeconds: 0.25,
    transitionType: DEFAULT_TRANSITION,
    volume: 1,
    x: 50,
    y: kind === 'text' ? 84 : 50,
    ...(kind === 'text' ? TEXT_DEFAULTS : {})
  }
}

export function createAudioClip({
  clips,
  duration,
  fileName,
  sourcePath,
  sourceUrl,
  time,
  waveform
}) {
  const safeDuration = Math.max(MIN_CLIP_DURATION, Number(duration) || 3)
  const startTime = roundTime(time)

  return {
    duration: safeDuration,
    id: createId('audio'),
    kind: 'audio',
    label: fileName || '音频',
    muted: false,
    sourceStart: 0,
    sourceDuration: safeDuration,
    sourcePath,
    sourceUrl,
    startTime,
    trackId: getAvailableTrackId(clips, 'audio', startTime, safeDuration),
    volume: 1,
    waveform
  }
}

export function createImageClip({ clips, fileName, sourcePath, sourceUrl, time }) {
  const startTime = roundTime(time)

  return {
    duration: 3,
    id: createId('image'),
    kind: 'image',
    label: fileName || '贴图',
    muted: false,
    opacity: 1,
    scale: 28,
    sourceStart: 0,
    sourcePath,
    sourceUrl,
    startTime,
    trackId: getAvailableTrackId(clips, 'image', startTime, 3),
    transitionSeconds: 0.25,
    transitionType: DEFAULT_TRANSITION,
    volume: 1,
    x: 50,
    y: 50
  }
}

export function createImportedVideoClip({
  clips,
  duration,
  fileName,
  sourcePath,
  sourceUrl,
  thumbnails
}) {
  const safeDuration = Math.max(MIN_CLIP_DURATION, Number(duration) || 3)
  const startTime = roundTime(getKindEnd(clips, 'video'))

  return {
    duration: safeDuration,
    id: createId('video'),
    kind: 'video',
    label: fileName || '导入视频',
    muted: false,
    sourceDuration: safeDuration,
    sourceStart: 0,
    sourcePath,
    sourceUrl,
    startTime,
    thumbnails,
    trackId: getAvailableTrackId(clips, 'video', startTime, safeDuration),
    volume: 1
  }
}

export function splitClipAtTime(clip, splitTime) {
  const clipStart = clip.startTime
  const clipEnd = clip.startTime + clip.duration
  if (splitTime <= clipStart + MIN_CLIP_DURATION || splitTime >= clipEnd - MIN_CLIP_DURATION) {
    return null
  }

  const leftDuration = splitTime - clipStart
  const rightDuration = clipEnd - splitTime
  const rightClip = {
    ...clip,
    duration: roundTime(rightDuration),
    id: createId(clip.kind),
    sourceStart:
      clip.kind === 'video' || clip.kind === 'audio'
        ? roundTime((clip.sourceStart || 0) + leftDuration)
        : clip.sourceStart,
    startTime: roundTime(splitTime)
  }

  return {
    leftClip: { ...clip, duration: roundTime(leftDuration) },
    rightClip
  }
}

export function duplicateClip(clip) {
  return {
    ...clip,
    id: createId(clip.kind),
    label: `${clip.label} copy`,
    startTime: roundTime(clip.startTime + clip.duration + 0.2)
  }
}
