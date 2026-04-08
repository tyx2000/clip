import styled from 'styled-components'
import PropTypes from 'prop-types'

const PickerOverlay = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.38);
  display: grid;
  place-items: center;
  padding: 20px;
  z-index: 1200;
`

const PickerDialog = styled.section`
  width: min(1000px, 100%);
  max-height: min(78vh, 860px);
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid var(--line-soft);
  background: var(--color-block-card);
  display: grid;
  grid-template-rows: auto 1fr;
`

const PickerHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 14px;
  border-bottom: 1px solid var(--line-soft);
  background: var(--color-block-card);
`

const PickerHeaderMeta = styled.div`
  display: grid;
  gap: 4px;
`

const PickerTitle = styled.h3`
  margin: 0;
  font-size: 17px;
`

const PickerDesc = styled.p`
  margin: 0;
  font-size: 12px;
  color: var(--color-text-soft);
`

const PickerHeaderActions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
`

const SyncToggleLabel = styled.label`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-soft);
  user-select: none;
`

const SyncToggle = styled.input`
  margin: 0;
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

const ConfirmButton = styled(Button)`
  border: none;
  background: var(--color-block-button);
  color: #ffffff;
`

const PickerBody = styled.div`
  overflow: auto;
  padding: 14px;
`

const PickerSourcesGridWrap = styled.div`
  min-height: 320px;
  display: grid;
  place-items: ${({ $hasItems }) => ($hasItems ? 'stretch' : 'center')};
`

const StateText = styled.p`
  margin: 0;
  font-size: 13px;
  color: var(--color-text-soft);
  text-align: center;
`

const PickerGrid = styled.div`
  width: 100%;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  align-items: start;
  gap: 12px;
`

const PickerItem = styled.button`
  border: ${({ $selected }) => ($selected ? '2px solid #1d4ed8' : '1px solid var(--line-soft)')};
  border-radius: 10px;
  background: ${({ $selected }) => ($selected ? '#eaf1ff' : 'var(--color-block-content)')};
  padding: 10px;
  text-align: left;
  cursor: pointer;
  display: grid;
  gap: 8px;
  box-shadow: ${({ $selected }) => ($selected ? '0 0 0 3px rgba(37, 99, 235, 0.22)' : 'none')};
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease,
    background 0.16s ease;

  &:hover {
    border-color: #3b82f6;
  }
`

const PickerThumb = styled.div`
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 8px;
  background: #111827;
  border: 1px solid var(--line-soft);
  overflow: hidden;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
`

const PickerName = styled.p`
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: ${({ $selected }) => ($selected ? '#1e3a8a' : 'var(--color-text)')};
`

const PickerMeta = styled.p`
  margin: 0;
  font-size: 12px;
  color: var(--color-text-soft);
`

function SourcePickerModal({
  open,
  loading,
  sources,
  selectedSourceId,
  cloudSyncEnabled,
  showCloudSyncToggle = true,
  isBusy,
  title = '选择共享源',
  description = '请选择要共享的屏幕或应用窗口，然后点击“确定开始”。',
  confirmLabel = '确定开始',
  onSelect,
  onToggleCloudSync,
  onCancel,
  onConfirm
}) {
  if (!open) {
    return null
  }

  const hasItems = !loading && sources.length > 0

  return (
    <PickerOverlay>
      <PickerDialog role="dialog" aria-modal="true" aria-label={title}>
        <PickerHeader>
          <PickerHeaderMeta>
            <PickerTitle>{title}</PickerTitle>
            <PickerDesc>{description}</PickerDesc>
          </PickerHeaderMeta>

          <PickerHeaderActions>
            {showCloudSyncToggle ? (
              <SyncToggleLabel>
                <SyncToggle
                  type="checkbox"
                  checked={cloudSyncEnabled}
                  onChange={(event) => onToggleCloudSync(event.target.checked)}
                  disabled={isBusy}
                />
                云端同步
              </SyncToggleLabel>
            ) : null}
            <Button type="button" onClick={onCancel} disabled={isBusy}>
              取消
            </Button>
            <ConfirmButton
              type="button"
              onClick={onConfirm}
              disabled={!selectedSourceId || loading || isBusy}
            >
              {confirmLabel}
            </ConfirmButton>
          </PickerHeaderActions>
        </PickerHeader>

        <PickerBody>
          <PickerSourcesGridWrap $hasItems={hasItems}>
            {loading ? (
              <StateText>正在加载共享源...</StateText>
            ) : sources.length === 0 ? (
              <StateText>没有可用共享源。</StateText>
            ) : (
              <PickerGrid>
                {sources.map((source) => (
                  <PickerItem
                    key={source.id}
                    type="button"
                    $selected={source.id === selectedSourceId}
                    onClick={() => onSelect(source.id)}
                  >
                    <PickerThumb>
                      {source.thumbnailDataUrl ? (
                        <img src={source.thumbnailDataUrl} alt={source.name} />
                      ) : null}
                    </PickerThumb>
                    <PickerName $selected={source.id === selectedSourceId}>
                      {source.name}
                    </PickerName>
                    <PickerMeta>{source.type === 'screen' ? '屏幕' : '窗口'}</PickerMeta>
                  </PickerItem>
                ))}
              </PickerGrid>
            )}
          </PickerSourcesGridWrap>
        </PickerBody>
      </PickerDialog>
    </PickerOverlay>
  )
}

SourcePickerModal.propTypes = {
  open: PropTypes.bool.isRequired,
  loading: PropTypes.bool.isRequired,
  sources: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string.isRequired,
      type: PropTypes.oneOf(['screen', 'window']).isRequired,
      thumbnailDataUrl: PropTypes.string
    })
  ).isRequired,
  selectedSourceId: PropTypes.string.isRequired,
  cloudSyncEnabled: PropTypes.bool.isRequired,
  showCloudSyncToggle: PropTypes.bool,
  isBusy: PropTypes.bool.isRequired,
  title: PropTypes.string,
  description: PropTypes.string,
  confirmLabel: PropTypes.string,
  onSelect: PropTypes.func.isRequired,
  onToggleCloudSync: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
  onConfirm: PropTypes.func.isRequired
}

export default SourcePickerModal
