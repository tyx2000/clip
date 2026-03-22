import { useEffect, useState } from 'react'
import useSharedStore from '../store/sharedStore'

function HomePage() {
  const count = useSharedStore((state) => state.count)
  const message = useSharedStore((state) => state.message)
  const hydrated = useSharedStore((state) => state.hydrated)
  const setMessage = useSharedStore((state) => state.setMessage)
  const increment = useSharedStore((state) => state.increment)

  const [draftMessage, setDraftMessage] = useState('')
  const [pingResult, setPingResult] = useState('')
  const [notifyResult, setNotifyResult] = useState('')

  useEffect(() => {
    setDraftMessage(message)
  }, [message])

  const handlePing = async () => {
    const result = await window.api.ping()
    setPingResult(`${result.message} @ ${result.timestamp}`)
  }

  const handleSendNotification = async () => {
    const result = await window.api.sendSystemNotification({
      title: 'Pixel Hub',
      body: 'Home page triggered a desktop notification.'
    })
    setNotifyResult(result?.message || 'Notification request finished.')
  }

  return (
    <section className="page-grid page-home">
      <article className="pixel-card pixel-card-large">
        <header className="home-header">
          <h1 className="page-title">Home Dashboard</h1>
          <p className="page-desc">Zustand + Electron IPC multi-window shared state.</p>
        </header>

        <section className="home-stats-grid">
          <article className="home-stat-card">
            <p className="home-stat-label">Shared Count</p>
            <p className="home-stat-value">{hydrated ? count : 'loading...'}</p>
          </article>
          <article className="home-stat-card">
            <p className="home-stat-label">Shared Message</p>
            <p className="home-stat-value home-stat-value-message">
              {hydrated ? message || '(empty)' : 'loading...'}
            </p>
          </article>
          <article className="home-stat-card">
            <p className="home-stat-label">IPC Ping</p>
            <p className="home-stat-value home-stat-value-message">{pingResult || '-'}</p>
          </article>
          <article className="home-stat-card">
            <p className="home-stat-label">Notification</p>
            <p className="home-stat-value home-stat-value-message">{notifyResult || '-'}</p>
          </article>
        </section>

        <section className="home-actions">
          <div className="button-row">
            <button className="pixel-btn" onClick={() => increment(1)}>
              Count +1
            </button>
            <button className="pixel-btn" onClick={() => window.api.createWindow()}>
              Open New Window
            </button>
            <button className="pixel-btn" onClick={handlePing}>
              Call IPC Ping
            </button>
            <button className="pixel-btn" onClick={handleSendNotification}>
              Send System Notification
            </button>
          </div>
        </section>

        <section className="home-editor">
          <p className="home-editor-label">Message Editor</p>
          <div className="editor-row">
            <input
              className="pixel-input"
              value={draftMessage}
              onChange={(event) => setDraftMessage(event.target.value)}
              placeholder="Type shared message"
            />
            <button className="pixel-btn" onClick={() => setMessage(draftMessage)}>
              Sync Message
            </button>
          </div>
        </section>
      </article>

      <article className="pixel-card">
        <h2 className="card-title">Sync Rules</h2>
        <p>Changes are sent to main process by IPC and broadcast to all opened windows.</p>
      </article>
      <article className="pixel-card">
        <h2 className="card-title">Persistence</h2>
        <p>Shared state is saved under Electron userData and restored on next launch.</p>
      </article>
    </section>
  )
}

export default HomePage
