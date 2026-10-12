import React, { Component, type ErrorInfo, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'

class BootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Eris UI crashed', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="welcome" style={{ padding: 24, textAlign: 'center' }}>
          <h1>Eris hit a UI error</h1>
          <p style={{ color: '#9a9ba3', maxWidth: 480, margin: '12px auto' }}>
            {this.state.error.message}
          </p>
          <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BootErrorBoundary>
      <App />
    </BootErrorBoundary>
  </React.StrictMode>
)
