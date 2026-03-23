import {
  CardTitle,
  ChipRow,
  PageDesc,
  PageGrid,
  PageTitle,
  PixelCard,
  PixelCardLarge,
  PixelChip
} from '../styles/primitives'
import useSharedStore from '../store/sharedStore'

function PixelBoardPage() {
  const count = useSharedStore((state) => state.count)

  return (
    <PageGrid>
      <PixelCardLarge>
        <PageTitle>Pixel Board</PageTitle>
        <PageDesc>A bright board for quick visual notes and tiny widgets.</PageDesc>
        <ChipRow>
          <PixelChip>Blocks: 12</PixelChip>
          <PixelChip>Shared count: {count}</PixelChip>
          <PixelChip>Mode: creative</PixelChip>
        </ChipRow>
      </PixelCardLarge>
      <PixelCard>
        <CardTitle>Sticker Area</CardTitle>
        <p>Use this route for mini dashboard experiments.</p>
      </PixelCard>
      <PixelCard>
        <CardTitle>Focus Hint</CardTitle>
        <p>Keep large cards for context and small cards for details.</p>
      </PixelCard>
    </PageGrid>
  )
}

export default PixelBoardPage
