import PropTypes from 'prop-types'
import { useEffect, useMemo, useRef, useState } from 'react'
import styled from 'styled-components'
import { formatDateTime24, middleEllipsis } from '../utils/shareUtils'

const Page = styled.main`
  height: 100%;
  padding: calc(env(titlebar-area-height, ${({ $titleBarHeight }) => `${$titleBarHeight}px`}) + 8px)
    14px 14px;
  display: grid;
  background: #eef3f8;
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

const MetaPill = styled.span`
  border-radius: 5px;
  padding: 5px 8px;
  background: ${({ $accent }) => ($accent ? '#eaf2ff' : '#f5f8fb')};
  color: ${({ $accent }) => ($accent ? '#1d4ed8' : 'var(--color-text-soft)')};
  font-size: 11px;
  white-space: nowrap;
`

const GhostButton = styled.button`
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 5px;
  padding: 8px 12px;
  background: #ffffff;
  color: var(--color-text);
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`

const Layout = styled.section`
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(300px, 420px);
  gap: 12px;

  @media (max-width: 980px) {
    grid-template-columns: 1fr;
  }
`

const StagePanel = styled.section`
  min-height: 0;
  border-radius: 5px;
  border: 1px solid var(--line-soft);
  background: #f8fbfd;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  overflow: hidden;
`

const StageWrap = styled.div`
  position: relative;
  min-height: 0;
  padding: 12px;
  background: #edf3f8;
`

const StageFrame = styled.div`
  width: 100%;
  height: 100%;
  min-height: 420px;
  border-radius: 5px;
  overflow: hidden;
  position: relative;
  background: #0f172a;

  @media (max-width: 980px) {
    min-height: 360px;
  }
`

const PreviewVideo = styled.video`
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
`

const ParticipantStage = styled.div`
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 26px;
  background: #0f172a;
`

const ParticipantGrid = styled.div`
  width: min(760px, 100%);
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
`

const ParticipantCard = styled.div`
  width: 128px;
  display: grid;
  justify-items: center;
  gap: 10px;
  opacity: ${({ $connected }) => ($connected ? 1 : 0.56)};
`

const ParticipantAvatar = styled.div`
  width: 78px;
  height: 78px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  font-size: 24px;
  font-weight: 800;
  color: #ffffff;
  background: ${({ $color }) => $color};
  border: 1px solid rgba(255, 255, 255, 0.28);
`

const ParticipantName = styled.p`
  margin: 0;
  color: #ffffff;
  font-size: 13px;
  font-weight: 700;
`

const ParticipantMeta = styled.p`
  margin: 0;
  color: rgba(226, 232, 240, 0.88);
  font-size: 12px;
`

const ParticipantAudioBadge = styled.span`
  border-radius: 999px;
  padding: 4px 8px;
  background: ${({ $active }) => ($active ? 'rgba(34, 197, 94, 0.18)' : 'rgba(15, 23, 42, 0.32)')};
  color: ${({ $active }) => ($active ? '#bbf7d0' : 'rgba(226, 232, 240, 0.88)')};
  font-size: 11px;
  font-weight: 700;
`

const StageHint = styled.div`
  position: absolute;
  left: 18px;
  right: 18px;
  bottom: 18px;
  display: flex;
  justify-content: center;
`

const StageHintText = styled.p`
  margin: 0;
  max-width: 560px;
  padding: 8px 12px;
  border-radius: 5px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(15, 23, 42, 0.9);
  color: rgba(226, 232, 240, 0.92);
  font-size: 12px;
  text-align: center;
`

const ControlsBar = styled.div`
  border-top: 1px solid rgba(15, 23, 42, 0.06);
  padding: 12px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 16px;

  @media (max-width: 720px) {
    grid-template-columns: 1fr;
  }
`

const ControlsBlock = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: ${({ $align }) => $align || 'flex-start'};
  flex-wrap: wrap;
  position: relative;
`

