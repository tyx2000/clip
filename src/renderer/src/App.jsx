import PropTypes from 'prop-types'
import { useCallback, useEffect, useMemo, useState } from 'react'
import styled from 'styled-components'
import MeetingPanel from './components/MeetingPanel'
import MeetingRoomCard from './components/MeetingRoomCard'
import SourcePickerModal from './components/SourcePickerModal'
import { useScreenShareController } from './hooks/useScreenShareController'
import { readMeetingRooms, removeMeetingRoom, upsertMeetingRoom } from './utils/meetingRoomsStorage'

const Page = styled.main`
  height: 100%;
  padding: 22px;
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 14px;
`

const TopBar = styled.section`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--line-soft);
  background: var(--color-block-card-strong);
`

const TitleGroup = styled.div`
  display: grid;
  gap: 6px;
`

const Title = styled.h1`
  margin: 0;
  font-size: 22px;
  line-height: 1.2;
`

const Subtitle = styled.p`
  margin: 0;
  color: var(--color-text-soft);
  font-size: 13px;
`

const StatusText = styled.p`
  margin: 0;
  color: var(--color-text-soft);
  font-size: 12px;
`

const MetricsRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`

const MetricPill = styled.span`
  border-radius: 999px;
  padding: 5px 9px;
  border: 1px solid var(--line-soft);
  background: var(--color-block-input);
  color: var(--color-text-soft);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
`

const TopActions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
`

const Button = styled.button`
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  padding: 9px 12px;
  min-width: 112px;
  background: var(--color-block-input);
  color: var(--color-text);
  font-weight: 600;
  cursor: pointer;

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`

const MeetingButton = styled(Button)`
  border: none;
  background: var(--color-block-button);
  color: #ffffff;
`

const ListWrap = styled.section`
  border-radius: 12px;
  border: 1px solid var(--line-soft);
  background: var(--color-block-card);
  padding: 14px;
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 12px;
`

const ListHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
`

const RoomsGrid = styled.div`
  min-height: 320px;
  display: grid;
  place-items: ${({ $hasItems }) => ($hasItems ? 'stretch' : 'center')};
`

const SectionTitle = styled.h2`
  margin: 0;
  font-size: 16px;
`

const EmptyState = styled.p`
  margin: 0;
  font-size: 13px;
  color: var(--color-text-soft);
  text-align: center;
`

const RoomsList = styled.div`
  width: 100%;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  align-items: start;
  gap: 12px;
