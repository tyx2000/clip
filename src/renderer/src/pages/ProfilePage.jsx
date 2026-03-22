function ProfilePage() {
  return (
    <section className="page-grid">
      <article className="pixel-card pixel-card-large">
        <h1 className="page-title">Profile</h1>
        <p className="page-desc">Personal area for account and app identity information.</p>
        <div className="chip-row">
          <span className="pixel-chip">User: Pixel Guest</span>
          <span className="pixel-chip">Plan: Explorer</span>
          <span className="pixel-chip">Status: Online</span>
        </div>
      </article>
      <article className="pixel-card">
        <h2 className="card-title">Workspace</h2>
        <p>This view can later hold avatar, profile details, and preferences.</p>
      </article>
      <article className="pixel-card">
        <h2 className="card-title">Sync</h2>
        <p>Theme choice is persisted locally with a smooth animated switch.</p>
      </article>
    </section>
  )
}

export default ProfilePage