const ControlButton = styled.button`
  border: 1px solid transparent;
  border-radius: 5px;
  padding: 9px 12px;
  min-width: 96px;
  background: ${({ $variant }) => {
    if ($variant === 'danger') return '#dc2626'
    if ($variant === 'primary') return '#2563eb'
    if ($variant === 'muted') return '#0f172a'
    return '#f5f7fa'
  }};
  color: ${({ $variant }) => ($variant === 'secondary' ? '#0f172a' : '#ffffff')};
  font-weight: 700;
  font-size: 13px;
  cursor: pointer;
  border-color: ${({ $variant }) => {
    if ($variant === 'danger') return 'rgba(153, 27, 27, 0.3)'
    if ($variant === 'primary') return 'rgba(30, 64, 175, 0.24)'
    if ($variant === 'muted') return 'rgba(15, 23, 42, 0.18)'
    return 'rgba(15, 23, 42, 0.08)'
  }};

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`

const ShareStageOverlay = styled.div`
  position: absolute;
  inset: 0;
  padding: 16px;
  display: grid;
  place-items: center;
  background: rgba(2, 6, 23, 0.85);
`

const ShareStageCard = styled.div`
  width: min(860px, 100%);
  max-height: 100%;
  border-radius: 5px;
  border: 1px solid var(--line-soft);
  background: #ffffff;
  overflow: hidden;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
`

const ShareStageHeader = styled.div`
  padding: 12px;
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
`

const ShareStageMeta = styled.div`
  display: grid;
  gap: 6px;
`

const ShareStageTitle = styled.h3`
  margin: 0;
  font-size: 18px;
`

const ShareStageDesc = styled.p`
  margin: 0;
  color: var(--color-text-soft);
  font-size: 13px;
`

const ShareStageClose = styled.button`
  border: none;
  background: transparent;
  color: var(--color-text-soft);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
`

const ShareStageBody = styled.div`
  padding: 12px;
  display: grid;
  gap: 12px;
  min-height: 0;
  overflow: auto;
`

const ShareSourcesGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
`

const ShareSourceCard = styled.button`
  border: 1px solid ${({ $selected }) => ($selected ? '#bfd0ea' : 'var(--line-soft)')};
  border-radius: 5px;
  background: ${({ $selected }) => ($selected ? '#eef5ff' : '#ffffff')};
  padding: 9px;
  text-align: left;
  display: grid;
  gap: 7px;
  cursor: pointer;
`

const ShareThumb = styled.div`
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 5px;
  overflow: hidden;
  background: #0f172a;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
`

const ShareSourceName = styled.p`
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--color-text);
`

const ShareSourceMeta = styled.p`
  margin: 0;
  font-size: 12px;
  color: var(--color-text-soft);
`

const ShareStageHeaderActions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
`

const ShareStageStatus = styled.p`
  margin: 0;
  color: var(--color-text-soft);
  font-size: 12px;
`

const ChatPanel = styled.section`
  min-height: 0;
  border-radius: 5px;
  border: 1px solid var(--line-soft);
  background: #ffffff;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
`

const ChatHeader = styled.div`
  padding: 12px;
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
  display: grid;
  gap: 6px;
`

const ChatTitle = styled.h2`
  margin: 0;
  font-size: 18px;
`

const ChatDescription = styled.p`
  margin: 0;
  color: var(--color-text-soft);
  font-size: 12px;
`

const ChatScroll = styled.div`
  min-height: 0;
  overflow: auto;
  padding: 12px;
  display: grid;
  align-content: start;
  gap: 10px;
  background: #fafcfe;
`

const EmptyChat = styled.p`
  margin: auto 0;
  color: var(--color-text-soft);
  font-size: 13px;
  text-align: center;
`

const MessageRow = styled.div`
  display: flex;
  justify-content: ${({ $mine }) => ($mine ? 'flex-end' : 'flex-start')};
`

