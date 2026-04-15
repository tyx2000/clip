import PropTypes from 'prop-types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import styled from 'styled-components'
import MeetingPanel from './components/MeetingPanel'
import MeetingRoomCard from './components/MeetingRoomCard'
import { useScreenShareController } from './hooks/useScreenShareController'
import { ensureCurrentUserId } from './utils/currentUserStorage'
import { readMeetingRooms, upsertMeetingRoom, writeMeetingRooms } from './utils/meetingRoomsStorage'

function getTitleBarFallbackHeight(platform) {
  if (platform === 'darwin') {
    return 28
  }
  if (platform === 'win32') {
    return 32
  }
  return 34
}

function resolveTitleBarHeight(platform, rawHeight) {
  const parsed = Number(rawHeight)
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }
  return getTitleBarFallbackHeight(platform)
}

const Page = styled.main`
  height: 100%;
  padding: calc(env(titlebar-area-height, ${({ $titleBarHeight }) => `${$titleBarHeight}px`}) + 8px)
    20px 20px;
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 12px;
`

const WindowTitleBar = styled.header`
  position: fixed;
  top: env(titlebar-area-y, 0px);
  left: env(titlebar-area-x, 0px);
  width: env(titlebar-area-width, 100%);
  height: env(titlebar-area-height, ${({ $titleBarHeight }) => `${$titleBarHeight}px`});
  background: #ffffff;
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 12px;
  -webkit-app-region: drag;
  user-select: none;
  z-index: 100;
`

const WindowTitleText = styled.p`
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  color: #0f172a;
  letter-spacing: 0.02em;
  white-space: nowrap;
  text-align: center;
  pointer-events: none;
`

const TopBar = styled.section`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border-radius: 5px;
  background: #f9fbfd;
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

const StatusText = styled.p`
  margin: 0;
  color: var(--color-text-soft);
  font-size: 12px;
`

const TopActions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
`

const MeetingButton = styled.button`
  border-radius: 5px;
  padding: 8px 11px;
  min-width: 92px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: var(--color-block-button);
  color: #ffffff;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`

