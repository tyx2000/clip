import { useEffect, useMemo, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import styled from 'styled-components'
import { formatDuration, middleEllipsis } from '../utils/recordingUtils'

const EDITOR_TOOLS = [
  { id: 'media', label: '媒体', hint: '片段管理' },
  { id: 'text', label: '文本', hint: '字幕标题' },
  { id: 'audio', label: '音频', hint: '节奏卡点' },
  { id: 'sticker', label: '贴纸', hint: '标记提示' },
  { id: 'effect', label: '特效', hint: '气氛强化' },
  { id: 'filter', label: '滤镜', hint: '颜色统一' }
]

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const MIN_SEGMENT_SEC = 0.2

const EditorShell = styled.main`
  height: 100%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) 248px;
  background:
    radial-gradient(circle at top, rgba(46, 78, 142, 0.24), transparent 34%),
    linear-gradient(180deg, #0d1119 0%, #090c12 100%);
  color: #eef2ff;
`

const Header = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 22px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(8, 11, 18, 0.78);
  backdrop-filter: blur(18px);
`

const HeaderGroup = styled.div`
  display: grid;
  gap: 6px;
  min-width: 0;
`

const Eyebrow = styled.span`
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #7dd3fc;
`

const Title = styled.h1`
  margin: 0;
  font-size: 20px;
  line-height: 1.2;
`

const HeaderDesc = styled.p`
  margin: 0;
  color: #94a3b8;
  font-size: 13px;
`

const HeaderActions = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
`

const GhostButton = styled.button`
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.24);
  padding: 10px 14px;
  background: rgba(15, 23, 42, 0.72);
  color: #e2e8f0;
  font-weight: 600;
  cursor: pointer;
`

const PrimaryButton = styled(GhostButton)`
  border-color: rgba(125, 211, 252, 0.5);
  background: linear-gradient(135deg, #0ea5e9 0%, #2563eb 100%);
  color: #f8fafc;
`

const Workspace = styled.section`
  min-height: 0;
  display: grid;
  grid-template-columns: 104px minmax(0, 1fr) 320px;
  gap: 14px;
  padding: 16px 18px 0;

  @media (max-width: 1280px) {
    grid-template-columns: 88px minmax(0, 1fr) 280px;
  }

  @media (max-width: 1080px) {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr) auto;
  }
`

const ToolRail = styled.aside`
  min-height: 0;
  display: grid;
  gap: 10px;
  align-content: start;
`

const ToolButton = styled.button`
  border: 1px solid
    ${({ $active }) => ($active ? 'rgba(125, 211, 252, 0.45)' : 'rgba(30, 41, 59, 0.95)')};
  border-radius: 18px;
  padding: 12px 10px;
  background: ${({ $active }) =>
    $active
      ? 'linear-gradient(180deg, rgba(14, 165, 233, 0.22), rgba(37, 99, 235, 0.1))'
      : 'rgba(13, 18, 29, 0.84)'};
  color: #e2e8f0;
  cursor: pointer;
  display: grid;
  gap: 4px;
  justify-items: center;
  text-align: center;
`

const ToolLabel = styled.span`
  font-size: 13px;
  font-weight: 700;
`

const ToolHint = styled.span`
  font-size: 11px;
  color: #94a3b8;
`

const PreviewStage = styled.section`
  min-height: 0;
  border-radius: 24px;
  border: 1px solid rgba(148, 163, 184, 0.12);
  background:
    linear-gradient(180deg, rgba(8, 11, 18, 0.92), rgba(6, 9, 16, 0.98)),
    radial-gradient(circle at top, rgba(30, 64, 175, 0.12), transparent 48%);
  padding: 16px;
  display: grid;
  grid-template-rows: auto 1fr auto;
  gap: 14px;
`

const StageBar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
`

const StatusPill = styled.span`
  border-radius: 999px;
  padding: 6px 10px;
  background: rgba(15, 23, 42, 0.88);
  border: 1px solid rgba(148, 163, 184, 0.18);
  color: #cbd5e1;
  font-size: 12px;
  font-weight: 600;
`

const Canvas = styled.div`
  min-height: 0;
  display: grid;
  place-items: center;
  padding: 8px;
`

const VideoFrame = styled.div`
  width: min(100%, 960px);
  aspect-ratio: 16 / 9;
  border-radius: 22px;
  overflow: hidden;
  background:
    linear-gradient(180deg, rgba(2, 6, 23, 0.25), rgba(2, 6, 23, 0.7)),
    repeating-linear-gradient(
      135deg,
      rgba(30, 41, 59, 0.9),
      rgba(30, 41, 59, 0.9) 16px,
      rgba(15, 23, 42, 0.9) 16px,
      rgba(15, 23, 42, 0.9) 32px
    );
  border: 1px solid rgba(148, 163, 184, 0.18);
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.36);
`

const Video = styled.video`
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000000;
`

const Transport = styled.div`
  display: grid;
  gap: 10px;