const MessageBubble = styled.div`
  max-width: min(78%, 320px);
  display: grid;
  gap: 7px;
  padding: 10px 12px;
  border-radius: ${({ $mine }) => ($mine ? '8px 8px 2px 8px' : '8px 8px 8px 2px')};
  background: ${({ $mine }) => ($mine ? '#2563eb' : '#f9fbfd')};
  color: ${({ $mine }) => ($mine ? '#ffffff' : 'var(--color-text)')};
  border: 1px solid ${({ $mine }) => ($mine ? 'rgba(30, 64, 175, 0.22)' : 'rgba(15, 23, 42, 0.06)')};
`

const MessageAuthor = styled.p`
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  color: inherit;
  opacity: 0.82;
`

const MessageText = styled.p`
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
`

const MessageImage = styled.img`
  width: 100%;
  max-width: 260px;
  border-radius: 5px;
  display: block;
  cursor: zoom-in;
`

const MessageTime = styled.p`
  margin: 0;
  font-size: 11px;
  color: inherit;
  opacity: 0.7;
  justify-self: ${({ $mine }) => ($mine ? 'end' : 'start')};
`

const ChatComposer = styled.div`
  padding: 12px;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
  background: #ffffff;
  display: grid;
  gap: 8px;
`

const ChatInput = styled.textarea`
  width: 100%;
  min-height: 88px;
  resize: none;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 5px;
  padding: 10px 12px;
  background: #ffffff;
  color: var(--color-text);
  font: inherit;
`

const ChatComposerActions = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
`

const ChatActionGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
`

const ComposerButton = styled.button`
  border: 1px solid
    ${({ $primary }) => ($primary ? 'rgba(30, 64, 175, 0.24)' : 'rgba(15, 23, 42, 0.08)')};
  border-radius: 5px;
  padding: 8px 12px;
  background: ${({ $primary }) => ($primary ? '#2563eb' : '#eef2f6')};
  color: ${({ $primary }) => ($primary ? '#ffffff' : '#0f172a')};
  font-weight: 700;
  font-size: 13px;
  cursor: pointer;

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`

const HiddenFileInput = styled.input`
  display: none;
`

const ImagePreviewOverlay = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.78);
  display: grid;
  place-items: center;
  padding: 24px;
  z-index: 2000;
`

const ImagePreviewFrame = styled.button`
  border: none;
  background: transparent;
  padding: 0;
  cursor: zoom-out;

  img {
    max-width: min(90vw, 1200px);
    max-height: 88vh;
    display: block;
    border-radius: 5px;
    border: 1px solid rgba(148, 163, 184, 0.45);
  }
