import {
  CardTitle,
  PageDesc,
  PageGrid,
  PageTitle,
  PixelCard,
  PixelCardLarge,
  StateLine
} from '../styles/primitives'
import useSharedStore from '../store/sharedStore'

function QuestLogPage() {
  const message = useSharedStore((state) => state.message)

  return (
    <PageGrid>
      <PixelCardLarge>
        <PageTitle>Quest Log</PageTitle>
        <PageDesc>A playful route for tracking current tasks.</PageDesc>
        <StateLine>Latest shared message: {message || '(empty)'}</StateLine>
      </PixelCardLarge>
      <PixelCard>
        <CardTitle>Today</CardTitle>
        <p>1. Build route layout 2. Sync state 3. Polish theme interactions.</p>
      </PixelCard>
      <PixelCard>
        <CardTitle>Done Criteria</CardTitle>
        <p>All windows reflect updates and selected theme persists locally.</p>
      </PixelCard>
    </PageGrid>
  )
}

export default QuestLogPage
