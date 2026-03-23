import { useState } from 'react'
import styled from 'styled-components'

const VersionsList = styled.ul`
  position: static;
  transform: none;
  left: auto;
  bottom: auto;
  border-radius: 10px;
  background: var(--color-block-chip);
  color: var(--color-text);
  border: 1px solid var(--line-soft);
  display: inline-flex;
`

const VersionItem = styled.li`
  padding: 7px 10px;

  &:not(:last-child) {
    border-right: 1px solid var(--line-soft);
  }
`

function Versions() {
  const [versions] = useState(window.electron.process.versions)

  return (
    <VersionsList>
      <VersionItem>Electron v{versions.electron}</VersionItem>
      <VersionItem>Chromium v{versions.chrome}</VersionItem>
      <VersionItem>Node v{versions.node}</VersionItem>
    </VersionsList>
  )
}

export default Versions
