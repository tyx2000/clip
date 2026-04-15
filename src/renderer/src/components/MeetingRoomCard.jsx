import PropTypes from 'prop-types'
import styled from 'styled-components'
import { formatDateTime24, middleEllipsis } from '../utils/shareUtils'

const Card = styled.button`
  border: 1px solid var(--line-soft);
  border-radius: 5px;
  padding: 10px;
  background: var(--color-block-content);
  display: grid;
  gap: 10px;
  text-align: left;
  width: 100%;
  cursor: pointer;
  transition: border-color 140ms ease;

  &:hover {
    border-color: #bfd0ea;
  }
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
  gap: 6px;
`

const Pill = styled.span`
  border-radius: 5px;
  padding: 4px 8px;
  background: ${({ $active }) => ($active ? '#eef5ff' : '#f4f7fa')};
  color: ${({ $active }) => ($active ? '#1d4ed8' : 'var(--color-text-soft)')};
  font-size: 11px;
  white-space: nowrap;
`

function MeetingRoomCard({ item, onOpen }) {
  return (
    <Card type="button" onClick={() => onOpen(item)}>
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
  onOpen: PropTypes.func.isRequired
}

export default MeetingRoomCard
