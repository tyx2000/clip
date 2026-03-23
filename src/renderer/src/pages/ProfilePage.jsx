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

function ProfilePage() {
  return (
    <PageGrid>
      <PixelCardLarge>
        <PageTitle>Profile</PageTitle>
        <PageDesc>Personal area for account and app identity information.</PageDesc>
        <ChipRow>
          <PixelChip>User: Pixel Guest</PixelChip>
          <PixelChip>Plan: Explorer</PixelChip>
          <PixelChip>Status: Online</PixelChip>
        </ChipRow>
      </PixelCardLarge>
      <PixelCard>
        <CardTitle>Workspace</CardTitle>
        <p>This view can later hold avatar, profile details, and preferences.</p>
      </PixelCard>
      <PixelCard>
        <CardTitle>Sync</CardTitle>
        <p>Theme choice is persisted locally with a smooth animated switch.</p>
      </PixelCard>
    </PageGrid>
  )
}

export default ProfilePage
