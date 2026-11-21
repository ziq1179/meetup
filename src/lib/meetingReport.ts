// Meeting activity reports are kept on the device that hosted the meeting.
// Only metadata is stored - chat message bodies are never saved.

export type ActivityType = 'join' | 'leave' | 'message' | 'reaction' | 'hand' | 'screen-share'

export interface ActivityEntry {
  at: number
  type: ActivityType
  name?: string
  detail?: string
}

export interface MeetingReport {
  id: string
  roomName: string
  startedAt: number
  endedAt: number
  host: boolean
  participants: string[]
  activity: ActivityEntry[]
  counts: Record<string, number>
}

const STORAGE_KEY = 'meetup:meeting-reports'
const MAX_REPORTS = 20

export function countActivity(activity: ActivityEntry[]) {
  const counts: Record<string, number> = {}
  for (const entry of activity) {
    counts[entry.type] = (counts[entry.type] || 0) + 1
  }
  return counts
}

export function loadReports(): MeetingReport[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as MeetingReport[]) : []
  } catch {
    return []
  }
}

export function saveReport(report: MeetingReport) {
  try {
    const reports = [report, ...loadReports()].slice(0, MAX_REPORTS)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reports))
  } catch {
    // Private mode or full storage - reports are best effort only
  }
}

export function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m`
  }
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

export function downloadReport(report: MeetingReport, format: 'json' | 'csv') {
  let content: string
  let mime: string
  let extension: string

  if (format === 'json') {
    content = JSON.stringify(report, null, 2)
    mime = 'application/json'
    extension = 'json'
  } else {
    const escape = (value: unknown) => {
      const text = value === undefined || value === null ? '' : String(value)
      return `"${text.replace(/"/g, '""')}"`
    }
    const rows = [
      ['time', 'event', 'name', 'detail'],
      ...report.activity.map((entry) => [
        new Date(entry.at).toISOString(),
        entry.type,
        entry.name || '',
        entry.detail || '',
      ]),
    ]
    content = rows.map((row) => row.map(escape).join(',')).join('\r\n')
    mime = 'text/csv'
    extension = 'csv'
  }

  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `meetup-${report.roomName}-${new Date(report.endedAt).toISOString().slice(0, 10)}.${extension}`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
