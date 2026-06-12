import { useState } from 'react'
import PropTypes from 'prop-types'
import styled from 'styled-components'

import {
  DEFAULT_TRANSITION,
  DEFAULT_VIDEO_TRANSITION_SECONDS,
  MIN_CLIP_DURATION,
  TEXT_ALIGN_OPTIONS,
  TEXT_DEFAULTS,
  TEXT_FONT_OPTIONS,
  TEXT_WEIGHT_OPTIONS,
  TRANSITION_OPTIONS,
  VIDEO_TRANSITION_OPTIONS
} from './constants'
import { ConfigItem as Field } from './ConfigItem'
import { clamp } from './timelineModel'

const Inspector = styled.aside`
  max-height: calc(100vh - var(--timeline-height) - 31px);
  display: grid;
  align-content: start;
  grid-auto-rows: max-content;
  gap: 10px;
  padding: 12px;
  border: 1px solid #252b34;
  border-radius: 10px;
  background: rgba(21, 25, 31, 0.96);
  box-shadow: 0 18px 58px rgba(0, 0, 0, 0.42);
  overflow-y: auto;
  overscroll-behavior: contain;
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

const Panel = styled.section`
  min-height: 0;
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
  grid-template-columns: minmax(0, 1fr);
  gap: 7px;
`

const Input = styled.input`
  width: 100%;
  height: 30px;
  border: 1px solid #303743;
  border-radius: 7px;
  padding: 0 8px;
  background: #11161d;
  color: #f5f7fb;

  &[type='number'] {
    appearance: textfield;
    -moz-appearance: textfield;
  }

  &[type='number']::-webkit-inner-spin-button,
  &[type='number']::-webkit-outer-spin-button {
    margin: 0;
    -webkit-appearance: none;
  }

  &[type='checkbox'] {
    width: 16px;
    height: 16px;
    justify-self: end;
    padding: 0;
    accent-color: #2f7df6;
  }
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

function formatTimeInput(value) {
  const numericValue = Number(value)
  return (Number.isFinite(numericValue) ? Math.max(0, numericValue) : 0).toFixed(3)
}

function parseTimeInput(value, fallback = 0) {
  const numericValue = Number(value)
  return Number.isFinite(numericValue) ? Math.max(0, numericValue) : fallback
}

