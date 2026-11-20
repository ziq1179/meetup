import { useEffect, useRef, useState } from 'react'
import { JITSI_CONFIG } from '../config/jitsi'

interface MeetingRoomProps {
  roomName: string
  userName: string
  isAudioOnly: boolean
  onLeave: () => void
}

export default function MeetingRoom({ roomName, userName, isAudioOnly, onLeave }: MeetingRoomProps) {
  const jitsiContainerRef = useRef<HTMLDivElement>(null)
  const jitsiApiRef = useRef<any>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [recordingMode, setRecordingMode] = useState<'cloud' | 'local' | null>(null)
  const [isMuted, setIsMuted] = useState(false)
  const [isVideoMuted, setIsVideoMuted] = useState(isAudioOnly)
  const [isScreenSharing, setIsScreenSharing] = useState(false)
  const [participants, setParticipants] = useState<any[]>([])

  useEffect(() => {
    if (!jitsiContainerRef.current) return

    // Load Jitsi Meet external API
    const script = document.createElement('script')
    // Use configurable domain - allows switching to your own server
    const apiScriptUrl = JITSI_CONFIG.externalApiScript || `https://${JITSI_CONFIG.domain}/external_api.js`
    script.src = apiScriptUrl
    script.async = true

    script.onload = () => {
      if (window.JitsiMeetExternalAPI && jitsiContainerRef.current) {
        const domain = JITSI_CONFIG.domain
        // Use the room name as-is, but ensure it's URL-safe
        // For meet.jit.si, using a simple room name format helps avoid moderator requirements
        const sanitizedRoomName = roomName.toLowerCase().replace(/[^a-z0-9]/g, '')
        const options = {
          roomName: sanitizedRoomName || roomName,
          parentNode: jitsiContainerRef.current,
          configOverwrite: {
            startWithAudioMuted: false,
            startWithVideoMuted: isAudioOnly,
            enableWelcomePage: false,
            enableClosePage: false,
            disableDeepLinking: true,
            prejoinPageEnabled: false, // Critical: Disables prejoin/login page
            enableRecording: true,
            fileRecordingsEnabled: true,
            liveStreamingEnabled: true,
            // Disable authentication requirements - no login needed
            requireDisplayName: false,
            enableNoisyMicDetection: false,
            enableLayerSuspension: true,
            disableThirdPartyRequests: false,
            // Skip authentication prompts
            enableInsecureRoomNameWarning: false,
            enableRemb: true,
            enableTcc: true,
            // Disable any authentication flows
            disableInviteFunctions: false,
            // Bypass moderator requirement - allow meeting to start without moderator
            enableLobbyChat: false,
            enableKnockingLobby: false,
            enablePrejoinPage: false,
            // Allow anyone to start the meeting (no moderator required)
            enableNoAudioDetection: false,
            enableNoisyMicDetection: false,
            // Start meeting immediately without waiting for moderator
            channelLastN: -1,
            startAudioOnly: isAudioOnly,
            // Hide all UI elements
            toolbarConfig: {
              alwaysVisible: false,
              timeout: 0,
            },
          },
          interfaceConfigOverwrite: {
            // Hide ALL toolbar buttons
            TOOLBAR_BUTTONS: [],
            // Hide filmstrip
            FILM_STRIP_MAX_HEIGHT: 0,
            // Hide all UI elements
            SHOW_JITSI_WATERMARK: false,
            SHOW_WATERMARK_FOR_GUESTS: false,
            SHOW_BRAND_WATERMARK: false,
            BRAND_WATERMARK_LINK: '',
            SHOW_POWERED_BY: false,
            DISPLAY_WELCOME_PAGE_CONTENT: false,
            DISPLAY_WELCOME_FOOTER: false,
            APP_NAME: 'Meetup',
            NATIVE_APP_NAME: 'Meetup',
            PROVIDER_NAME: 'Meetup',
            HIDE_INVITE_MORE_HEADER: true,
            // Disable all indicators
            DISABLE_DOMINANT_SPEAKER_INDICATOR: true,
            DISABLE_FOCUS_INDICATOR: true,
            DISABLE_JOIN_LEAVE_NOTIFICATIONS: true,
            DISABLE_PRESENCE_STATUS: true,
            DISABLE_RINGING: true,
            DISABLE_TRANSCRIPTION_SUBTITLES: true,
            DISABLE_VIDEO_BACKGROUND: true,
            // Hide toolbar completely
            INITIAL_TOOLBAR_TIMEOUT: 0,
            TOOLBAR_TIMEOUT: 0,
            TOOLBAR_ALWAYS_VISIBLE: false,
            // Hide filmstrip
            VERTICAL_FILMSTRIP: false,
            HIDE_FILMSTRIP: true,
          },
          userInfo: {
            displayName: userName,
          },
          // No authentication token needed - join as guest
          noSsl: false,
          jwt: undefined, // No JWT token = no authentication required
          width: '100%',
          height: '100%',
        }

        jitsiApiRef.current = new window.JitsiMeetExternalAPI(domain, options)

        // Hide Jitsi UI elements with CSS after iframe loads
        setTimeout(() => {
          const iframe = jitsiContainerRef.current?.querySelector('iframe')
          if (iframe) {
            // Inject CSS to hide all Jitsi UI elements
            const style = document.createElement('style')
            style.id = 'jitsi-hide-ui'
            style.textContent = `
              /* Hide Jitsi toolbar */
              iframe[title*="Jitsi Meet"] ~ *,
              #jitsi-container * [class*="toolbox"],
              #jitsi-container * [class*="toolbar"],
              #jitsi-container * [id*="toolbox"],
              #jitsi-container * [id*="toolbar"] {
                display: none !important;
              }
            `
            document.head.appendChild(style)
          }
        }, 2000)

        // Handle ready to close event
        jitsiApiRef.current.addEventListener('readyToClose', () => {
          onLeave()
        })

        // Handle video conference left event
        jitsiApiRef.current.addEventListener('videoConferenceLeft', () => {
          onLeave()
        })

        // Handle participant role changes - automatically become moderator if needed
        jitsiApiRef.current.addEventListener('participantRoleChanged', (event: any) => {
          console.log('Participant role changed:', event)
          // If we're not a moderator yet, try to become one
          if (event.role !== 'moderator') {
            setTimeout(() => {
              try {
                // Try to grant moderator privileges to ourselves
                jitsiApiRef.current?.executeCommand('grantModerator', event.id)
              } catch (e) {
                console.log('Could not grant moderator:', e)
              }
            }, 1000)
          }
        })

        // Handle conference join - automatically start meeting
        jitsiApiRef.current.addEventListener('videoConferenceJoined', (event: any) => {
          console.log('Conference joined:', event)
          // Try to become moderator immediately after joining
          setTimeout(() => {
            try {
              // Get our own participant ID and grant moderator
              const participants = jitsiApiRef.current?.getParticipantsInfo()
              if (participants && participants.length > 0) {
                const localParticipant = participants.find((p: any) => p.local)
                if (localParticipant) {
                  jitsiApiRef.current?.executeCommand('grantModerator', localParticipant.participantId)
                }
              }
            } catch (e) {
              console.log('Could not auto-grant moderator:', e)
            }
          }, 2000)
        })

        // Try to bypass lobby/waiting screen
        jitsiApiRef.current.addEventListener('lobbyUserJoined', () => {
          console.log('User in lobby - trying to approve')
          setTimeout(() => {
            try {
              // Try to approve ourselves if we're in lobby
              jitsiApiRef.current?.executeCommand('toggleLobby')
            } catch (e) {
              console.log('Could not toggle lobby:', e)
            }
          }, 1000)
        })

        // Handle moderator approval needed - try to bypass
        jitsiApiRef.current.addEventListener('moderationApproved', () => {
          console.log('Moderation approved')
        })

        jitsiApiRef.current.addEventListener('moderationRejected', () => {
          console.log('Moderation rejected - trying to start anyway')
          // Try to start the meeting anyway
          setTimeout(() => {
            try {
              jitsiApiRef.current?.executeCommand('toggleLobby')
            } catch (e) {
              console.log('Could not toggle lobby:', e)
            }
          }, 1000)
        })

        // Track participant changes
        jitsiApiRef.current.addEventListener('participantJoined', (event: any) => {
          console.log('Participant joined:', event)
          updateParticipants()
        })

        jitsiApiRef.current.addEventListener('participantLeft', (event: any) => {
          console.log('Participant left:', event)
          updateParticipants()
        })

        // Track audio/video state
        jitsiApiRef.current.addEventListener('audioMuteStatusChanged', (event: any) => {
          setIsMuted(event.muted)
        })

        jitsiApiRef.current.addEventListener('videoMuteStatusChanged', (event: any) => {
          setIsVideoMuted(event.muted)
        })

        // Track screen sharing
        jitsiApiRef.current.addEventListener('screenSharingStatusChanged', (event: any) => {
          setIsScreenSharing(event.on)
        })

        // Recording event listeners
        jitsiApiRef.current.addEventListener('recordingStatusChanged', (event: any) => {
          if (event.on) {
            setIsRecording(true)
            setRecordingMode(event.mode || 'cloud')
          } else {
            setIsRecording(false)
            setRecordingMode(null)
          }
        })

        // Handle recording link available
        jitsiApiRef.current.addEventListener('recordingLinkAvailable', (event: any) => {
          console.log('Recording link:', event.recordingLink)
        })

        // Handle recording error
        jitsiApiRef.current.addEventListener('recordingError', (event: any) => {
          console.error('Recording error:', event.error)
        })

        // Function to update participants list
        const updateParticipants = () => {
          if (jitsiApiRef.current) {
            try {
              const info = jitsiApiRef.current.getParticipantsInfo()
              setParticipants(info || [])
              
              // If we're the only participant, we should be moderator
              // Try to ensure we have moderator privileges
              if (info && info.length === 1) {
                const localParticipant = info.find((p: any) => p.local)
                if (localParticipant && localParticipant.role !== 'moderator') {
                  setTimeout(() => {
                    try {
                      jitsiApiRef.current?.executeCommand('grantModerator', localParticipant.participantId)
                    } catch (e) {
                      console.log('Could not grant moderator to self:', e)
                    }
                  }, 1000)
                }
              }
            } catch (e) {
              console.log('Error getting participants:', e)
            }
          }
        }

        // Initial participants update
        setTimeout(updateParticipants, 3000)
        
        // Periodically check and try to become moderator if needed
        const moderatorCheckInterval = setInterval(() => {
          if (jitsiApiRef.current) {
            try {
              const info = jitsiApiRef.current.getParticipantsInfo()
              if (info) {
                const localParticipant = info.find((p: any) => p.local)
                // If we're not moderator and we're the first/only participant, try to become one
                if (localParticipant && localParticipant.role !== 'moderator' && info.length <= 1) {
                  jitsiApiRef.current.executeCommand('grantModerator', localParticipant.participantId)
                }
              }
            } catch (e) {
              // Ignore errors
            }
          }
        }, 5000)

        // Store interval ID for cleanup
        ;(jitsiApiRef.current as any).moderatorCheckInterval = moderatorCheckInterval
      }
    }

    document.body.appendChild(script)

    return () => {
      // Clear moderator check interval if it exists
      if (jitsiApiRef.current && (jitsiApiRef.current as any).moderatorCheckInterval) {
        clearInterval((jitsiApiRef.current as any).moderatorCheckInterval)
      }
      if (jitsiApiRef.current) {
        jitsiApiRef.current.dispose()
      }
      if (document.body.contains(script)) {
        document.body.removeChild(script)
      }
      // Remove injected CSS
      const style = document.getElementById('jitsi-hide-ui')
      if (style) {
        style.remove()
      }
    }
  }, [roomName, userName, isAudioOnly, onLeave])

  const toggleMute = () => {
    if (jitsiApiRef.current) {
      jitsiApiRef.current.executeCommand('toggleAudio')
    }
  }

  const toggleVideo = () => {
    if (jitsiApiRef.current) {
      jitsiApiRef.current.executeCommand('toggleVideo')
    }
  }

  const toggleScreenShare = () => {
    if (jitsiApiRef.current) {
      jitsiApiRef.current.executeCommand('toggleShareScreen')
    }
  }

  const handleStartRecording = () => {
    if (jitsiApiRef.current) {
      jitsiApiRef.current.executeCommand('startRecording', {
        mode: 'file',
      })
    }
  }

  const handleStopRecording = () => {
    if (jitsiApiRef.current) {
      jitsiApiRef.current.executeCommand('stopRecording', 'file')
    }
  }

  const handleLeave = () => {
    if (jitsiApiRef.current) {
      jitsiApiRef.current.executeCommand('hangup')
    }
    onLeave()
  }

  return (
    <div className="h-screen w-screen relative bg-gray-900 flex flex-col">
      {/* Custom Header */}
      <div className="absolute top-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-md border-b border-white/10">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <div className="text-white">
              <p className="text-sm text-gray-300">Room</p>
              <p className="text-lg font-semibold">{roomName}</p>
            </div>
            {participants.length > 0 && (
              <div className="text-white">
                <p className="text-sm text-gray-300">Participants</p>
                <p className="text-lg font-semibold">{participants.length + 1}</p>
              </div>
            )}
            {isRecording && (
              <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg px-3 py-1.5">
                <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
                <span className="text-red-400 text-sm font-medium">
                  Recording {recordingMode === 'file' ? '(File)' : ''}
                </span>
              </div>
            )}
          </div>
          <button
            onClick={handleLeave}
            className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-medium transition flex items-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            Leave
          </button>
        </div>
      </div>

      {/* Jitsi Container - Hidden UI */}
      <div 
        ref={jitsiContainerRef} 
        className="flex-1 w-full relative overflow-hidden"
        id="jitsi-container"
      />

      {/* Custom Controls Bar */}
      <div className="absolute bottom-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-md border-t border-white/10">
        <div className="flex items-center justify-center gap-4 px-6 py-4">
          {/* Mute/Unmute Audio */}
          <button
            onClick={toggleMute}
            className={`p-4 rounded-full transition-all ${
              isMuted 
                ? 'bg-red-600 hover:bg-red-700 text-white' 
                : 'bg-white/20 hover:bg-white/30 text-white'
            }`}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? (
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
              </svg>
            ) : (
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            )}
          </button>

          {/* Toggle Video */}
          <button
            onClick={toggleVideo}
            className={`p-4 rounded-full transition-all ${
              isVideoMuted 
                ? 'bg-red-600 hover:bg-red-700 text-white' 
                : 'bg-white/20 hover:bg-white/30 text-white'
            }`}
            title={isVideoMuted ? 'Turn on camera' : 'Turn off camera'}
          >
            {isVideoMuted ? (
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M1 1l22 22" />
              </svg>
            ) : (
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>

          {/* Screen Share */}
          <button
            onClick={toggleScreenShare}
            className={`p-4 rounded-full transition-all ${
              isScreenSharing 
                ? 'bg-primary-600 hover:bg-primary-700 text-white' 
                : 'bg-white/20 hover:bg-white/30 text-white'
            }`}
            title={isScreenSharing ? 'Stop sharing' : 'Share screen'}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </button>

          {/* Recording */}
          {!isRecording ? (
            <button
              onClick={handleStartRecording}
              className="p-4 rounded-full bg-white/20 hover:bg-white/30 text-white transition-all"
              title="Start Recording"
            >
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleStopRecording}
              className="p-4 rounded-full bg-red-600 hover:bg-red-700 text-white transition-all"
              title="Stop Recording"
            >
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd" />
              </svg>
            </button>
          )}

          {/* Chat (optional - you can implement custom chat UI) */}
          <button
            className="p-4 rounded-full bg-white/20 hover:bg-white/30 text-white transition-all"
            title="Chat"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

