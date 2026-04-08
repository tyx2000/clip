import PropTypes from 'prop-types'
import styled from 'styled-components'

const Page = styled.main`
  height: 100%;
  padding: 18px;
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 14px;
  background: linear-gradient(180deg, #edf4ff 0%, #f8fafc 100%);
`

const Card = styled.section`
  border-radius: 14px;
  border: 1px solid var(--line-soft);
  background: rgba(255, 255, 255, 0.92);
  padding: 16px;
`

const Header = styled.div`
  display: grid;
  gap: 6px;
`

const Title = styled.h1`
  margin: 0;
  font-size: 22px;
`

const Desc = styled.p`
  margin: 0;
  color: var(--color-text-soft);
  font-size: 13px;
`

const Status = styled.p`
  margin: 0;
  color: var(--color-text-soft);
  font-size: 12px;
`

const Grid = styled.div`
  display: grid;
  grid-template-columns: minmax(300px, 360px) 1fr;
  gap: 14px;

  @media (max-width: 960px) {
    grid-template-columns: 1fr;
  }
`

const LeftColumn = styled.div`
  display: grid;
  gap: 14px;
`

const RightColumn = styled.div`
  display: grid;
  gap: 14px;
`

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
`

const Input = styled.input`
  width: 100%;
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--color-block-input);
  color: var(--color-text);
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

const PrimaryButton = styled(Button)`
  border: none;
  background: var(--color-block-button);
  color: #ffffff;
`

const DangerButton = styled(Button)`
  border: none;
  background: #b42318;
  color: #ffffff;
`

const Pill = styled.span`
  border-radius: 999px;
  padding: 5px 9px;
  border: 1px solid var(--line-soft);
  background: ${({ $active }) => ($active ? '#eff6ff' : 'var(--color-block-input)')};
  color: ${({ $active }) => ($active ? '#1d4ed8' : 'var(--color-text-soft)')};
  font-size: 12px;
  white-space: nowrap;
`

const PreviewStage = styled.div`
  width: 100%;
  min-height: 420px;
  border-radius: 14px;
  overflow: hidden;
  background: #0f172a;
  border: 1px solid rgba(15, 23, 42, 0.12);
  position: relative;
`

const PreviewVideo = styled.video`
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #020617;
`

const EmptyState = styled.div`
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  text-align: center;
  padding: 28px;
  color: #bfdbfe;
  font-size: 14px;
  background: linear-gradient(180deg, rgba(30, 41, 59, 0.26), rgba(15, 23, 42, 0.78));
`

