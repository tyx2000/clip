import useSharedStore from '../store/sharedStore'

function PixelBoardPage() {
  const count = useSharedStore((state) => state.count)

  return (
    <section className="page-grid">
      <article className="pixel-card pixel-card-large">
        <h1 className="page-title">Pixel Board</h1>
        <p className="page-desc">A bright board for quick visual notes and tiny widgets.</p>
        <div className="chip-row">
          <span className="pixel-chip">Blocks: 12</span>
          <span className="pixel-chip">Shared count: {count}</span>
          <span className="pixel-chip">Mode: creative</span>
        </div>
      </article>
      <article className="pixel-card">
        <h2 className="card-title">Sticker Area</h2>
        <p>Use this route for mini dashboard experiments.</p>
      </article>
      <article className="pixel-card">
        <h2 className="card-title">Focus Hint</h2>
        <p>Keep large cards for context and small cards for details.</p>
      </article>
    </section>
  )
}

export default PixelBoardPage
