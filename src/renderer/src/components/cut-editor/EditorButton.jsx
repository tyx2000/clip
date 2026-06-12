import PropTypes from 'prop-types'
import styled from 'styled-components'

import { EditorIcon } from './icons'

const Button = styled.button`
  width: ${({ $wide }) => ($wide ? '46px' : '24px')};
  height: 24px;
  min-width: ${({ $wide }) => ($wide ? '46px' : '24px')};
  border: 1px solid ${({ $active }) => ($active ? '#5aa7ff' : '#303743')};
  border-radius: 6px;
  padding: 0;
  background: ${({ $active, $primary }) =>
    $primary ? '#2f7df6' : $active ? '#1f3557' : '#20252d'};
  color: #f5f7fb;
  font-size: ${({ $wide }) => ($wide ? '11px' : '12px')};
  font-weight: 700;
  line-height: 1;
  cursor: pointer;

  svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
`

export function EditorButton({
  active,
  children,
  disabled,
  icon,
  onClick,
  primary,
  title,
  type,
  wide
}) {
  return (
    <Button
      type={type}
      aria-label={title}
      title={title}
      $active={active}
      $primary={primary}
      $wide={wide}
      disabled={disabled}
      onClick={onClick}
    >
      {children || <EditorIcon id={icon} title={title} />}
    </Button>
  )
}

EditorButton.propTypes = {
  active: PropTypes.bool,
  children: PropTypes.node,
  disabled: PropTypes.bool,
  icon: PropTypes.string.isRequired,
  onClick: PropTypes.func.isRequired,
  primary: PropTypes.bool,
  title: PropTypes.string.isRequired,
  type: PropTypes.string,
  wide: PropTypes.bool
}

EditorButton.defaultProps = {
  active: false,
  children: null,
  disabled: false,
  primary: false,
  type: 'button',
  wide: false
}
