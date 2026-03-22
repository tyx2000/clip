import useSharedStore from '../store/sharedStore'

function LabPage() {
  const count = useSharedStore((state) => state.count)
  const message = useSharedStore((state) => state.message)

  return (
    <section className="page-grid">
      <article className="pixel-card pixel-card-large">
        <h1 className="page-title">Lab</h1>
        <p className="page-desc">Route for testing IPC calls and shared-state reactions.</p>
        <div className="chip-row">
          <span className="pixel-chip">Counter: {count}</span>
          <span className="pixel-chip">Message length: {message.length}</span>
        </div>
      </article>
      <article className="pixel-card">
        <h2 className="card-title">IPC Path</h2>
        <p>
          Renderer {'->'} preload API {'->'} ipcMain {'->'} persistent state {'->'} broadcast.
        </p>
      </article>
      <article className="pixel-card">
        <h2 className="card-title">Window Scope</h2>
        <p>All opened windows subscribe to shared-state updates.</p>
      </article>
    </section>
  )
}

export default LabPage
