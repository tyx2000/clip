import PropTypes from 'prop-types'
import styled from 'styled-components'

const Label = styled.label`
  display: grid;
  gap: 5px;
  color: #a9b2c0;
  font-size: 11px;
`

export function ConfigItem({ children }) {
  return <Label>{children}</Label>
}

ConfigItem.propTypes = {
  children: PropTypes.node.isRequired
}
