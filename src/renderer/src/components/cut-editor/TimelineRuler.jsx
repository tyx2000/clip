import PropTypes from 'prop-types'
import styled from 'styled-components'

import { TRACK_GUTTER_WIDTH } from './constants'

const RulerViewport = styled.div`
  min-width: 0;
  overflow: hidden;
  border-bottom: 1px solid #252b34;
`

const Ruler = styled.div`
  position: relative;
  height: 100%;
  margin-left: ${TRACK_GUTTER_WIDTH}px;
  cursor: pointer;
  transition: width 160ms ease;
`

const Tick = styled.span`
  position: absolute;
  left: ${({ $left }) => `${$left}px`};
  top: 0;
  height: 100%;
  border-left: 1px solid #303743;
  padding-left: 4px;
  color: #7d8796;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  font-size: 10px;
  line-height: 22px;
  white-space: nowrap;
  transition: left 160ms ease;

  &::after {
    content: '';
    position: absolute;
    left: -1px;
    bottom: 0;
    height: 6px;
    border-left: 1px solid #606b7c;
  }
`

export function TimelineRuler({ rulerTicks, rulerViewportRef, startRulerScrub, timelineWidth }) {
  return (
    <RulerViewport ref={rulerViewportRef}>
      <Ruler style={{ width: timelineWidth }} onPointerDown={startRulerScrub}>
        {rulerTicks.map((tick) => (
          <Tick key={`${tick.left}-${tick.label}`} $left={tick.left}>
            {tick.label}
          </Tick>
        ))}
      </Ruler>
    </RulerViewport>
  )
}

TimelineRuler.propTypes = {
  rulerTicks: PropTypes.arrayOf(PropTypes.object).isRequired,
  rulerViewportRef: PropTypes.shape({ current: PropTypes.object }).isRequired,
  startRulerScrub: PropTypes.func.isRequired,
  timelineWidth: PropTypes.number.isRequired
}
