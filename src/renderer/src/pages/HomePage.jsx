import { useEffect, useState } from 'react'
import styled from 'styled-components'
import {
  ButtonRow,
  CardTitle,
  EditorRow,
  PageDesc,
  PageGrid,
  PageTitle,
  PixelButton,
  PixelCard,
  PixelCardLarge,
  PixelInput
} from '../styles/primitives'
import useSharedStore from '../store/sharedStore'

const HomeGrid = styled(PageGrid)`
  height: 100%;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  grid-auto-rows: min-content;
  align-content: start;
  overflow: hidden;
`

const HomeHeader = styled.header`
  margin-bottom: 14px;
`

const HomeStatsGrid = styled.section`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
  margin-bottom: 14px;

  @media (max-width: 700px) {
    grid-template-columns: 1fr;
  }
`

const HomeStatCard = styled.article`
  background: var(--color-block-content);
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  padding: 10px 12px;
`

const HomeStatLabel = styled.p`
  margin: 0;
  color: var(--color-text-soft);
  font-size: 12px;
`

const HomeStatValue = styled.p`
  margin: 6px 0 0;
  font-size: ${({ $compact }) => ($compact ? '13px' : '16px')};
  font-weight: ${({ $compact }) => ($compact ? 600 : 700)};
  line-height: 1.4;
`

const HomeActions = styled.section`
  padding-top: 12px;
  border-top: 1px solid var(--line-soft);
`

const HomeEditor = styled.section`
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--line-soft);
`

const HomeEditorLabel = styled.p`
  margin: 0 0 8px;
  color: var(--color-text-soft);
  font-size: 12px;
  font-weight: 600;
`

function HomePage() {
  const count = useSharedStore((state) => state.count)
  const message = useSharedStore((state) => state.message)
  const hydrated = useSharedStore((state) => state.hydrated)
  const setMessage = useSharedStore((state) => state.setMessage)
  const increment = useSharedStore((state) => state.increment)

  const [draftMessage, setDraftMessage] = useState('')
  const [pingResult, setPingResult] = useState('')
  const [notifyResult, setNotifyResult] = useState('')

  useEffect(() => {
    setDraftMessage(message)
  }, [message])

  const handlePing = async () => {
    const result = await window.api.ping()
    setPingResult(`${result.message} @ ${result.timestamp}`)
  }

  const handleSendNotification = async () => {
    const result = await window.api.sendSystemNotification({
      title: 'Pixel Hub',
      body: 'Home page triggered a desktop notification.'
    })
    setNotifyResult(result?.message || 'Notification request finished.')
  }

  return (
    <HomeGrid data-page="home">
      <PixelCardLarge>
        <HomeHeader>
          <PageTitle>Home Dashboard</PageTitle>
          <PageDesc>Zustand + Electron IPC multi-window shared state.</PageDesc>
        </HomeHeader>

        <HomeStatsGrid>
          <HomeStatCard>
            <HomeStatLabel>Shared Count</HomeStatLabel>
            <HomeStatValue>{hydrated ? count : 'loading...'}</HomeStatValue>
          </HomeStatCard>
          <HomeStatCard>
            <HomeStatLabel>Shared Message</HomeStatLabel>
            <HomeStatValue $compact>{hydrated ? message || '(empty)' : 'loading...'}</HomeStatValue>
          </HomeStatCard>
          <HomeStatCard>
            <HomeStatLabel>IPC Ping</HomeStatLabel>
            <HomeStatValue $compact>{pingResult || '-'}</HomeStatValue>
          </HomeStatCard>
          <HomeStatCard>
            <HomeStatLabel>Notification</HomeStatLabel>
            <HomeStatValue $compact>{notifyResult || '-'}</HomeStatValue>
          </HomeStatCard>
        </HomeStatsGrid>

        <HomeActions>
          <ButtonRow>
            <PixelButton onClick={() => increment(1)}>Count +1</PixelButton>
            <PixelButton onClick={() => window.api.createWindow()}>Open New Window</PixelButton>
            <PixelButton onClick={handlePing}>Call IPC Ping</PixelButton>
            <PixelButton onClick={handleSendNotification}>Send System Notification</PixelButton>
          </ButtonRow>
        </HomeActions>

        <HomeEditor>
          <HomeEditorLabel>Message Editor</HomeEditorLabel>
          <EditorRow>
            <PixelInput
              value={draftMessage}
              onChange={(event) => setDraftMessage(event.target.value)}
              placeholder="Type shared message"
            />
            <PixelButton onClick={() => setMessage(draftMessage)}>Sync Message</PixelButton>
          </EditorRow>
        </HomeEditor>
      </PixelCardLarge>

      <PixelCard>
        <CardTitle>Sync Rules</CardTitle>
        <p>Changes are sent to main process by IPC and broadcast to all opened windows.</p>
      </PixelCard>
      <PixelCard>
        <CardTitle>Persistence</CardTitle>
        <p>Shared state is saved under Electron userData and restored on next launch.</p>
      </PixelCard>
    </HomeGrid>
  )
}

export default HomePage