`

function parseInitialSession(searchParams) {
  const raw = searchParams.get('session')
  if (!raw) {
    return null
  }

  try {
    return JSON.parse(decodeURIComponent(raw))
  } catch {
    return null
  }
}

function MeetingWindow({ initialRoomId, initialSessionPayload }) {
  const shareController = useScreenShareController({
    isMeetingWindow: true,
    initialRoomId,
    initialSessionPayload
  })

  return (
    <>
      <MeetingPanel
        roomState={shareController.roomState}
        shareState={shareController.shareState}
        connectionLabel={shareController.connectionLabel}
        microphoneEnabled={shareController.microphoneEnabled}
        microphoneState={shareController.microphoneState}
        statusMessage={shareController.statusMessage}
        roomInfo={shareController.roomInfo}
        joinRoomId={shareController.joinRoomId}
        setJoinRoomId={shareController.setJoinRoomId}
        localVideoRef={shareController.localVideoRef}
        remoteVideoRef={shareController.remoteVideoRef}
        isJoined={shareController.isJoined}
        isSharing={shareController.isSharing}
        isHost={shareController.isHost}
        isViewer={shareController.isViewer}
        onCreateRoom={shareController.createRoom}
        onJoinRoom={shareController.joinRoom}
        onLeaveRoom={shareController.leaveRoom}
        onOpenSourcePicker={shareController.openSourcePicker}
        onStopSharing={shareController.stopSharing}
        onCopyRoomId={shareController.copyRoomId}
        onToggleMicrophone={shareController.toggleMicrophone}
      />

      <SourcePickerModal
        open={shareController.pickerOpen}
        loading={shareController.pickerLoading}
        sources={shareController.pickerSources}
        selectedSourceId={shareController.pickerSelectedSourceId}
        cloudSyncEnabled={false}
        showCloudSyncToggle={false}
        title="选择共享源"
        description="请选择要共享的屏幕或窗口，然后点击“开始共享”。"
        confirmLabel="开始共享"
        isBusy={shareController.shareState === 'starting'}
        onSelect={shareController.setPickerSelectedSourceId}
        onToggleCloudSync={shareController.noopToggle}
        onCancel={shareController.closePicker}
        onConfirm={shareController.beginShareWithSource}
      />
    </>
  )
}

MeetingWindow.propTypes = {
  initialRoomId: PropTypes.string.isRequired,
  initialSessionPayload: PropTypes.shape({
    roomId: PropTypes.string,
    role: PropTypes.string,
    peerId: PropTypes.string,
    token: PropTypes.string,
    wsUrl: PropTypes.string
  })
}

MeetingWindow.defaultProps = {
  initialSessionPayload: null
}

function LobbyWindow() {
  const [rooms, setRooms] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [statusMessage, setStatusMessage] = useState(
    '点击“会议”创建新房间，点击房间卡片可重新进入会议。'
  )
  const [isCreating, setIsCreating] = useState(false)

  const refreshRooms = useCallback(async () => {
    setIsLoading(true)

    try {
      const storedRooms = readMeetingRooms()
      const getRoom = window.api?.getScreenShareRoom

      const enrichedRooms = await Promise.all(
        storedRooms.map(async (item) => {
          if (typeof getRoom !== 'function') {
            return {
              ...item,
              hostPresent: false,
              shareActive: false,
              viewerCount: 0,
              unavailable: true
            }
          }

          try {
            const payload = await getRoom({ roomId: item.roomId })
            if (!payload?.ok) {
              return {
                ...item,
                hostPresent: false,
                shareActive: false,
                viewerCount: 0,
                unavailable: true
              }
            }

            return {
              ...item,
              hostPresent: Boolean(payload.hostPresent),
              shareActive: Boolean(payload.shareActive),
              viewerCount: Number(payload.viewerCount || 0),
              unavailable: false
            }
          } catch {
            return {
              ...item,
              hostPresent: false,
              shareActive: false,
              viewerCount: 0,
              unavailable: true
            }
          }
        })
      )

      setRooms(enrichedRooms)
    } catch (error) {
      setStatusMessage(error?.message || '读取房间列表失败。')
      setRooms(readMeetingRooms())
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshRooms()
  }, [refreshRooms])

  const openMeetingWindow = useCallback(async (payload) => {
    if (typeof window.api?.openScreenShareMeetingWindow !== 'function') {
      throw new Error('当前环境不支持打开会议窗口。')
    }

    const result = await window.api.openScreenShareMeetingWindow(payload)
    if (!result?.ok) {
      throw new Error(result?.message || '打开会议窗口失败。')
    }
  }, [])

  const handleCreateMeeting = useCallback(async () => {
    setIsCreating(true)
    setStatusMessage('正在创建会议房间...')

    try {
      if (typeof window.api?.createScreenShareRoom !== 'function') {
        throw new Error('当前环境不支持创建会议房间。')
      }

      const payload = await window.api.createScreenShareRoom()
      if (!payload?.ok) {
        throw new Error(payload?.message || '创建会议房间失败。')
      }

      const nextRooms = upsertMeetingRoom({
        roomId: payload.roomId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        role: payload.role,
        peerId: payload.peerId,
        token: payload.token,
        wsUrl: payload.wsUrl,
        hostPresent: true,
        shareActive: false,
        viewerCount: Number(payload.viewerCount || 0)
      })

      setRooms(nextRooms)
      await openMeetingWindow({
        roomId: payload.roomId,
        sessionPayload: {
          roomId: payload.roomId,
          role: payload.role,
          peerId: payload.peerId,
          token: payload.token,
          wsUrl: payload.wsUrl
        }
      })
      setStatusMessage(`房间 ${payload.roomId} 已创建。`)
    } catch (error) {
      setStatusMessage(error?.message || '创建会议房间失败。')
    } finally {
      setIsCreating(false)
    }
  }, [openMeetingWindow])

  const handleOpenRoom = useCallback(
    async (item) => {
      try {
        await openMeetingWindow({
          roomId: item.roomId,
          sessionPayload: {
            roomId: item.roomId,
            role: item.role || 'host',
            peerId: item.peerId,
            token: item.token,
            wsUrl: item.wsUrl
          }
        })
        setStatusMessage(`正在进入房间 ${item.roomId}。`)
      } catch (error) {
        setStatusMessage(error?.message || '进入会议失败。')
      }
    },
    [openMeetingWindow]
  )

  const handleDeleteRoom = useCallback((roomId) => {
    setRooms(removeMeetingRoom(roomId))
    setStatusMessage(`已删除房间 ${roomId}。`)
  }, [])

  return (
    <Page>
      <TopBar>
        <TitleGroup>
          <Title>会议</Title>
          <Subtitle>点击“会议”创建新房间，已创建房间可直接重新进入。</Subtitle>
          <StatusText>{statusMessage}</StatusText>
          <MetricsRow>
            <MetricPill>房间数 {rooms.length}</MetricPill>
          </MetricsRow>
        </TitleGroup>

        <TopActions>
          <MeetingButton type="button" onClick={handleCreateMeeting} disabled={isCreating}>
            {isCreating ? '创建中...' : '会议'}
          </MeetingButton>
          <Button type="button" onClick={refreshRooms} disabled={isLoading || isCreating}>
            {isLoading ? '刷新中...' : '刷新列表'}
          </Button>
        </TopActions>
      </TopBar>

      <ListWrap>
        <ListHeader>
          <SectionTitle>已创建房间</SectionTitle>
        </ListHeader>

        <RoomsGrid $hasItems={!isLoading && rooms.length > 0}>
          {isLoading ? (
            <EmptyState>正在加载房间列表...</EmptyState>
          ) : rooms.length === 0 ? (
            <EmptyState>暂无已创建房间</EmptyState>
          ) : (
            <RoomsList>
              {rooms.map((item) => (
                <MeetingRoomCard
                  key={item.roomId}
                  item={item}
                  onOpen={handleOpenRoom}
                  onDelete={handleDeleteRoom}
                />
              ))}
            </RoomsList>
          )}
        </RoomsGrid>
      </ListWrap>
    </Page>
  )
}

function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const initialRoomId = params.get('roomId') || ''
  const initialSessionPayload = parseInitialSession(params)
  const isMeetingWindow = params.get('meeting') === '1'

  if (isMeetingWindow) {
    return (
      <MeetingWindow initialRoomId={initialRoomId} initialSessionPayload={initialSessionPayload} />
    )
  }

  return <LobbyWindow />
}

export default App
