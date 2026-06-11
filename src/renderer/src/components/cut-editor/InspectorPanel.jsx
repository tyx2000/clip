import PropTypes from 'prop-types'
import styled from 'styled-components'

import {
  DEFAULT_TRANSITION,
  MIN_CLIP_DURATION,
  TEXT_ALIGN_OPTIONS,
  TEXT_DEFAULTS,
  TEXT_FONT_OPTIONS,
  TEXT_WEIGHT_OPTIONS,
  TRANSITION_OPTIONS
} from './constants'
import { ConfigItem as Field } from './ConfigItem'
import { clamp } from './timelineModel'

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

export function InspectorPanel({ onSelectedClipChange, selectedClip }) {
  const selectedSupportsAudio = selectedClip?.kind === 'video' || selectedClip?.kind === 'audio'
  const selectedIsOverlay = selectedClip?.kind === 'image' || selectedClip?.kind === 'text'
  const selectedIsText = selectedClip?.kind === 'text'

  return (
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
                onSelectedClipChange({ startTime: Math.max(0, Number(event.target.value) || 0) })
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
                onSelectedClipChange({
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
                onSelectedClipChange({
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
  onSelectedClipChange: PropTypes.func.isRequired,
  selectedClip: PropTypes.object
}
