import { useState, useEffect } from 'react'
import WebRTCRoom from './components/WebRTCRoom'
import MeetingSetup from './components/MeetingSetup'

function App() {
  const [roomName, setRoomName] = useState<string | null>(null)
  const [userName, setUserName] = useState<string>('')
  const [isAudioOnly, setIsAudioOnly] = useState(false)

  // Check URL for room parameter on mount
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search)
    const roomFromUrl = urlParams.get('room')
    if (roomFromUrl) {
      // Room name from URL - user can enter their name and join
      // We'll keep it in state but not auto-join
    }
  }, [])

  const handleJoinMeeting = (room: string, name: string, audioOnly: boolean) => {
    setRoomName(room)
    setUserName(name)
    setIsAudioOnly(audioOnly)
    // Update URL with room parameter
    const url = new URL(window.location.href)
    url.searchParams.set('room', room)
    window.history.pushState({}, '', url.toString())
  }

  const handleLeaveMeeting = () => {
    setRoomName(null)
    setUserName('')
    setIsAudioOnly(false)
    // Clear URL parameters
    window.history.pushState({}, '', window.location.pathname)
  }

  if (roomName) {
    return (
      <WebRTCRoom
        roomName={roomName}
        userName={userName}
        isAudioOnly={isAudioOnly}
        onLeave={handleLeaveMeeting}
      />
    )
  }

  // Check if room is in URL
  const urlParams = new URLSearchParams(window.location.search)
  const roomFromUrl = urlParams.get('room')

  return <MeetingSetup onJoin={handleJoinMeeting} initialRoomName={roomFromUrl || ''} />
}

export default App