export function InspectorPanel({
  className,
  onSelectedClipChange,
  onSelectedClipCommit,
  selectedClip
}) {
  const selectedSupportsAudio = selectedClip?.kind === 'video' || selectedClip?.kind === 'audio'
  const selectedIsVideo = selectedClip?.kind === 'video'
  const selectedIsOverlay = selectedClip?.kind === 'image' || selectedClip?.kind === 'text'
  const selectedIsText = selectedClip?.kind === 'text'
  const [timeInputVersion, setTimeInputVersion] = useState(0)
  const timeInputKey = `${selectedClip?.id || 'empty'}:${timeInputVersion}`
  const startTime = selectedClip?.startTime || 0
  const clipDuration = selectedClip?.duration || 0

  const updateTimeField = (field, value) => {
    if (!selectedClip) {
      return
    }

    if (field === 'start') {
      onSelectedClipChange({
        startTime: parseTimeInput(value, selectedClip.startTime || 0)
      })
      return
    }

    if (field === 'duration') {
      onSelectedClipChange({
        duration: Math.max(MIN_CLIP_DURATION, parseTimeInput(value, selectedClip.duration || 0))
      })
      return
    }

    const nextEnd = parseTimeInput(value, selectedClip.startTime + selectedClip.duration)
    onSelectedClipChange({
      duration: Math.max(MIN_CLIP_DURATION, nextEnd - selectedClip.startTime)
    })
  }

  const commitTimeField = (field, value) => {
    if (!selectedClip) {
      return
    }

    setTimeInputVersion((version) => version + 1)
    if (field === 'start') {
      onSelectedClipCommit({
        startTime: parseTimeInput(value, selectedClip.startTime || 0)
      })
      return
    }

    if (field === 'duration') {
      onSelectedClipCommit({
        duration: Math.max(
          MIN_CLIP_DURATION,
          parseTimeInput(value, selectedClip.duration || MIN_CLIP_DURATION)
        )
      })
      return
    }

    const nextEnd = parseTimeInput(value, selectedClip.startTime + selectedClip.duration)
    onSelectedClipCommit({
      duration: Math.max(MIN_CLIP_DURATION, nextEnd - selectedClip.startTime)
    })
  }
  const updateVideoTransitionType = (direction, type) => {
    const secondsKey = direction === 'in' ? 'videoInTransitionSeconds' : 'videoOutTransitionSeconds'
    const typeKey = direction === 'in' ? 'videoInTransitionType' : 'videoOutTransitionType'
    const currentSeconds = Number(selectedClip?.[secondsKey]) || 0

    onSelectedClipChange({
      [secondsKey]:
        type === 'none' ? currentSeconds : currentSeconds || DEFAULT_VIDEO_TRANSITION_SECONDS,
      [typeKey]: type
    })
  }

  return (
    <Inspector className={className}>
      <Panel>
        <PanelTitle>属性</PanelTitle>
        <FieldGrid>
          <Field>
            开始
            <Input
              key={`start-${timeInputKey}`}
              type="number"
              step="0.001"
              defaultValue={formatTimeInput(startTime)}
              disabled={!selectedClip}
              onBlur={(event) => commitTimeField('start', event.currentTarget.value)}
              onChange={(event) => updateTimeField('start', event.target.value)}
            />
          </Field>
          <Field>
            时长
            <Input
              key={`duration-${timeInputKey}`}
              type="number"
              step="0.001"
              defaultValue={formatTimeInput(clipDuration)}
              disabled={!selectedClip}
              onBlur={(event) => commitTimeField('duration', event.currentTarget.value)}
              onChange={(event) => updateTimeField('duration', event.target.value)}
            />
          </Field>
          <Field>
            结束
            <Input
              key={`end-${timeInputKey}`}
              type="number"
              step="0.001"
              defaultValue={formatTimeInput(startTime + clipDuration)}
              disabled={!selectedClip}
              onBlur={(event) => commitTimeField('end', event.currentTarget.value)}
              onChange={(event) => updateTimeField('end', event.target.value)}
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
                  onSelectedClipChange({ volume: clamp(Number(event.target.value) || 0, 0, 2) })
                }
              />
            </Field>
            <Field>
              静音
              <Input
                type="checkbox"
                checked={Boolean(selectedClip?.muted)}
                onChange={(event) => onSelectedClipChange({ muted: event.target.checked })}
              />
            </Field>
          </FieldGrid>
        ) : null}
        {selectedIsVideo ? (
          <FieldGrid>
            <Field>
              进场
              <Select
                value={selectedClip?.videoInTransitionType || 'none'}
                onChange={(event) => updateVideoTransitionType('in', event.target.value)}
              >
                {VIDEO_TRANSITION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              进场时长
              <Input
                type="number"
                min="0"
                max="5"
                step="0.05"
                value={selectedClip?.videoInTransitionSeconds ?? DEFAULT_VIDEO_TRANSITION_SECONDS}
                onChange={(event) =>
                  onSelectedClipChange({
                    videoInTransitionSeconds: clamp(Number(event.target.value) || 0, 0, 5)
                  })
                }
              />
            </Field>
            <Field>
              退场
              <Select
                value={selectedClip?.videoOutTransitionType || 'none'}
                onChange={(event) => updateVideoTransitionType('out', event.target.value)}
              >
                {VIDEO_TRANSITION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              退场时长
              <Input
                type="number"
                min="0"
                max="5"
                step="0.05"
                value={selectedClip?.videoOutTransitionSeconds ?? DEFAULT_VIDEO_TRANSITION_SECONDS}
                onChange={(event) =>
                  onSelectedClipChange({
                    videoOutTransitionSeconds: clamp(Number(event.target.value) || 0, 0, 5)
                  })
                }
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
              onChange={(event) => onSelectedClipChange({ label: event.target.value })}
            />
          </Field>
        ) : null}
        {selectedIsOverlay ? (
          <FieldGrid>
            <Field>
              转场
              <Select
                value={selectedClip?.transitionType || DEFAULT_TRANSITION}
                onChange={(event) => onSelectedClipChange({ transitionType: event.target.value })}
              >
                {TRANSITION_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
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
                  onSelectedClipChange({
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
                onChange={(event) => onSelectedClipChange({ color: event.target.value })}
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
                  onSelectedClipChange({
                    fontSize: clamp(Number(event.target.value) || TEXT_DEFAULTS.fontSize, 8, 96)
                  })
                }
              />
            </Field>
            <Field>
              字重
              <Select
                value={String(selectedClip?.fontWeight || TEXT_DEFAULTS.fontWeight)}
                onChange={(event) => onSelectedClipChange({ fontWeight: event.target.value })}
              >
                {TEXT_WEIGHT_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              字体
              <Select
                value={selectedClip?.fontFamily || TEXT_DEFAULTS.fontFamily}
                onChange={(event) => onSelectedClipChange({ fontFamily: event.target.value })}
              >
                {TEXT_FONT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              对齐
              <Select
                value={selectedClip?.align || TEXT_DEFAULTS.align}
                onChange={(event) => onSelectedClipChange({ align: event.target.value })}
              >
                {TEXT_ALIGN_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
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
                  onSelectedClipChange({
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
                  onSelectedClipChange({
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
                onChange={(event) => onSelectedClipChange({ strokeColor: event.target.value })}
              />
            </Field>
            <Field>
              阴影色
              <Input
                type="color"
                value={selectedClip?.shadowColor || TEXT_DEFAULTS.shadowColor}
                onChange={(event) => onSelectedClipChange({ shadowColor: event.target.value })}
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
                  onSelectedClipChange({
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
                  onSelectedClipChange({
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
                onChange={(event) => onSelectedClipChange({ backgroundColor: event.target.value })}
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
                  onSelectedClipChange({
                    backgroundAlpha: clamp(Number(event.target.value) || 0, 0, 1)
                  })
                }
              />
            </Field>
          </FieldGrid>
        ) : null}
      </Panel>
    </Inspector>
  )
}

InspectorPanel.propTypes = {
  className: PropTypes.string,
  onSelectedClipCommit: PropTypes.func.isRequired,
  onSelectedClipChange: PropTypes.func.isRequired,
  selectedClip: PropTypes.object
}

InspectorPanel.defaultProps = {
  className: ''
}
