// Lightweight error tracking + anonymous usage counters.
// Nothing here can break the call: sending is fire-and-forget and bounded.

type EventProps = Record<string, string | number | boolean>

interface TelemetryPayload {
  type: 'error' | 'event'
  name: string
  message?: string
  stack?: string
  props?: EventProps
  ts: number
  sessionId: string
  url: string // path only - never the room name or query string
}

const MAX_PER_SESSION = 40
const DEDUPE_MS = 4000

let sessionId = ''
let sentCount = 0
const lastSent = new Map<string, number>()

function getSessionId() {
  if (sessionId) return sessionId
  try {
    const stored = window.sessionStorage.getItem('meetup:session')
    if (stored) {
      sessionId = stored
    } else {
      sessionId = Math.random().toString(36).slice(2, 10)
      window.sessionStorage.setItem('meetup:session', sessionId)
    }
  } catch {
    sessionId = Math.random().toString(36).slice(2, 10)
  }
  return sessionId
}

function send(payload: TelemetryPayload) {
  if (sentCount >= MAX_PER_SESSION) return
  const key = `${payload.type}:${payload.name}`
  const now = Date.now()
  if (now - (lastSent.get(key) ?? 0) < DEDUPE_MS) return

  lastSent.set(key, now)
  sentCount += 1

  try {
    void fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Offline or blocked telemetry must never affect the meeting
  }
}

export function trackEvent(name: string, props: EventProps = {}) {
  send({
    type: 'event',
    name,
    props,
    ts: Date.now(),
    sessionId: getSessionId(),
    url: window.location.pathname,
  })
}

export function captureError(error: unknown, context?: string) {
  const err = error instanceof Error ? error : new Error(String(error))
  send({
    type: 'error',
    name: (context || 'uncaught-error').slice(0, 80),
    message: err.message.slice(0, 500),
    stack: (err.stack || '').slice(0, 2000),
    ts: Date.now(),
    sessionId: getSessionId(),
    url: window.location.pathname,
  })
}

let initialized = false

export function initTelemetry() {
  if (initialized || typeof window === 'undefined') return
  initialized = true

  window.addEventListener('error', (event) => {
    captureError(event.error || event.message, 'window-error')
  })
  window.addEventListener('unhandledrejection', (event) => {
    captureError(event.reason, 'unhandled-rejection')
  })
}