`

const ProgressRow = styled.div`
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 10px;
  align-items: center;
  color: #cbd5e1;
  font-size: 12px;
`

const ControlRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
`

const ControlGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
`

const ActionButton = styled.button`
  border-radius: 12px;
  border: 1px solid
    ${({ $accent }) => ($accent ? 'rgba(125, 211, 252, 0.45)' : 'rgba(148, 163, 184, 0.18)')};
  padding: 9px 12px;
  background: ${({ $accent }) => ($accent ? 'rgba(14, 165, 233, 0.18)' : 'rgba(15, 23, 42, 0.72)')};
  color: #f8fafc;
  font-weight: 600;
  cursor: pointer;

  &:disabled {
    opacity: 0.42;
    cursor: not-allowed;
  }
`

const Range = styled.input`
  width: 100%;
  accent-color: #38bdf8;
`

const SidePanel = styled.aside`
  min-height: 0;
  border-radius: 24px;
  border: 1px solid rgba(148, 163, 184, 0.12);
  background: rgba(8, 11, 18, 0.9);
  padding: 16px;
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr);
  gap: 14px;
`

const PanelCard = styled.section`
  border-radius: 18px;
  border: 1px solid rgba(148, 163, 184, 0.12);
  background: rgba(15, 23, 42, 0.5);
  padding: 14px;
  display: grid;
  gap: 10px;
`

const PanelTitle = styled.h2`
  margin: 0;
  font-size: 14px;
`

const PanelText = styled.p`
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: #94a3b8;
`

const StatGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
`

const StatItem = styled.div`
  border-radius: 14px;
  background: rgba(15, 23, 42, 0.68);
  padding: 10px;
  display: grid;
  gap: 6px;
`

const StatLabel = styled.span`
  color: #94a3b8;
  font-size: 11px;
`

const StatValue = styled.span`
  font-size: 15px;
  font-weight: 700;
`

const PropertyRow = styled.label`
  display: grid;
  gap: 6px;
  font-size: 12px;
  color: #cbd5e1;
`

const Select = styled.select`
  border-radius: 12px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  padding: 9px 10px;
  background: rgba(15, 23, 42, 0.9);
  color: #f8fafc;
`

const SegmentList = styled.div`
  min-height: 0;
  display: grid;
  gap: 8px;
  overflow: auto;
`

const SegmentItem = styled.button`
  width: 100%;
  border: 1px solid
    ${({ $active }) => ($active ? 'rgba(56, 189, 248, 0.55)' : 'rgba(148, 163, 184, 0.14)')};
  border-radius: 14px;
  padding: 10px 12px;
  background: ${({ $active }) => ($active ? 'rgba(14, 165, 233, 0.12)' : 'rgba(15, 23, 42, 0.52)')};
  color: #e2e8f0;
  display: grid;
  gap: 4px;
  text-align: left;
  cursor: pointer;
`

const SegmentLine = styled.span`
  font-size: 12px;
  color: #94a3b8;
`

const TimelineDock = styled.section`
  border-top: 1px solid rgba(148, 163, 184, 0.12);
  background: rgba(5, 8, 14, 0.94);
  padding: 14px 18px 18px;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: 12px;
`

const TimelineHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
`

const TimelineTitle = styled.h2`
  margin: 0;
  font-size: 14px;
`

const TimelineHint = styled.p`
  margin: 0;
  color: #64748b;
  font-size: 12px;
`

const TimelineBar = styled.div`
  position: relative;
  padding-top: 12px;