const ListWrap = styled.section`
  border-radius: 5px;
  border: 1px solid var(--line-soft);
  background: var(--color-block-card);
  padding: 10px;
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 10px;
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

function MeetingWindow({ currentUserId, initialRoomId, initialSessionPayload, titleBarHeight }) {
  const shareController = useScreenShareController({
    isMeetingWindow: true,
    initialRoomId,
    initialSessionPayload,
    currentUserId
  })

  useEffect(() => {
    const roomId = shareController.roomInfo?.roomId || shareController.activeRoomId || initialRoomId
    document.title = roomId ? `会议 · ${roomId}` : '会议'

    return () => {
      document.title = '会议'
    }
  }, [initialRoomId, shareController.activeRoomId, shareController.roomInfo?.roomId])

  return (
    <MeetingPanel
      titleBarHeight={titleBarHeight}
      connectionLabel={shareController.connectionLabel}
      canLeaveMeeting={shareController.canLeaveMeeting}
      microphoneEnabled={shareController.microphoneEnabled}
      microphoneState={shareController.microphoneState}
      activeRoomId={shareController.activeRoomId}
      roomInfo={shareController.roomInfo}
      currentPeerId={shareController.currentPeerId}
      localVideoRef={shareController.localVideoRef}
      remoteVideoRef={shareController.remoteVideoRef}
      localPreviewStream={shareController.localPreviewStream}
      remotePreviewStream={shareController.remotePreviewStream}
      isSharing={shareController.isSharing}
      isHost={shareController.isHost}
      isRoomOwner={shareController.isRoomOwner}
      isViewer={shareController.isViewer}
      pickerOpen={shareController.pickerOpen}
      pickerLoading={shareController.pickerLoading}
      pickerSources={shareController.pickerSources}
      pickerSelectedSourceId={shareController.pickerSelectedSourceId}
      chatMessages={shareController.chatMessages}
      onLeaveRoom={shareController.leaveRoom}
      onCloseMeeting={shareController.closeMeeting}
      onOpenSourcePicker={shareController.openSourcePicker}
      onStopSharing={shareController.stopSharing}
      onToggleMicrophone={shareController.toggleMicrophone}
      onSelectShareSource={shareController.setPickerSelectedSourceId}
      onCloseSharePopover={shareController.closePicker}
      onConfirmShareSource={shareController.beginShareWithSource}
      onSendChatText={shareController.sendChatText}
      onSendChatImage={shareController.sendChatImage}
    />
  )
}

MeetingWindow.propTypes = {
  currentUserId: PropTypes.string.isRequired,
  initialRoomId: PropTypes.string.isRequired,
  titleBarHeight: PropTypes.number.isRequired,
  initialSessionPayload: PropTypes.shape({
    roomId: PropTypes.string,
    role: PropTypes.string,
    ownerUserId: PropTypes.string,
    currentUserId: PropTypes.string,
    peerId: PropTypes.string,
    token: PropTypes.string,
    wsUrl: PropTypes.string
  })
}

MeetingWindow.defaultProps = {
  initialSessionPayload: null
}

function LobbyWindow({ currentUserId, titleBarHeight }) {
  const [rooms, setRooms] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [statusMessage, setStatusMessage] = useState(
    '点击“会议”创建新房间，点击房间卡片可重新进入会议。'
  )
  const [isCreating, setIsCreating] = useState(false)
  const latestRoomSnapshotRef = useRef([])
  const hasReceivedSnapshotRef = useRef(false)
  const mergeBackendRooms = useCallback((remoteRooms) => {
    const roomMap = new Map(
      (Array.isArray(remoteRooms) ? remoteRooms : [])
        .filter((item) => typeof item?.roomId === 'string' && item.roomId)
        .map((item) => [item.roomId, item])
    )

    const storedRooms = readMeetingRooms()
    const nextStoredRooms = storedRooms.filter((item) => roomMap.has(item.roomId))
    if (nextStoredRooms.length !== storedRooms.length) {
      writeMeetingRooms(nextStoredRooms)
    }

    const nextRooms = nextStoredRooms
      .map((item) => {
        const syncedRoom = roomMap.get(item.roomId) || {}
        return {
          ...item,
          ...syncedRoom,
          role: item.role || syncedRoom.role || 'host',
          ownerUserId: item.ownerUserId || syncedRoom.ownerUserId || '',
          peerId: item.peerId,
          token: item.token,
          wsUrl: item.wsUrl,
          hostPresent:
            typeof syncedRoom.hostPresent === 'boolean'
              ? syncedRoom.hostPresent
              : Boolean(item.hostPresent),
          shareActive:
            typeof syncedRoom.shareActive === 'boolean'
              ? syncedRoom.shareActive
              : Boolean(item.shareActive),
          viewerCount: Number(
            Number.isFinite(syncedRoom.viewerCount) ? syncedRoom.viewerCount : item.viewerCount || 0
          )
        }
      })
      .sort((left, right) => {
        const leftUpdatedAt = new Date(left.updatedAt || left.createdAt || 0).getTime()
        const rightUpdatedAt = new Date(right.updatedAt || right.createdAt || 0).getTime()
        return rightUpdatedAt - leftUpdatedAt
      })

    setRooms(nextRooms)
  }, [])

  useEffect(() => {
    let disposed = false
    const subscribe = window.api?.subscribeScreenShareRooms
    const unsubscribe = window.api?.unsubscribeScreenShareRooms
    const onSnapshot = window.api?.onScreenShareRoomsSnapshot

    if (typeof subscribe !== 'function' || typeof onSnapshot !== 'function') {
      setIsLoading(false)
      setStatusMessage('会议房间订阅接口不可用。')
      return undefined
    }

    setIsLoading(true)

    const stopListening = onSnapshot((payload) => {
      if (disposed) {
        return
      }

      latestRoomSnapshotRef.current = Array.isArray(payload?.rooms) ? payload.rooms : []
      hasReceivedSnapshotRef.current = true
      mergeBackendRooms(latestRoomSnapshotRef.current)
      setIsLoading(false)
    })

    void subscribe().then((result) => {
      if (disposed) {
        return
      }

      if (!result?.ok) {
        setIsLoading(false)
        setStatusMessage(result?.message || '连接会议房间列表失败。')
      }
    })

    return () => {
      disposed = true
      stopListening?.()
      unsubscribe?.()
    }
  }, [mergeBackendRooms])

  useEffect(() => {
    const handleStorage = (event) => {
      if (event.key && event.key !== 'clip-meeting-rooms') {
        return
      }

      if (!hasReceivedSnapshotRef.current) {
        return
      }
      mergeBackendRooms(latestRoomSnapshotRef.current)
    }

    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener('storage', handleStorage)
    }
  }, [mergeBackendRooms])

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

      const payload = await window.api.createScreenShareRoom({ userId: currentUserId })
      if (!payload?.ok) {
        throw new Error(payload?.message || '创建会议房间失败。')
      }

      const nextRooms = upsertMeetingRoom({
        roomId: payload.roomId,
        createdAt: payload.createdAt || new Date().toISOString(),
        updatedAt: payload.updatedAt || new Date().toISOString(),
        role: payload.role,
        ownerUserId: payload.ownerUserId || currentUserId,
        peerId: payload.peerId,
        token: payload.token,
        wsUrl: payload.wsUrl,
        hostPresent: true,
        shareActive: false,
        viewerCount: Number(payload.viewerCount || 0)
      })

      setRooms((currentRooms) => {
        const currentRoomMap = new Map(currentRooms.map((item) => [item.roomId, item]))
        return nextRooms
          .filter((item) => item.roomId === payload.roomId || currentRoomMap.has(item.roomId))
          .map((item) => ({
            ...(currentRoomMap.get(item.roomId) || {}),
            ...item
          }))
      })
      await openMeetingWindow({
        roomId: payload.roomId,
        sessionPayload: {
          roomId: payload.roomId,
          role: payload.role,
          ownerUserId: payload.ownerUserId || currentUserId,
          currentUserId,
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
  }, [currentUserId, openMeetingWindow])

  const handleOpenRoom = useCallback(
    async (item) => {
      try {
        await openMeetingWindow({
          roomId: item.roomId,
          sessionPayload: {
            roomId: item.roomId,
            role: item.role || 'host',
            ownerUserId: item.ownerUserId || '',
            currentUserId,
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
    [currentUserId, openMeetingWindow]
  )

  return (
    <Page $titleBarHeight={titleBarHeight}>
      <WindowTitleBar $titleBarHeight={titleBarHeight}>
        <WindowTitleText>会议</WindowTitleText>
      </WindowTitleBar>

      <TopBar>
        <TitleGroup>
          <Title>会议</Title>
          <StatusText>{statusMessage}</StatusText>
        </TitleGroup>

        <TopActions>
          <MeetingButton type="button" onClick={handleCreateMeeting} disabled={isCreating}>
            {isCreating ? '创建中...' : '会议'}
          </MeetingButton>
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
                <MeetingRoomCard key={item.roomId} item={item} onOpen={handleOpenRoom} />
              ))}
            </RoomsList>
          )}
        </RoomsGrid>
      </ListWrap>
    </Page>
  )
}

LobbyWindow.propTypes = {
  currentUserId: PropTypes.string.isRequired,
  titleBarHeight: PropTypes.number.isRequired
}

function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const currentUserId = useMemo(() => ensureCurrentUserId(), [])
  const initialRoomId = params.get('roomId') || ''
  const meetingPlatform = params.get('platform') || ''
  const titleBarHeight = useMemo(
    () => resolveTitleBarHeight(meetingPlatform, params.get('titleBarHeight')),
    [meetingPlatform, params]
  )
  const initialSessionPayload = parseInitialSession(params)
  const isMeetingWindow = params.get('meeting') === '1'

  if (isMeetingWindow) {
    return (
      <MeetingWindow
        currentUserId={currentUserId}
        initialRoomId={initialRoomId}
        initialSessionPayload={initialSessionPayload}
        titleBarHeight={titleBarHeight}
      />
    )
  }

  return <LobbyWindow currentUserId={currentUserId} titleBarHeight={titleBarHeight} />
}

export default App
