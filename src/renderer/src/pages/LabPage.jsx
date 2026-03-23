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

function LabPage() {
  const count = useSharedStore((state) => state.count)
  const message = useSharedStore((state) => state.message)

  return (
    <PageGrid>
      <PixelCardLarge>
        <PageTitle>Lab</PageTitle>
        <PageDesc>Route for testing IPC calls and shared-state reactions.</PageDesc>
        <ChipRow>
          <PixelChip>Counter: {count}</PixelChip>
          <PixelChip>Message length: {message.length}</PixelChip>
        </ChipRow>
      </PixelCardLarge>
      <PixelCard>
        <CardTitle>IPC Path</CardTitle>
        <p>
          Renderer {'->'} preload API {'->'} ipcMain {'->'} persistent state {'->'} broadcast.
        </p>
      </PixelCard>
      <PixelCard>
        <CardTitle>Window Scope</CardTitle>
        <p>All opened windows subscribe to shared-state updates.</p>
      </PixelCard>
    </PageGrid>
  )
}

export default LabPage