function MeetingPanel({
  roomState,
  shareState,
  connectionLabel,
  microphoneEnabled,
  microphoneState,
  statusMessage,
  roomInfo,
  joinRoomId,
  setJoinRoomId,
  localVideoRef,
  remoteVideoRef,
  isJoined,
  isSharing,
  isHost,
  isViewer,
  onCreateRoom,
  onJoinRoom,
  onLeaveRoom,
  onOpenSourcePicker,
  onStopSharing,
  onCopyRoomId,
  onToggleMicrophone
}) {
  const isBusy =
    roomState === 'creating' ||
    roomState === 'joining' ||
    shareState === 'starting' ||
    connectionLabel === '连接中'

  let previewText = '创建或加入会议后，可在这里查看共享桌面。'
  if (isHost && isSharing) {
    previewText = '正在发送你的桌面画面。'
  } else if (isHost) {
    previewText = '语音通话已就绪，点击“共享桌面”后选择要共享的屏幕或窗口。'
  } else if (isViewer && roomInfo?.shareActive) {
    previewText = '主持人正在共享桌面，正在连接画面...'
  } else if (isViewer && roomInfo?.hostPresent) {
    previewText = '已加入会议，当前只有语音通话，等待主持人开始共享。'
  } else if (isViewer) {
    previewText = '主持人暂未在线。'
  }

  const microphoneLabel =
    microphoneState === 'requesting'
      ? '麦克风连接中'
      : microphoneEnabled
        ? '麦克风开启'
        : '麦克风关闭'

  return (
    <Page>
      <Card>
        <Header>
          <Title>会议</Title>
          <Desc>会议窗口默认准备语音通话，你可以在加入后随时开启桌面共享。</Desc>
          <Status>{statusMessage}</Status>
        </Header>
      </Card>

      <Grid>
        <LeftColumn>
          <Card>
            <Header>
              <Title as="h2">会议房间</Title>
              <Desc>创建房间后，把房间号发给另一端 Electron 应用即可加入。</Desc>
            </Header>
            <Row>
              <PrimaryButton type="button" onClick={onCreateRoom} disabled={isBusy || isJoined}>
                {roomState === 'creating' ? '创建中...' : '创建会议'}
              </PrimaryButton>
              <Button
                type="button"
                onClick={onCopyRoomId}
                disabled={!roomInfo?.roomId || !isJoined}
              >
                复制房间号
              </Button>
            </Row>
            <Row>
              <Input
                value={joinRoomId}
                onChange={(event) => setJoinRoomId(event.target.value)}
                placeholder="输入房间号后加入会议"
                disabled={isBusy || isJoined}
              />
            </Row>
            <Row>
              <Button type="button" onClick={onJoinRoom} disabled={isBusy || isJoined}>
                {roomState === 'joining' ? '加入中...' : '加入会议'}
              </Button>
              <Button type="button" onClick={onLeaveRoom} disabled={!isJoined}>
                离开会议
              </Button>
            </Row>
          </Card>

          <Card>
            <Header>
              <Title as="h2">会议状态</Title>
              <Desc>语音与共享状态都集中在这里。</Desc>
            </Header>
            <Row>
              <Pill $active={Boolean(roomInfo?.roomId)}>房间号 {roomInfo?.roomId || '--'}</Pill>
              <Pill $active={isJoined}>角色 {isHost ? '主持人' : isViewer ? '观众' : '--'}</Pill>
              <Pill $active={connectionLabel === '已连接'}>{connectionLabel}</Pill>
            </Row>
            <Row>
              <Pill $active={microphoneEnabled}>{microphoneLabel}</Pill>
              <Pill $active={Boolean(roomInfo?.hostPresent)}>
                主持人 {roomInfo?.hostPresent ? '在线' : '离线'}
              </Pill>
              <Pill $active={Boolean(roomInfo?.shareActive)}>
                桌面共享 {roomInfo?.shareActive ? '进行中' : '未开始'}
              </Pill>
            </Row>
            <Row>
              <Pill>
                参会人数{' '}
                {isHost ? Number(roomInfo?.viewerCount || 0) + 1 : roomInfo?.roomId ? 2 : 0}
              </Pill>
            </Row>
          </Card>

          <Card>
            <Header>
              <Title as="h2">会议控制</Title>
              <Desc>默认连麦，可随时静音或发起桌面共享。</Desc>
            </Header>
            <Row>
              <PrimaryButton
                type="button"
                onClick={onToggleMicrophone}
                disabled={microphoneState === 'requesting'}
              >
                {microphoneEnabled ? '关闭麦克风' : '开启麦克风'}
              </PrimaryButton>
              {isHost && !isSharing ? (
                <Button type="button" onClick={onOpenSourcePicker} disabled={!isJoined || isBusy}>
                  共享桌面
                </Button>
              ) : null}
              {isHost && isSharing ? (
                <DangerButton type="button" onClick={onStopSharing} disabled={isBusy}>
                  停止共享
                </DangerButton>
              ) : null}
            </Row>
          </Card>
        </LeftColumn>

        <RightColumn>
          <Card>
            <Header>
              <Title as="h2">会议画面</Title>
              <Desc>
                {isHost ? '主持人可看到本地共享预览。' : '观众可在这里查看主持人的共享桌面。'}
              </Desc>
            </Header>
            <PreviewStage>
              <PreviewVideo
                ref={isHost ? localVideoRef : remoteVideoRef}
                muted={isHost}
                playsInline
                autoPlay
              />
              {(!isHost && !roomInfo?.shareActive) || (isHost && !isSharing) ? (
                <EmptyState>{previewText}</EmptyState>
              ) : null}
            </PreviewStage>
          </Card>
        </RightColumn>
      </Grid>
    </Page>
  )
}

MeetingPanel.propTypes = {
  roomState: PropTypes.string.isRequired,
  shareState: PropTypes.string.isRequired,
  connectionLabel: PropTypes.string.isRequired,
  microphoneEnabled: PropTypes.bool.isRequired,
  microphoneState: PropTypes.string.isRequired,
  statusMessage: PropTypes.string.isRequired,
  roomInfo: PropTypes.shape({
    roomId: PropTypes.string,
    role: PropTypes.string,
    viewerCount: PropTypes.number,
    hostPresent: PropTypes.bool,
    shareActive: PropTypes.bool
  }),
  joinRoomId: PropTypes.string.isRequired,
  setJoinRoomId: PropTypes.func.isRequired,
  localVideoRef: PropTypes.shape({ current: PropTypes.any }).isRequired,
  remoteVideoRef: PropTypes.shape({ current: PropTypes.any }).isRequired,
  isJoined: PropTypes.bool.isRequired,
  isSharing: PropTypes.bool.isRequired,
  isHost: PropTypes.bool.isRequired,
  isViewer: PropTypes.bool.isRequired,
  onCreateRoom: PropTypes.func.isRequired,
  onJoinRoom: PropTypes.func.isRequired,
  onLeaveRoom: PropTypes.func.isRequired,
  onOpenSourcePicker: PropTypes.func.isRequired,
  onStopSharing: PropTypes.func.isRequired,
  onCopyRoomId: PropTypes.func.isRequired,
  onToggleMicrophone: PropTypes.func.isRequired
}

export default MeetingPanel
