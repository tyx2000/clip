import PropTypes from 'prop-types'
import styled from 'styled-components'

const Label = styled.label`
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: #a9b2c0;
  font-size: 11px;
  line-height: 1.2;
`

export function ConfigItem({ children }) {
  return <Label>{children}</Label>
}

ConfigItem.propTypes = {
  children: PropTypes.node.isRequired
}