`

const TimelineTicks = styled.div`
  display: grid;
  grid-template-columns: repeat(${({ $steps }) => $steps}, minmax(0, 1fr));
  gap: 0;
  margin-bottom: 10px;
`

const Tick = styled.span`
  position: relative;
  padding-top: 10px;
  color: #64748b;
  font-size: 10px;

  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    width: 1px;
    height: 8px;
    background: rgba(148, 163, 184, 0.34);
  }
`

const Track = styled.div`
  position: relative;
  border-radius: 18px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  background: linear-gradient(180deg, rgba(15, 23, 42, 0.9), rgba(15, 23, 42, 0.68));
  padding: 18px 14px 16px;
  overflow: hidden;
`

const TrimWindow = styled.div`
  position: absolute;
  top: 8px;
  bottom: 8px;
  left: ${({ $left }) => `${$left}%`};
  width: ${({ $width }) => `${$width}%`};
  border-radius: 14px;
  border: 1px solid rgba(125, 211, 252, 0.55);
  background: rgba(14, 165, 233, 0.08);
  pointer-events: none;
`

const Playhead = styled.div`
  position: absolute;
  top: 0;
  bottom: 0;
  left: ${({ $left }) => `${$left}%`};
  width: 2px;
  background: linear-gradient(180deg, #fef08a 0%, #fb7185 100%);
  box-shadow: 0 0 18px rgba(251, 113, 133, 0.48);
  pointer-events: none;

  &::before {
    content: '';
    position: absolute;
    top: -6px;
    left: 50%;
    transform: translateX(-50%);
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: #fef08a;
  }
`

const TrackLane = styled.div`
  position: relative;
  display: flex;
  gap: 8px;
  min-height: 108px;
`

const ClipBlock = styled.button`
  flex: ${({ $flex }) => $flex};
  min-width: 78px;
  border-radius: 16px;
  border: 1px solid
    ${({ $active }) => ($active ? 'rgba(56, 189, 248, 0.55)' : 'rgba(30, 41, 59, 0.92)')};
  background:
    linear-gradient(180deg, rgba(30, 64, 175, 0.26), rgba(14, 116, 144, 0.16)),
    linear-gradient(90deg, rgba(12, 18, 28, 0.96), rgba(20, 27, 43, 0.96));
  color: #f8fafc;
  padding: 12px;
  display: grid;
  gap: 8px;
  text-align: left;
  cursor: pointer;
`

const BlockTitle = styled.span`
  font-size: 12px;
  font-weight: 700;
`

const BlockMeta = styled.span`
  font-size: 11px;
  color: #cbd5e1;
`

const TrimSliderRow = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;

  @media (max-width: 960px) {
    grid-template-columns: 1fr;
  }
`

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function formatTimelineTime(seconds) {
  return formatDuration(seconds)
}

function createInitialSegments(duration) {
  return [{ id: `segment-1`, start: 0, end: duration }]
}

function RecordingCutEditor({ videoUrl, displayName }) {
  const videoRef = useRef(null)
  const [activeTool, setActiveTool] = useState('media')
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)
  const [segments, setSegments] = useState([])
  const [playbackRate, setPlaybackRate] = useState(1)
  const [volume, setVolume] = useState(1)
  const [isPlaying, setIsPlaying] = useState(false)

  useEffect(() => {
    document.title = `视频剪辑 - ${displayName}`
  }, [displayName])

  useEffect(() => {
    const video = videoRef.current
    if (!video) {
      return undefined
    }

    const syncPlayingState = () => setIsPlaying(!video.paused)
    const handleLoadedMetadata = () => {
      const nextDuration = Number.isFinite(video.duration) ? video.duration : 0
      if (nextDuration <= 0) {
        return
      }

      setDuration(nextDuration)
      setTrimStart(0)
      setTrimEnd(nextDuration)
      setCurrentTime(0)
      setSegments(createInitialSegments(nextDuration))
    }

    const handleTimeUpdate = () => {
      const nextTime = Number.isFinite(video.currentTime) ? video.currentTime : 0
      if (trimEnd > 0 && nextTime >= trimEnd) {
        video.currentTime = trimEnd
        video.pause()
        setCurrentTime(trimEnd)
        setIsPlaying(false)
        return
      }

      setCurrentTime(nextTime)
    }

    video.addEventListener('loadedmetadata', handleLoadedMetadata)
    video.addEventListener('timeupdate', handleTimeUpdate)
    video.addEventListener('play', syncPlayingState)
    video.addEventListener('pause', syncPlayingState)
    video.addEventListener('ended', syncPlayingState)

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      video.removeEventListener('timeupdate', handleTimeUpdate)
      video.removeEventListener('play', syncPlayingState)
      video.removeEventListener('pause', syncPlayingState)
      video.removeEventListener('ended', syncPlayingState)
    }
  }, [trimEnd])

  useEffect(() => {
    const video = videoRef.current
    if (!video) {
      return
    }

    video.playbackRate = playbackRate
  }, [playbackRate])

  useEffect(() => {
    const video = videoRef.current
    if (!video) {
      return
    }

    video.volume = volume
  }, [volume])

  const totalDuration = duration || 0
  const safeTrimEnd = trimEnd > 0 ? trimEnd : totalDuration
  const trimmedDuration = Math.max(0, safeTrimEnd - trimStart)
  const playheadPercent = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0
  const trimLeftPercent = totalDuration > 0 ? (trimStart / totalDuration) * 100 : 0
  const trimWidthPercent =
    totalDuration > 0 ? (Math.max(safeTrimEnd - trimStart, 0) / totalDuration) * 100 : 100

  const selectedSegment = useMemo(() => {
    return (
      segments.find(
        (segment) => currentTime >= segment.start - 0.001 && currentTime <= segment.end + 0.001
      ) ||
      segments[0] ||
      null
    )
  }, [currentTime, segments])

  const timelineTicks = useMemo(() => {
    const steps = totalDuration > 0 ? Math.min(8, Math.max(4, Math.ceil(totalDuration / 15))) : 6
    return Array.from({ length: steps }, (_, index) => {
      const ratio = steps === 1 ? 0 : index / (steps - 1)
      return formatTimelineTime(totalDuration * ratio)
    })
  }, [totalDuration])

  const togglePlayback = async () => {
    const video = videoRef.current
    if (!video) {
      return
    }

    if (video.currentTime < trimStart || video.currentTime > safeTrimEnd) {
      video.currentTime = trimStart
      setCurrentTime(trimStart)
    }

    if (video.paused) {
      await video.play().catch(() => {})
      return
    }

    video.pause()
  }

  const seekTo = (nextTime) => {
    const video = videoRef.current
    const clamped = clamp(nextTime, 0, totalDuration || 0)
    setCurrentTime(clamped)
    if (video) {
      video.currentTime = clamped
    }
  }

  const handleTrimStartChange = (nextStart) => {
    const clampedStart = clamp(nextStart, 0, Math.max(safeTrimEnd - MIN_SEGMENT_SEC, 0))
    setTrimStart(clampedStart)
    if (currentTime < clampedStart) {
      seekTo(clampedStart)
    }
  }

  const handleTrimEndChange = (nextEnd) => {
    const clampedEnd = clamp(nextEnd, trimStart + MIN_SEGMENT_SEC, totalDuration || nextEnd)
    setTrimEnd(clampedEnd)
    if (currentTime > clampedEnd) {
      seekTo(clampedEnd)
    }
  }

  const handleSetTrimAtPlayhead = (kind) => {
    if (totalDuration <= 0) {
      return
    }

    if (kind === 'start') {
      handleTrimStartChange(currentTime)
      return
    }

    handleTrimEndChange(currentTime)
  }

  const handleResetTrim = () => {
    setTrimStart(0)
    setTrimEnd(totalDuration)
    setSegments(createInitialSegments(totalDuration))
    seekTo(0)
  }

  const handleSplit = () => {
    if (!selectedSegment || totalDuration <= 0) {
      return
    }

    const splitPoint = clamp(currentTime, trimStart, safeTrimEnd)
    if (
      splitPoint <= selectedSegment.start + MIN_SEGMENT_SEC ||
      splitPoint >= selectedSegment.end - MIN_SEGMENT_SEC
    ) {
      return
    }

    setSegments((previous) =>
      previous.flatMap((segment) => {
        if (segment.id !== selectedSegment.id) {
          return segment
        }

        return [
          { id: `${segment.id}-a`, start: segment.start, end: splitPoint },
          { id: `${segment.id}-b`, start: splitPoint, end: segment.end }
        ]
      })
    )
  }

  const jumpToSegment = (segment) => {
    if (!segment) {
      return
    }

    const nextTime = clamp(segment.start, trimStart, safeTrimEnd)
    seekTo(nextTime)
  }

  const activeToolMeta = EDITOR_TOOLS.find((tool) => tool.id === activeTool) || EDITOR_TOOLS[0]

  return (
    <EditorShell>
      <Header>
        <HeaderGroup>
          <Eyebrow>Cut Studio</Eyebrow>
          <Title title={displayName}>{middleEllipsis(displayName, 72)}</Title>
          <HeaderDesc>
            参考剪映的三栏式工作台，已带入录屏素材，可直接做裁剪、分割和时间线预演。
          </HeaderDesc>
        </HeaderGroup>

        <HeaderActions>
          <GhostButton type="button" onClick={() => window.close()}>
            关闭窗口
          </GhostButton>
          <PrimaryButton type="button" onClick={handleResetTrim}>
            重置草稿
          </PrimaryButton>
        </HeaderActions>
      </Header>

      <Workspace>
        <ToolRail>
          {EDITOR_TOOLS.map((tool) => (
            <ToolButton
              key={tool.id}
              type="button"
              $active={tool.id === activeTool}
              onClick={() => setActiveTool(tool.id)}
            >
              <ToolLabel>{tool.label}</ToolLabel>
              <ToolHint>{tool.hint}</ToolHint>
            </ToolButton>
          ))}
        </ToolRail>

        <PreviewStage>
          <StageBar>
            <StatusPill>当前模块: {activeToolMeta.label}</StatusPill>
            <StatusPill>
              有效片段 {segments.length} 段 · 裁剪长度 {formatTimelineTime(trimmedDuration)}
            </StatusPill>
          </StageBar>

          <Canvas>
            <VideoFrame>
              <Video ref={videoRef} src={videoUrl} preload="metadata" controls={false} />
            </VideoFrame>
          </Canvas>

          <Transport>
            <ProgressRow>
              <span>{formatTimelineTime(currentTime)}</span>
              <Range
                type="range"
                min="0"
                max={Math.max(totalDuration, 0)}
                step="0.01"
                value={currentTime}
                onChange={(event) => seekTo(Number(event.target.value))}
              />
              <span>{formatTimelineTime(totalDuration)}</span>
            </ProgressRow>

            <ControlRow>
              <ControlGroup>
                <ActionButton
                  type="button"
                  $accent
                  onClick={togglePlayback}
                  disabled={!totalDuration}
                >
                  {isPlaying ? '暂停' : '播放'}
                </ActionButton>
                <ActionButton type="button" onClick={() => handleSetTrimAtPlayhead('start')}>
                  设为入点
                </ActionButton>
                <ActionButton type="button" onClick={() => handleSetTrimAtPlayhead('end')}>
                  设为出点
                </ActionButton>
                <ActionButton type="button" onClick={handleSplit}>
                  在播放头分割
                </ActionButton>
              </ControlGroup>

              <ControlGroup>
                <StatusPill>
                  In {formatTimelineTime(trimStart)} / Out {formatTimelineTime(safeTrimEnd)}
                </StatusPill>
              </ControlGroup>
            </ControlRow>
          </Transport>
        </PreviewStage>

        <SidePanel>
          <PanelCard>
            <PanelTitle>属性检查器</PanelTitle>
            <PanelText>
              当前工作区聚焦 {activeToolMeta.label}。先完成粗剪，再往文本、特效和滤镜阶段推进。
            </PanelText>
          </PanelCard>

          <PanelCard>
            <PanelTitle>素材统计</PanelTitle>
            <StatGrid>
              <StatItem>
                <StatLabel>总时长</StatLabel>
                <StatValue>{formatTimelineTime(totalDuration)}</StatValue>
              </StatItem>
              <StatItem>
                <StatLabel>有效时长</StatLabel>
                <StatValue>{formatTimelineTime(trimmedDuration)}</StatValue>
              </StatItem>
              <StatItem>
                <StatLabel>分割片段</StatLabel>
                <StatValue>{segments.length}</StatValue>
              </StatItem>
              <StatItem>
                <StatLabel>当前播放头</StatLabel>
                <StatValue>{formatTimelineTime(currentTime)}</StatValue>
              </StatItem>
            </StatGrid>
          </PanelCard>

          <PanelCard>
            <PanelTitle>预览参数</PanelTitle>
            <PropertyRow>
              预览倍速
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
            </PropertyRow>

            <PropertyRow>
              音量
              <Range
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
            </PropertyRow>
          </PanelCard>

          <PanelCard>
            <PanelTitle>片段清单</PanelTitle>
            <SegmentList>
              {segments.map((segment, index) => {
                const isActive = selectedSegment?.id === segment.id
                return (
                  <SegmentItem
                    key={segment.id}
                    type="button"
                    $active={isActive}
                    onClick={() => jumpToSegment(segment)}
                  >
                    <strong>片段 {index + 1}</strong>
                    <SegmentLine>
                      {formatTimelineTime(segment.start)} - {formatTimelineTime(segment.end)}
                    </SegmentLine>
                    <SegmentLine>
                      长度 {formatTimelineTime(Math.max(segment.end - segment.start, 0))}
                    </SegmentLine>
                  </SegmentItem>
                )
              })}
            </SegmentList>
          </PanelCard>
        </SidePanel>
      </Workspace>

      <TimelineDock>
        <TimelineHeader>
          <div>
            <TimelineTitle>时间线</TimelineTitle>
            <TimelineHint>底部时间线用于粗剪。先定入出点，再在播放头位置做片段分割。</TimelineHint>
          </div>
          <ControlGroup>
            <ActionButton type="button" onClick={() => seekTo(trimStart)}>
              跳到入点
            </ActionButton>
            <ActionButton type="button" onClick={() => seekTo(safeTrimEnd)}>
              跳到出点
            </ActionButton>
          </ControlGroup>
        </TimelineHeader>

        <TrimSliderRow>
          <PropertyRow>
            入点 {formatTimelineTime(trimStart)}
            <Range
              type="range"
              min="0"
              max={Math.max(totalDuration, 0)}
              step="0.01"
              value={trimStart}
              onChange={(event) => handleTrimStartChange(Number(event.target.value))}
            />
          </PropertyRow>

          <PropertyRow>
            出点 {formatTimelineTime(safeTrimEnd)}
            <Range
              type="range"
              min="0"
              max={Math.max(totalDuration, 0)}
              step="0.01"
              value={safeTrimEnd}
              onChange={(event) => handleTrimEndChange(Number(event.target.value))}
            />
          </PropertyRow>
        </TrimSliderRow>

        <TimelineBar>
          <TimelineTicks $steps={timelineTicks.length}>
            {timelineTicks.map((tick) => (
              <Tick key={tick}>{tick}</Tick>
            ))}
          </TimelineTicks>

          <Track>
            <TrimWindow $left={trimLeftPercent} $width={trimWidthPercent} />
            <Playhead $left={playheadPercent} />
            <TrackLane>
              {segments.map((segment, index) => {
                const segmentDuration = Math.max(segment.end - segment.start, MIN_SEGMENT_SEC)
                const isActive = selectedSegment?.id === segment.id
                return (
                  <ClipBlock
                    key={segment.id}
                    type="button"
                    $active={isActive}
                    $flex={segmentDuration}
                    onClick={() => jumpToSegment(segment)}
                  >
                    <BlockTitle>视频 {index + 1}</BlockTitle>
                    <BlockMeta>
                      {formatTimelineTime(segment.start)} - {formatTimelineTime(segment.end)}
                    </BlockMeta>
                    <BlockMeta>
                      时长 {formatTimelineTime(Math.max(segment.end - segment.start, 0))}
                    </BlockMeta>
                  </ClipBlock>
                )
              })}
            </TrackLane>
          </Track>
        </TimelineBar>
      </TimelineDock>
    </EditorShell>
  )
}

RecordingCutEditor.propTypes = {
  videoUrl: PropTypes.string.isRequired,
  displayName: PropTypes.string.isRequired
}

export default RecordingCutEditor
