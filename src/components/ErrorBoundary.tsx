import React from 'react'
import { captureError } from '../lib/telemetry'

interface Props {
  children: React.ReactNode
}

interface State {
  failed: boolean
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error) {
    captureError(error, 'react-render')
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-primary-600 to-primary-900 flex items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-2xl">
            <div className="text-4xl mb-3">😕</div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">Something went wrong</h1>
            <p className="text-sm text-gray-600 mb-5">
              Meetup hit an unexpected error. Reloading usually gets you back into the room.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="w-full rounded-lg bg-primary-600 px-4 py-3 font-semibold text-white hover:bg-primary-700"
            >
              Reload Meetup
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
