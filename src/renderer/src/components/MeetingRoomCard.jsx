import PropTypes from 'prop-types'
import styled from 'styled-components'
import { formatDateTime24, middleEllipsis } from '../utils/shareUtils'

const Card = styled.article`
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  padding: 12px;
  background: var(--color-block-content);
  display: grid;
  gap: 12px;
`

const Header = styled.div`
  display: grid;
  gap: 6px;
`

const Title = styled.p`
  margin: 0;
  font-weight: 700;
  font-size: 13px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
`

const Meta = styled.p`
  margin: 0;
  font-size: 12px;
  color: var(--color-text-soft);
`

const Pills = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
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

const Actions = styled.div`
  display: flex;
  gap: 8px;
`

const Button = styled.button`
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  padding: 8px 10px;
  background: var(--color-block-input);
  color: var(--color-text);
  font-weight: 600;
  cursor: pointer;
  min-width: 88px;
`

const PrimaryButton = styled(Button)`
  border: none;
  background: var(--color-block-button);
  color: #ffffff;
`

function MeetingRoomCard({ item, onOpen, onDelete }) {
  return (
    <Card>
      <Header>
        <Title title={item.roomId}>{middleEllipsis(item.roomId, 26)}</Title>
        <Meta>
          创建时间 {formatDateTime24(item.createdAt || item.updatedAt || new Date().toISOString())}
        </Meta>
      </Header>

      <Pills>
        <Pill $active={Boolean(item.hostPresent)}>主持人 {item.hostPresent ? '在线' : '离线'}</Pill>
        <Pill $active={Boolean(item.shareActive)}>
          共享 {item.shareActive ? '进行中' : '未开始'}
        </Pill>
        <Pill>观众数 {Number(item.viewerCount || 0)}</Pill>
      </Pills>

      <Actions>
        <PrimaryButton type="button" onClick={() => onOpen(item)}>
          进入会议
        </PrimaryButton>
        <Button type="button" onClick={() => onDelete(item.roomId)}>
          删除
        </Button>
      </Actions>
    </Card>
  )
}

MeetingRoomCard.propTypes = {
  item: PropTypes.shape({
    roomId: PropTypes.string.isRequired,
    createdAt: PropTypes.string,
    updatedAt: PropTypes.string,
    hostPresent: PropTypes.bool,
    shareActive: PropTypes.bool,
    viewerCount: PropTypes.number
  }).isRequired,
  onOpen: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired
}

export default MeetingRoomCard
