import PropTypes from 'prop-types'
import styled from 'styled-components'

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.56);
`

const Dialog = styled.section`
  width: min(360px, 100%);
  display: grid;
  gap: 14px;
  border: 1px solid #303743;
  border-radius: 12px;
  padding: 16px;
  background: #171c23;
  color: #f5f7fb;
  box-shadow: 0 24px 72px rgba(0, 0, 0, 0.44);
`

const Title = styled.h2`
  margin: 0;
  font-size: 15px;
`

const FieldGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
`

const Field = styled.label`
  display: grid;
  gap: 6px;
  color: #a9b2c0;
  font-size: 12px;
`

const Input = styled.input`
  width: 100%;
  height: 32px;
  border: 1px solid #303743;
  border-radius: 7px;
  padding: 0 8px;
  background: #11161d;
  color: #f5f7fb;
`

const Actions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
`

const Button = styled.button`
  height: 30px;
  border: 1px solid ${({ $primary }) => ($primary ? '#2f7df6' : '#303743')};
  border-radius: 7px;
  padding: 0 12px;
  background: ${({ $primary }) => ($primary ? '#2f7df6' : '#20252d')};
  color: #f5f7fb;
  font-weight: 700;
  cursor: pointer;
`

export function ExportDialog({ exportSettings, onCancel, onConfirm, setExportSettings }) {
  return (
    <Backdrop role="presentation" onMouseDown={onCancel}>
      <Dialog
        role="dialog"
        aria-modal="true"
        aria-label="导出配置"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <Title>导出配置</Title>
        <FieldGrid>
          <Field>
            FPS
            <Input
              type="number"
              min="1"
              max="60"
              value={exportSettings.fps}
              onChange={(event) =>
                setExportSettings((settings) => ({
                  ...settings,
                  fps: Number(event.target.value) || 30
                }))
              }
            />
          </Field>
          <Field>
            Mbps
            <Input
              type="number"
              min="1"
              value={Math.round(exportSettings.bitrate / 1_000_000)}
              onChange={(event) =>
                setExportSettings((settings) => ({
                  ...settings,
                  bitrate: Math.max(1, Number(event.target.value) || 4) * 1_000_000
                }))
              }
            />
          </Field>
        </FieldGrid>
        <Actions>
          <Button type="button" onClick={onCancel}>
            取消
          </Button>
          <Button type="button" $primary onClick={onConfirm}>
            开始导出
          </Button>
        </Actions>
      </Dialog>
    </Backdrop>
  )
}

ExportDialog.propTypes = {
  exportSettings: PropTypes.shape({
    bitrate: PropTypes.number.isRequired,
    fps: PropTypes.number.isRequired
  }).isRequired,
  onCancel: PropTypes.func.isRequired,
  onConfirm: PropTypes.func.isRequired,
  setExportSettings: PropTypes.func.isRequired
}
