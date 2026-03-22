import useSharedStore from '../store/sharedStore'

function QuestLogPage() {
  const message = useSharedStore((state) => state.message)

  return (
    <section className="page-grid">
      <article className="pixel-card pixel-card-large">
        <h1 className="page-title">Quest Log</h1>
        <p className="page-desc">A playful route for tracking current tasks.</p>
        <p className="state-line">Latest shared message: {message || '(empty)'}</p>
      </article>
      <article className="pixel-card">
        <h2 className="card-title">Today</h2>
        <p>1. Build route layout 2. Sync state 3. Polish theme interactions.</p>
      </article>
      <article className="pixel-card">
        <h2 className="card-title">Done Criteria</h2>
        <p>All windows reflect updates and selected theme persists locally.</p>
      </article>
    </section>
  )
}

export default QuestLogPage