`

function hashColor(input) {
  const palette = ['#2563eb', '#0891b2', '#db2777', '#16a34a', '#9333ea', '#ea580c', '#dc2626']
  const text = String(input || 'clip')
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  }
  return palette[hash % palette.length]
}

function buildParticipantCards(roomInfo, currentPeerId, isHost, isRoomOwner) {
  const participantMap = new Map()
  const participants = Array.isArray(roomInfo?.participants) ? roomInfo.participants : []
  let viewerIndex = 0

  for (const participant of participants) {
    if (!participant?.peerId) {
      continue
    }
    participantMap.set(participant.peerId, participant)
  }

  const inferredHostPeerId =
    participants.find((participant) => participant?.role === 'host')?.peerId ||
    (roomInfo?.role === 'host' ? roomInfo?.peerId || 'host' : '') ||
    (isHost || isRoomOwner ? currentPeerId || roomInfo?.peerId || 'host' : '') ||
    'host'

  if (
    inferredHostPeerId &&
    ![...participantMap.values()].some((participant) => participant.role === 'host') &&
    (Boolean(roomInfo?.hostPresent) || roomInfo?.role === 'host' || isHost || isRoomOwner)
  ) {
    participantMap.set(inferredHostPeerId, {
      peerId: inferredHostPeerId,
      role: 'host',
      connected:
        typeof roomInfo?.hostPresent === 'boolean'
          ? roomInfo.hostPresent
          : Boolean(roomInfo?.role === 'host' || isHost || isRoomOwner),
      audioEnabled: false
    })
  }

  if (currentPeerId && roomInfo?.role === 'viewer' && !participantMap.has(currentPeerId)) {
    participantMap.set(currentPeerId, {
      peerId: currentPeerId,
      role: 'viewer',
      connected: true,
      audioEnabled: false
    })
  }

  return [...participantMap.values()].map((participant) => {
    const isHostParticipant = participant.role === 'host'
    viewerIndex += isHostParticipant ? 0 : 1
    return {
      ...participant,
      label: isHostParticipant ? '主持人' : `观${viewerIndex}`,
      avatarText: isHostParticipant ? '主' : String(viewerIndex),
      color: hashColor(participant.peerId),
      audioEnabled: Boolean(participant.audioEnabled)
    }
  })
}

function resolveMessageSenderLabel(message, participants) {
  const matchedParticipant = participants.find(
    (participant) => participant.peerId === message.senderPeerId
  )
  if (matchedParticipant) {
    return matchedParticipant.label
  }
  return message.senderRole === 'host' ? '主持人' : '参会人'
}

function MeetingPanel({
  titleBarHeight,
  connectionLabel,
  canLeaveMeeting,
  microphoneEnabled,
  microphoneState,
  activeRoomId,
  roomInfo,
  currentPeerId,
  localVideoRef,
  remoteVideoRef,
  localPreviewStream,
  remotePreviewStream,
  isSharing,
  isHost,
  isRoomOwner,
  isViewer,
  pickerOpen,
  pickerLoading,
  pickerSources,
  pickerSelectedSourceId,
  chatMessages,
  onLeaveRoom,
  onCloseMeeting,
  onOpenSourcePicker,
  onStopSharing,
  onToggleMicrophone,
  onSelectShareSource,
  onCloseSharePopover,
  onConfirmShareSource,
  onSendChatText,
  onSendChatImage
}) {
  const fileInputRef = useRef(null)
  const messageEndRef = useRef(null)
  const [draftText, setDraftText] = useState('')
  const [previewImageUrl, setPreviewImageUrl] = useState('')
  const participantCards = useMemo(
    () => buildParticipantCards(roomInfo, currentPeerId, isHost, isRoomOwner),
    [currentPeerId, isHost, isRoomOwner, roomInfo]
  )
  const canShowShareControls = isHost || isRoomOwner
  const hasLocalSharePreview = Boolean(localPreviewStream)
  const showSharedVideo =
    hasLocalSharePreview || (isHost ? isSharing : Boolean(roomInfo?.shareActive))
  const showLocalPreview = hasLocalSharePreview || isHost

  const stageHint = showSharedVideo
    ? isHost
      ? '你正在向会议发送桌面画面。停止共享后将恢复头像墙。'
      : '主持人正在共享桌面，语音和聊天会继续保持。'
    : isViewer && !roomInfo?.hostPresent
      ? '主持人暂未在线，房间关闭后你会收到提示。'
      : '当前为语音会议模式，主持人开始共享后这里会切换为桌面画面。'

  const microphoneLabel =
    microphoneState === 'requesting'
      ? '开麦中...'
      : microphoneState === 'blocked'
        ? '麦克风受限'
        : microphoneEnabled
          ? '麦克风已开'
          : '麦克风关闭'
  const meetingTitle = `会议 · ${middleEllipsis(roomInfo?.roomId || activeRoomId || '--', 28)}`

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: 'end' })
  }, [chatMessages])

  useEffect(() => {
    const node = localVideoRef.current
    if (!node) {
      return
    }

    node.srcObject = localPreviewStream || null
    if (localPreviewStream) {
      node.play().catch(() => {})
    }
  }, [localPreviewStream, localVideoRef])

  useEffect(() => {
    const node = remoteVideoRef.current
    if (!node) {
      return
    }

    node.srcObject = remotePreviewStream || null
    if (remotePreviewStream) {
      node.play().catch(() => {})
    }
  }, [remotePreviewStream, remoteVideoRef])

  const handleSendText = async () => {
    const text = draftText.trim()
    if (!text) {
      return
    }

    const sent = await onSendChatText(text)
    if (sent) {
      setDraftText('')
    }
  }

  const handleChatKeyDown = async (event) => {
    if (event.key !== 'Enter' || event.shiftKey) {
      return
    }

    event.preventDefault()
    await handleSendText()
  }

  const handlePickImage = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    await onSendChatImage(file)
    event.target.value = ''
  }

  return (
    <Page $titleBarHeight={titleBarHeight}>
      <WindowTitleBar $titleBarHeight={titleBarHeight}>
        <WindowTitleText>{meetingTitle}</WindowTitleText>
      </WindowTitleBar>

      <Layout>
        <StagePanel>
          <StageWrap>
            <StageFrame>
              {showSharedVideo ? (
                <PreviewVideo
                  ref={showLocalPreview ? localVideoRef : remoteVideoRef}
                  muted={showLocalPreview}
                  playsInline
                  autoPlay
                />
              ) : null}

              {!showSharedVideo ? (
                <ParticipantStage>
                  <ParticipantGrid>
                    {participantCards.map((participant) => (
                      <ParticipantCard
                        key={participant.peerId}
                        $connected={Boolean(participant.connected)}
                      >
                        <ParticipantAvatar $color={participant.color}>
                          {participant.avatarText}
                        </ParticipantAvatar>
                        <ParticipantName>{participant.label}</ParticipantName>
                        <ParticipantMeta>{participant.connected ? '在线' : '离线'}</ParticipantMeta>
                        <ParticipantAudioBadge $active={participant.audioEnabled}>
                          {participant.audioEnabled ? '已开麦' : '静音'}
                        </ParticipantAudioBadge>
                      </ParticipantCard>
                    ))}
                  </ParticipantGrid>
                </ParticipantStage>
              ) : null}

              <StageHint>
                <StageHintText>{stageHint}</StageHintText>
              </StageHint>

              {pickerOpen ? (
                <ShareStageOverlay>
                  <ShareStageCard>
                    <ShareStageHeader>
                      <ShareStageMeta>
                        <ShareStageTitle>选择共享源</ShareStageTitle>
                        <ShareStageDesc>
                          直接在会场区选择要共享的屏幕或窗口，确认后立即切换到共享画面。
                        </ShareStageDesc>
                        <ShareStageStatus>
                          房间 {middleEllipsis(roomInfo?.roomId || activeRoomId || '--', 22)} ·{' '}
                          {connectionLabel}
                        </ShareStageStatus>
                      </ShareStageMeta>
                      <ShareStageHeaderActions>
                        <GhostButton type="button" onClick={onCloseSharePopover}>
                          取消
                        </GhostButton>
                        <ControlButton
                          type="button"
                          $variant="primary"
                          onClick={onConfirmShareSource}
                          disabled={!pickerSelectedSourceId || pickerLoading}
                        >
                          开始共享
                        </ControlButton>
                        <ShareStageClose type="button" onClick={onCloseSharePopover}>
                          ×
                        </ShareStageClose>
                      </ShareStageHeaderActions>
                    </ShareStageHeader>

                    <ShareStageBody>
                      {pickerLoading ? (
                        <ShareStageStatus>正在加载共享源...</ShareStageStatus>
                      ) : pickerSources.length === 0 ? (
                        <ShareStageStatus>当前没有可用的共享源。</ShareStageStatus>
                      ) : (
                        <ShareSourcesGrid>
                          {pickerSources.map((source) => (
                            <ShareSourceCard
                              key={source.id}
                              type="button"
                              $selected={source.id === pickerSelectedSourceId}
                              onClick={() => onSelectShareSource(source.id)}
                            >
                              <ShareThumb>
                                {source.thumbnailDataUrl ? (
                                  <img src={source.thumbnailDataUrl} alt={source.name} />
                                ) : null}
                              </ShareThumb>
                              <ShareSourceName>{source.name}</ShareSourceName>
                              <ShareSourceMeta>
                                {source.type === 'screen' ? '屏幕' : '窗口'}
                              </ShareSourceMeta>
                            </ShareSourceCard>
                          ))}
                        </ShareSourcesGrid>
                      )}
                    </ShareStageBody>
                  </ShareStageCard>
                </ShareStageOverlay>
              ) : null}
            </StageFrame>
          </StageWrap>

          <ControlsBar>
            <ControlsBlock>
              <ControlButton
                type="button"
                $variant={microphoneEnabled ? 'primary' : 'muted'}
                onClick={onToggleMicrophone}
                disabled={microphoneState === 'requesting' || !canLeaveMeeting}
              >
                {microphoneLabel}
              </ControlButton>
            </ControlsBlock>

            <ControlsBlock $align="center">
              {canShowShareControls && !isSharing ? (
                <ControlButton
                  type="button"
                  $variant="primary"
                  onClick={onOpenSourcePicker}
                  disabled={!canLeaveMeeting}
                >
                  共享桌面
                </ControlButton>
              ) : null}
              {canShowShareControls && isSharing ? (
                <ControlButton type="button" $variant="danger" onClick={onStopSharing}>
                  停止共享
                </ControlButton>
              ) : null}
            </ControlsBlock>

            <ControlsBlock $align="flex-end">
              <MetaPill $accent={connectionLabel === '已连接'}>{connectionLabel}</MetaPill>
              <ControlButton
                type="button"
                $variant="secondary"
                onClick={onLeaveRoom}
                disabled={!canLeaveMeeting}
              >
                离开会议
              </ControlButton>
              {isRoomOwner ? (
                <ControlButton
                  type="button"
                  $variant="danger"
                  onClick={onCloseMeeting}
                  disabled={!canLeaveMeeting}
                >
                  结束会议
                </ControlButton>
              ) : null}
            </ControlsBlock>
          </ControlsBar>
        </StagePanel>

        <ChatPanel>
          <ChatHeader>
            <ChatTitle>会内聊天</ChatTitle>
            <ChatDescription>
              文字和图片消息仅在当前房间存活期间内同步，不做历史保存。
            </ChatDescription>
          </ChatHeader>

          <ChatScroll>
            {chatMessages.length === 0 ? (
              <EmptyChat>还没有会内消息。可以先发一条文字或图片。</EmptyChat>
            ) : (
              chatMessages.map((message) => {
                const isMine = Boolean(currentPeerId && message.senderPeerId === currentPeerId)
                const senderLabel = resolveMessageSenderLabel(message, participantCards)
                return (
                  <MessageRow key={message.messageId} $mine={isMine}>
                    <MessageBubble $mine={isMine}>
                      <MessageAuthor>{isMine ? '我' : senderLabel}</MessageAuthor>
                      {message.kind === 'image' && message.imageDataUrl ? (
                        <MessageImage
                          src={message.imageDataUrl}
                          alt="聊天图片"
                          onClick={() => setPreviewImageUrl(message.imageDataUrl)}
                        />
                      ) : null}
                      {message.text ? <MessageText>{message.text}</MessageText> : null}
                      <MessageTime $mine={isMine}>
                        {formatDateTime24(message.createdAt)}
                      </MessageTime>
                    </MessageBubble>
                  </MessageRow>
                )
              })
            )}
            <div ref={messageEndRef} />
          </ChatScroll>

          <ChatComposer>
            <ChatInput
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              onKeyDown={handleChatKeyDown}
              placeholder="输入消息，Enter 发送，Shift + Enter 换行。"
              disabled={!canLeaveMeeting}
            />
            <ChatComposerActions>
              <ChatActionGroup>
                <ComposerButton type="button" onClick={handlePickImage} disabled={!canLeaveMeeting}>
                  发送图片
                </ComposerButton>
                <HiddenFileInput
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                />
                <MetaPill>图片上限 2MB</MetaPill>
              </ChatActionGroup>
              <ComposerButton
                type="button"
                $primary
                onClick={handleSendText}
                disabled={!canLeaveMeeting || !draftText.trim()}
              >
                发送消息
              </ComposerButton>
            </ChatComposerActions>
          </ChatComposer>
        </ChatPanel>
      </Layout>

      {previewImageUrl ? (
        <ImagePreviewOverlay onClick={() => setPreviewImageUrl('')}>
          <ImagePreviewFrame
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              setPreviewImageUrl('')
            }}
          >
            <img src={previewImageUrl} alt="聊天图片预览" />
          </ImagePreviewFrame>
        </ImagePreviewOverlay>
      ) : null}
    </Page>
  )
}

MeetingPanel.propTypes = {
  titleBarHeight: PropTypes.number.isRequired,
  connectionLabel: PropTypes.string.isRequired,
  canLeaveMeeting: PropTypes.bool.isRequired,
  microphoneEnabled: PropTypes.bool.isRequired,
  microphoneState: PropTypes.string.isRequired,
  activeRoomId: PropTypes.string.isRequired,
  currentPeerId: PropTypes.string.isRequired,
  roomInfo: PropTypes.shape({
    roomId: PropTypes.string,
    role: PropTypes.string,
    hostPresent: PropTypes.bool,
    shareActive: PropTypes.bool,
    peerId: PropTypes.string,
    participants: PropTypes.arrayOf(
      PropTypes.shape({
        peerId: PropTypes.string.isRequired,
        role: PropTypes.string.isRequired,
        connected: PropTypes.bool.isRequired,
        audioEnabled: PropTypes.bool
      })
    )
  }),
  localVideoRef: PropTypes.shape({ current: PropTypes.any }).isRequired,
  remoteVideoRef: PropTypes.shape({ current: PropTypes.any }).isRequired,
  localPreviewStream: PropTypes.any,
  remotePreviewStream: PropTypes.any,
  isSharing: PropTypes.bool.isRequired,
  isHost: PropTypes.bool.isRequired,
  isRoomOwner: PropTypes.bool.isRequired,
  isViewer: PropTypes.bool.isRequired,
  pickerOpen: PropTypes.bool.isRequired,
  pickerLoading: PropTypes.bool.isRequired,
  pickerSources: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string.isRequired,
      type: PropTypes.string.isRequired,
      thumbnailDataUrl: PropTypes.string
    })
  ).isRequired,
  pickerSelectedSourceId: PropTypes.string.isRequired,
  chatMessages: PropTypes.arrayOf(
    PropTypes.shape({
      messageId: PropTypes.string.isRequired,
      senderPeerId: PropTypes.string.isRequired,
      senderRole: PropTypes.string.isRequired,
      kind: PropTypes.string.isRequired,
      text: PropTypes.string,
      imageDataUrl: PropTypes.string,
      createdAt: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired
    })
  ).isRequired,
  onLeaveRoom: PropTypes.func.isRequired,
  onCloseMeeting: PropTypes.func.isRequired,
  onOpenSourcePicker: PropTypes.func.isRequired,
  onStopSharing: PropTypes.func.isRequired,
  onToggleMicrophone: PropTypes.func.isRequired,
  onSelectShareSource: PropTypes.func.isRequired,
  onCloseSharePopover: PropTypes.func.isRequired,
  onConfirmShareSource: PropTypes.func.isRequired,
  onSendChatText: PropTypes.func.isRequired,
  onSendChatImage: PropTypes.func.isRequired
}

MeetingPanel.defaultProps = {
  roomInfo: null,
  localPreviewStream: null,
  remotePreviewStream: null
}

export default MeetingPanel
