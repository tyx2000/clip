import styled from 'styled-components'

export const PageGrid = styled.section`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;

  @media (max-width: 700px) {
    grid-template-columns: 1fr;
  }
`

export const PixelCard = styled.article`
  border-radius: 12px;
  background: var(--color-block-card);
  padding: 16px;
  border: 1px solid var(--line-soft);
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.04);
`

export const PixelCardLarge = styled(PixelCard)`
  grid-column: 1 / -1;
  background: var(--color-block-card-strong);
  display: grid;
  align-content: start;
`

export const PageTitle = styled.h1`
  margin: 0;
  font-size: 30px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.02em;

  @media (max-width: 700px) {
    font-size: 24px;
  }
`

export const PageDesc = styled.p`
  margin: 10px 0 16px;
  color: var(--color-text-soft);
  line-height: 1.6;
`

export const CardTitle = styled.h2`
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
`

export const StateLine = styled.p`
  margin: 8px 0;
`

export const ChipRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`

export const PixelChip = styled.span`
  border-radius: 999px;
  padding: 4px 10px;
  background: var(--color-block-chip);
  font-size: 12px;
  font-weight: 600;
`

export const ButtonRow = styled.div`
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
`

export const PixelButton = styled.button`
  border: none;
  border-radius: 9px;
  padding: 9px 14px;
  font-weight: 600;
  background: var(--color-block-button);
  color: var(--color-button-text);
  cursor: pointer;
  transition:
    transform 140ms ease,
    filter 140ms ease,
    box-shadow 140ms ease;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);

  &:hover {
    transform: translateY(-1px);
    filter: brightness(1.02);
  }

  &:disabled {
    opacity: 0.7;
    cursor: not-allowed;
  }
`

export const EditorRow = styled.div`
  margin-top: 12px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
`

export const PixelInput = styled.input`
  width: min(520px, 100%);
  border: 1px solid var(--line-soft);
  border-radius: 9px;
  padding: 10px 12px;
  background: var(--color-block-input);
  color: var(--color-text);
`
