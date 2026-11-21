import { useEffect } from 'react'
import type { MeetingReport } from '../lib/meetingReport'
import { downloadReport, formatDuration } from '../lib/meetingReport'

interface Props {
  live: MeetingReport | null
  past: MeetingReport[]
  onClose: () => void
}

function Summary({ report }: { report: MeetingReport }) {
  const duration = Math.max(0, report.endedAt - report.startedAt)
  const items = [
    ['Duration', formatDuration(duration)],
    ['Participants', String(report.participants.length || report.counts.join || 0)],
    ['Messages', String(report.counts.message || 0)],
    ['Reactions', String(report.counts.reaction || 0)],
    ['Hands raised', String(report.counts.hand || 0)],
    ['Screen shares', String(report.counts['screen-share'] || 0)],
  ]

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-lg bg-primary-50 px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-primary-600">{label}</div>
          <div className="text-base font-semibold text-gray-900">{value}</div>
        </div>
      ))}
    </div>
  )
}

function ReportCard({ report, label }: { report: MeetingReport; label?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-gray-900">{report.roomName}</div>
          <div className="text-xs text-gray-500">
            {label || new Date(report.startedAt).toLocaleString()}
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-primary-100 px-2 py-0.5 text-[11px] font-medium text-primary-700">
          {formatDuration(report.endedAt - report.startedAt)}
        </span>
      </div>
      <div className="mt-2">
        <Summary report={report} />
      </div>
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => downloadReport(report, 'json')}
          className="flex-1 rounded-lg bg-primary-50 px-2 py-1.5 text-xs font-medium text-primary-700 hover:bg-primary-100"
        >
          Download JSON
        </button>
        <button
          onClick={() => downloadReport(report, 'csv')}
          className="flex-1 rounded-lg bg-primary-50 px-2 py-1.5 text-xs font-medium text-primary-700 hover:bg-primary-100"
        >
          Download CSV
        </button>
      </div>
    </div>
  )
}

export default function MeetingReportModal({ live, past, onClose }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Meeting report</h2>
            <p className="text-xs text-gray-500">Saved on this device only · no message text included</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close report"
            className="rounded-full p-1.5 text-gray-500 hover:bg-gray-100"
          >
            ✕
          </button>
        </div>

        {live && (
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-800">Current meeting</h3>
            <ReportCard report={live} label="In progress" />
            {live.activity.length > 0 && (
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Activity
                </h4>
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg bg-gray-50 p-2">
                  {live.activity.slice(-30).reverse().map((entry, index) => (
                    <div key={`${entry.at}-${index}`} className="flex gap-2 text-xs text-gray-600">
                      <span className="shrink-0 text-gray-400">
                        {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span className="truncate">
                        <span className="font-medium text-gray-800">{entry.type}</span>
                        {entry.name ? ` · ${entry.name}` : ''}
                        {entry.detail ? ` · ${entry.detail}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {past.length > 0 && (
          <section className="mt-5 space-y-2">
            <h3 className="text-sm font-semibold text-gray-800">Past meetings</h3>
            {past.map((report) => (
              <ReportCard key={report.id} report={report} />
            ))}
          </section>
        )}

        {!live && past.length === 0 && (
          <p className="py-6 text-center text-sm text-gray-500">
            No meetings recorded yet on this device.
          </p>
        )}
      </div>
    </div>
  )
}
