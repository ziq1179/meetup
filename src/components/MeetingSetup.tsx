import { useState } from 'react'
import InstallPrompt from './InstallPrompt'
import { trackEvent } from '../lib/telemetry'

interface MeetingSetupProps {
  onJoin: (roomName: string, userName: string, audioOnly: boolean) => void
  initialRoomName?: string
}

export default function MeetingSetup({ onJoin, initialRoomName = '' }: MeetingSetupProps) {
  const [roomName, setRoomName] = useState(initialRoomName)
  const [userName, setUserName] = useState('')
  const [audioOnly, setAudioOnly] = useState(false)

  const generateRoomName = () => {
    // Generate a more unique room name to ensure you're the first participant
    // This helps avoid "waiting for moderator" issues on public instances
    const timestamp = Date.now().toString(36)
    const randomId = Math.random().toString(36).substring(2, 9)
    setRoomName(`${randomId}${timestamp}`)
    trackEvent('room_generated')
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (roomName.trim() && userName.trim()) {
      onJoin(roomName.trim(), userName.trim(), audioOnly)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-600 via-primary-700 to-primary-900 flex items-center justify-center p-4" style={{ minHeight: '100dvh', paddingLeft: 'max(1rem, env(safe-area-inset-left, 0px))', paddingRight: 'max(1rem, env(safe-area-inset-right, 0px))', paddingTop: 'max(1rem, env(safe-area-inset-top, 0px))', paddingBottom: 'max(1rem, env(safe-area-inset-bottom, 0px))' }}>
      <div className="bg-white rounded-2xl shadow-2xl p-5 sm:p-8 w-full max-w-md">
        <div className="text-center mb-6 sm:mb-8">
          <h1 className="text-4xl font-bold text-primary-700 mb-2">Meetup</h1>
          <p className="text-gray-600">Start or join a video meeting</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 sm:space-y-6">
          <div>
            <label htmlFor="userName" className="block text-sm font-medium text-gray-700 mb-2">
              Your Name
            </label>
            <input
              id="userName"
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="Enter your name"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition"
              required
            />
          </div>

          <div>
            <label htmlFor="roomName" className="block text-sm font-medium text-gray-700 mb-2">
              Room Name
            </label>
            <div className="space-y-2">
              <input
                id="roomName"
                type="text"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                placeholder="Enter or generate room name"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition"
                required
              />
              <button
                type="button"
                onClick={generateRoomName}
                className="w-full px-4 py-2.5 bg-primary-100 text-primary-700 rounded-lg hover:bg-primary-200 transition font-medium text-sm"
              >
                Generate room name
              </button>
            </div>
          </div>

          <div className="flex items-center">
            <input
              id="audioOnly"
              type="checkbox"
              checked={audioOnly}
              onChange={(e) => setAudioOnly(e.target.checked)}
              className="w-4 h-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
            />
            <label htmlFor="audioOnly" className="ml-2 text-sm text-gray-700">
              Audio only mode
            </label>
          </div>

          <button
            type="submit"
            className="w-full bg-primary-600 text-white py-3 rounded-lg font-semibold hover:bg-primary-700 transition shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
          >
            Join Meeting
          </button>
        </form>

        <div className="mt-6 text-center text-sm text-gray-500">
          <p>Share the room name with others to invite them</p>
          {roomName && (
            <div className="mt-4 p-3 bg-primary-50 rounded-lg border border-primary-200">
              <p className="text-xs text-gray-600 mb-2">Or share this invite link:</p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={`${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomName)}`}
                  className="flex-1 px-3 py-2 text-xs bg-white border border-primary-200 rounded text-gray-700"
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <button
                  onClick={() => {
                    const inviteLink = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomName)}`
                    navigator.clipboard.writeText(inviteLink).then(() => {
                      alert('Invite link copied to clipboard!')
                    }).catch(() => {
                      alert(`Invite Link:\n\n${inviteLink}\n\nPlease copy manually.`)
                    })
                  }}
                  className="px-3 py-2 bg-primary-600 text-white text-xs rounded hover:bg-primary-700 transition"
                  title="Copy link"
                >
                  Copy
                </button>
              </div>
            </div>
          )}
          <p className="mt-2 text-xs text-gray-400">
            💡 Tip: Use "Generate room name" for a unique room to avoid moderator requirements
          </p>
        </div>
      </div>

      <InstallPrompt />
    </div>
  )
}

