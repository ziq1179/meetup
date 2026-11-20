import { useEffect, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'
import { WebRTCManager } from '../lib/webrtc'
import { WebRTCSFUManager } from '../lib/webrtc-sfu'
import { SFU_CONFIG } from '../config/webrtc'
import Chat from './Chat'

interface WebRTCRoomProps {
  roomName: string
  userName: string
  isAudioOnly: boolean
  onLeave: () => void
}

interface Participant {
  socketId: string
  userId: string
  userName: string
  stream: MediaStream | null
  videoEnabled: boolean
  audioEnabled: boolean
}

// Two-letter initials for the avatar shown when a camera is off
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
  const initials = parts.map((p) => p[0]?.toUpperCase() ?? '').join('')
  return initials || '?'
}

export default function WebRTCRoom({ roomName, userName, isAudioOnly, onLeave }: WebRTCRoomProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const socketRef = useRef<Socket | null>(null)
  const sfuSocketRef = useRef<Socket | null>(null)
  const webrtcManagerRef = useRef<WebRTCManager | null>(null)
  const sfuManagerRef = useRef<WebRTCSFUManager | null>(null)
  const useSFU = SFU_CONFIG.enabled
  const [isMuted, setIsMuted] = useState(false)
  const [isVideoMuted, setIsVideoMuted] = useState(isAudioOnly)
  const [isScreenSharing, setIsScreenSharing] = useState(false)
  const [participants, setParticipants] = useState<Map<string, Participant>>(new Map())
  const [isConnecting, setIsConnecting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [messageCount, setMessageCount] = useState(0)
  const [showInviteDropdown, setShowInviteDropdown] = useState(false)
  const [copiedToClipboard, setCopiedToClipboard] = useState(false)
  // Host (room admin) is the first participant; they can mute others.
  const [hostSocketId, setHostSocketId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const remoteVideoContainerRef = useRef<HTMLDivElement>(null)
  const inviteDropdownRef = useRef<HTMLDivElement>(null)
  const userIdRef = useRef<string>('')

  // Current camera/mic state, kept in a ref so socket handlers registered once
  // always broadcast the latest values (no stale closures).
  const mediaStateRef = useRef({ videoEnabled: !isAudioOnly, audioEnabled: true })

  const broadcastMediaState = () => {
    const s = socketRef.current
    if (s?.connected) {
      s.emit('media-state', { roomId: roomName, ...mediaStateRef.current })
    }
  }

  // Resolve which signaling endpoint + socket.io path to use.
  // Production: Vercel WebSocket function on the same origin.
  // Development: local signaling server (port 3001).
  const getSignalingOptions = (detectedIP: string | null): { url: string; path: string } => {
    // Priority 1: Explicit environment variable
    if (import.meta.env.VITE_SIGNALING_SERVER) {
      let url = String(import.meta.env.VITE_SIGNALING_SERVER)
      // If it contains localhost and we have an IP, replace it
      if ((url.includes('localhost') || url.includes('127.0.0.1')) && detectedIP) {
        const urlObj = new URL(url)
        urlObj.hostname = detectedIP
        url = urlObj.toString()
      }
      return { url, path: '/socket.io' }
    }

    // Development: connect to the locally running signaling server
    if (import.meta.env.DEV) {
      const hostname = window.location.hostname
      if (hostname.match(/^(\d{1,3}\.){3}\d{1,3}$/)) {
        return { url: `http://${hostname}:3001`, path: '/socket.io' }
      }
      if ((hostname === 'localhost' || hostname === '127.0.0.1') && detectedIP) {
        return { url: `http://${detectedIP}:3001`, path: '/socket.io' }
      }
      return { url: 'http://localhost:3001', path: '/socket.io' }
    }

    // Production: Vercel WebSocket function hosted on the same origin
    return { url: window.location.origin, path: '/api/socket-io' }
  }

  useEffect(() => {
    const userId = `user-${Date.now()}-${Math.random().toString(36).substring(7)}`
    // Use current hostname if it's already an IP, otherwise wait for detected IP
    const currentHostname = window.location.hostname
    const isIPAddress = currentHostname.match(/^(\d{1,3}\.){3}\d{1,3}$/)
    const signalingOptions = getSignalingOptions(isIPAddress ? null : localIP)

    // Connect to the signaling endpoint.
    // In production this is the Vercel WebSocket function on the same origin;
    // in development it's the local signaling server.
    const socket = io(signalingOptions.url, {
      path: signalingOptions.path,
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      reconnectionAttempts: Infinity,
      timeout: 20000
    })

    socketRef.current = socket

    // Reconnect with updated URL if IP is detected after initial connection attempt
    if (localIP && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
      const updatedOptions = getSignalingOptions(localIP)
      if (updatedOptions.url !== signalingOptions.url && !socket.connected) {
        socket.disconnect()
        // Create new socket with updated URL instead of modifying existing one
        const newSocket = io(updatedOptions.url, {
          path: updatedOptions.path,
          transports: ['websocket'],
          reconnection: true,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 30000,
          reconnectionAttempts: Infinity,
          timeout: 20000
        })
        socketRef.current = newSocket
        // Re-setup event handlers for new socket (this will be done in the useEffect)
      }
    }

    socket.on('connect', async () => {
      console.log('✅ Connected to signaling server')
      setIsConnecting(false)
      setError(null)

      try {
        if (useSFU) {
          // Use SFU mode
          const sfuServerUrl = SFU_CONFIG.serverUrl.replace('ws://', 'http://').replace('wss://', 'https://')
          const sfuSocket = io(sfuServerUrl, {
            transports: ['websocket', 'polling']
          })
          sfuSocketRef.current = sfuSocket

          sfuSocket.on('connect', async () => {
            console.log('Connected to SFU server')
            try {
              const sfuManager = new WebRTCSFUManager(
                sfuSocket,
                roomName,
                (socketId: string, stream: MediaStream) => {
                  setParticipants(prev => {
                    const newMap = new Map(prev)
                    const existing = newMap.get(socketId)
                    newMap.set(socketId, {
                      socketId,
                      userId: existing?.userId || '',
                      userName: existing?.userName || '',
                      stream,
                      videoEnabled: existing?.videoEnabled ?? true,
                      audioEnabled: existing?.audioEnabled ?? true
                    })
                    return newMap
                  })
                }
              )

              await sfuManager.initialize()
              await sfuManager.createSendTransport()
              await sfuManager.createRecvTransport()

              // Check if mediaDevices API is available
              if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error(
                  'getUserMedia is not supported in this browser. ' +
                  'Please use a modern browser (Chrome, Firefox, Edge, Safari) and ensure you are accessing the site via HTTPS.'
                );
              }

              const localStream = await navigator.mediaDevices.getUserMedia({
                audio: !isAudioOnly,
                video: !isAudioOnly ? { width: 1280, height: 720 } : false
              })

              await sfuManager.produce(localStream)

              if (localVideoRef.current) {
                localVideoRef.current.srcObject = localStream
              }

              sfuManagerRef.current = sfuManager
              mediaStateRef.current = {
                videoEnabled: localStream.getVideoTracks().length > 0,
                audioEnabled: localStream.getAudioTracks().length > 0
              }
            } catch (err: any) {
              console.error('Error initializing SFU:', err)
              setError(err.message || 'Failed to initialize SFU')
            }
          })

          sfuSocket.on('connect_error', (err) => {
            console.error('SFU connection error:', err)
            setError('Failed to connect to SFU server. Make sure mediasoup server is running.')
          })
        } else {
          // Use P2P mesh mode
          if (!webrtcManagerRef.current) {
            const manager = new WebRTCManager(
              socket,
              roomName,
              userId,
              userName,
              (socketId: string, stream: MediaStream, remoteUserName?: string, remoteUserId?: string) => {
                setParticipants(prev => {
                  const newMap = new Map(prev)
                  const existing = newMap.get(socketId)
                  newMap.set(socketId, {
                    socketId,
                    userId: existing?.userId || remoteUserId || '',
                    userName: existing?.userName || remoteUserName || '',
                    stream,
                    videoEnabled: existing?.videoEnabled ?? true,
                    audioEnabled: existing?.audioEnabled ?? true
                  })
                  return newMap
                })
              },
              (socketId: string) => {
                setParticipants(prev => {
                  const newMap = new Map(prev)
                  newMap.delete(socketId)
                  return newMap
                })
              }
            )
            webrtcManagerRef.current = manager
          }

          const webrtcManager = webrtcManagerRef.current

          // Only request the camera/mic once; reuse the stream across reconnects
          if (!webrtcManager.getLocalStream()) {
            const localStream = await webrtcManager.initializeLocalStream(!isAudioOnly, !isAudioOnly)
            if (localVideoRef.current) {
              localVideoRef.current.srcObject = localStream
            }
          }

          // Reflect what we actually captured (e.g. audio-only joins have no
          // video track) so remote tiles show the right state immediately.
          const activeStream = webrtcManager.getLocalStream()
          if (activeStream) {
            mediaStateRef.current = {
              videoEnabled: activeStream.getVideoTracks().length > 0,
              audioEnabled: activeStream.getAudioTracks().length > 0
            }
          }
        }

        // Join the room for chat + WebRTC signaling. Done after the manager and
        // local stream are ready so existing participants are announced to
        // listeners that are already set up to handle them.
        socket.emit('join-room', {
          roomId: roomName,
          userId,
          userName
        })
        console.log('Joined room:', roomName)
        // Announce current camera/mic state so existing participants render our
        // tile correctly from the start.
        broadcastMediaState()
      } catch (err: any) {
        console.error('Error initializing WebRTC:', err)
        setError(err.message || 'Failed to access camera/microphone')
        // No camera available — present as "camera off" so others see our name
        // instead of a black frame.
        mediaStateRef.current.videoEnabled = false
        setIsVideoMuted(true)
        broadcastMediaState()
        setIsConnecting(false)
      }
    })

    socket.on('connect_error', (err) => {
      console.error('Connection error:', err)
      // Don't show error immediately - Socket.io will keep retrying
      console.log('🔄 Retrying connection...')
      // Show error after a delay if still not connected
      setTimeout(() => {
        if (!socket.connected) {
          setError(`Failed to connect to the signaling server at ${signalingOptions.url}. Please try refreshing the page.`)
          setIsConnecting(false)
        }
      }, 5000)
    })

    socket.on('reconnect', (attemptNumber) => {
      console.log('✅ Reconnected after', attemptNumber, 'attempts')
      setIsConnecting(false)
      setError(null)
    })

    socket.on('reconnect_error', (error) => {
      console.warn('Reconnection error:', error)
    })

    // Camera/mic on-off updates from other participants
    socket.on('media-state', ({ socketId, videoEnabled, audioEnabled }: { socketId: string; videoEnabled: boolean; audioEnabled: boolean }) => {
      setParticipants(prev => {
        const existing = prev.get(socketId)
        if (!existing) return prev
        const newMap = new Map(prev)
        newMap.set(socketId, { ...existing, videoEnabled, audioEnabled })
        return newMap
      })
    })

    // A newcomer can't know our current state — tell them as soon as they join
    socket.on('user-joined', () => broadcastMediaState())

    // Who is the host (room admin) — first participant, promoted if they leave
    socket.on('room-info', ({ hostSocketId: hostId }: { hostSocketId: string }) => {
      setHostSocketId(hostId)
    })
    socket.on('host-changed', ({ hostSocketId: hostId }: { hostSocketId: string }) => {
      setHostSocketId(hostId)
    })

    // The host muted us
    socket.on('muted-by-host', ({ byName }: { byName?: string }) => {
      setIsMuted(true)
      if (useSFU && sfuManagerRef.current) {
        sfuManagerRef.current.toggleAudio(true)
      } else if (webrtcManagerRef.current) {
        webrtcManagerRef.current.toggleAudio(false)
      }
      mediaStateRef.current.audioEnabled = false
      broadcastMediaState()
      setNotice(`You were muted by ${byName || 'the host'}`)
      window.setTimeout(() => setNotice(null), 4000)
    })

    socket.on('reconnect_failed', () => {
      console.error('❌ Failed to reconnect to signaling server')
      setError('Connection lost. Please refresh the page.')
      setIsConnecting(false)
    })

    socket.on('disconnect', () => {
      console.log('Disconnected from signaling server')
    })

    return () => {
      if (webrtcManagerRef.current) {
        webrtcManagerRef.current.cleanup()
      }
      if (socket) {
        socket.disconnect()
      }
    }
  }, [roomName, userName, isAudioOnly])

  // --- Spotlight / focus view -----------------------------------------------
  // focusedSocketId === 'local' focuses your own tile; any other value focuses
  // that participant's tile. null = normal grid layout.
  const [focusedSocketId, setFocusedSocketId] = useState<string | null>(null)
  const focusIsValid = focusedSocketId === 'local' || Array.from(participants.values()).some((p) => p.socketId === focusedSocketId)
  const focusTarget = focusIsValid ? focusedSocketId : null
  const isFocusMode = focusTarget !== null

  // The host (first participant) gets admin controls: mute any participant.
  const isHost = !!hostSocketId && hostSocketId === socketRef.current?.id

  // Auto-spotlight yourself when you start sharing your screen, so you get the
  // full-screen preview; un-focus when you stop.
  useEffect(() => {
    if (isScreenSharing) {
      setFocusedSocketId('local')
    } else if (focusedSocketId === 'local') {
      setFocusedSocketId(null)
    }
    // Intentionally not depending on focusedSocketId to avoid resets while
    // a screen share is running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isScreenSharing])

  // Update remote video elements when participants or the focus layout change
  useEffect(() => {
    if (!remoteVideoContainerRef.current) return

    // Clear existing remote videos
    remoteVideoContainerRef.current.innerHTML = ''

    // Create video elements for each participant
    participants.forEach((participant) => {
      if (!participant.stream) return

      const participantIsFocused = focusTarget === participant.socketId
      // Camera off (or an audio-only stream with no video track): show an
      // avatar + name instead of a black video frame.
      const hasLiveVideo = participant.stream.getVideoTracks().some((t) => t.readyState === 'live')
      const cameraOff = participant.videoEnabled === false || !hasLiveVideo

      const container = document.createElement('div')
      container.className = participantIsFocused
        ? 'relative bg-gray-100 rounded-lg overflow-hidden border-2 border-primary-400 shadow-xl order-1 row-start-1 min-h-0'
        : isFocusMode
          ? 'relative bg-gray-100 rounded-lg overflow-hidden border-2 border-primary-200 shadow-lg order-2 row-start-2 w-40 h-24 shrink-0 cursor-pointer hover:border-primary-400'
          : 'relative bg-gray-100 rounded-lg overflow-hidden border-2 border-primary-200 shadow-lg'

      if (cameraOff) {
        const avatarWrap = document.createElement('div')
        avatarWrap.className = 'absolute inset-0 flex flex-col items-center justify-center gap-1.5 sm:gap-2 bg-gradient-to-br from-primary-50 to-primary-100 px-2'

        const avatar = document.createElement('div')
        avatar.className = participantIsFocused
          ? 'w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-primary-500 text-white flex items-center justify-center text-2xl sm:text-3xl font-semibold shadow-md'
          : isFocusMode
            ? 'w-8 h-8 rounded-full bg-primary-500 text-white flex items-center justify-center text-xs font-semibold shadow-md'
            : 'w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-primary-500 text-white flex items-center justify-center text-xl sm:text-2xl font-semibold shadow-md'
        avatar.textContent = getInitials(participant.userName || 'Participant')
        avatarWrap.appendChild(avatar)

        const nameEl = document.createElement('div')
        nameEl.className = participantIsFocused
          ? 'text-gray-900 font-semibold text-base sm:text-xl text-center max-w-full truncate px-2'
          : isFocusMode
            ? 'hidden'
            : 'text-gray-900 font-semibold text-sm sm:text-lg text-center max-w-full truncate px-2'
        nameEl.textContent = participant.userName || 'Participant'
        avatarWrap.appendChild(nameEl)

        container.appendChild(avatarWrap)
      } else {
        const videoElement = document.createElement('video')
        videoElement.autoplay = true
        videoElement.playsInline = true
        // Focused tiles must show the full screen share uncropped (object-contain).
        videoElement.className = participantIsFocused ? 'w-full h-full object-contain' : 'w-full h-full object-cover'
        videoElement.srcObject = participant.stream
        videoElement.setAttribute('data-socket-id', participant.socketId)
        container.appendChild(videoElement)
      }

      const label = document.createElement('div')
      label.className = participantIsFocused
        ? 'absolute bottom-2 left-2 bg-primary-600 text-white px-2 py-1 rounded text-sm font-medium shadow-md'
        : 'absolute bottom-1 left-1 bg-primary-600 text-white px-1.5 py-0.5 rounded text-[10px] font-medium shadow-md'
      label.textContent = participant.userName || 'Participant'
      container.appendChild(label)

      const focusBtn = document.createElement('button')
      focusBtn.type = 'button'
      focusBtn.textContent = participantIsFocused ? '✕ Show all' : '⤢ Focus'
      focusBtn.className = participantIsFocused
        ? 'absolute top-2 right-2 z-10 bg-white/90 hover:bg-white text-gray-900 text-xs sm:text-sm px-3 py-1.5 rounded-full shadow-md font-medium'
        : 'absolute top-1.5 right-1.5 z-10 bg-primary-600 hover:bg-primary-700 text-white text-[10px] px-2 py-1 rounded-full shadow-md font-medium'
      focusBtn.onclick = (e) => {
        e.stopPropagation()
        setFocusedSocketId(participantIsFocused ? null : participant.socketId)
      }
      container.appendChild(focusBtn)

      // In strip mode, clicking the thumbnail also focuses that participant.
      if (!participantIsFocused && isFocusMode) {
        container.onclick = () => setFocusedSocketId(participant.socketId)
      }

      // Host controls: mute this participant
      if (isHost) {
        const muteBtn = document.createElement('button')
        muteBtn.type = 'button'
        muteBtn.title = `Mute ${participant.userName || 'participant'}`
        muteBtn.textContent = participant.audioEnabled === false ? '✓ Muted' : '🔇 Mute'
        muteBtn.className = participantIsFocused
          ? 'absolute top-2 left-2 z-10 bg-white/90 hover:bg-white text-gray-900 text-xs sm:text-sm px-3 py-1.5 rounded-full shadow-md font-medium'
          : 'absolute top-1.5 left-1.5 z-10 bg-white/90 hover:bg-white text-gray-900 text-[10px] px-2 py-1 rounded-full shadow-md font-medium'
        muteBtn.onclick = (e) => {
          e.stopPropagation()
          socketRef.current?.emit('mute-participant', {
            roomId: roomName,
            targetSocketId: participant.socketId
          })
        }
        container.appendChild(muteBtn)
      }

      // Mic-off indicator for everyone (host and participants see this)
      if (participant.audioEnabled === false) {
        const micBadge = document.createElement('div')
        micBadge.className = 'absolute bottom-1 right-1 z-10 w-5 h-5 rounded-full bg-red-600 text-white flex items-center justify-center text-[10px] shadow-md'
        micBadge.textContent = '🔇'
        container.appendChild(micBadge)
      }

      if (remoteVideoContainerRef.current) {
        remoteVideoContainerRef.current.appendChild(container)
      }
    })
  }, [participants, focusTarget, isFocusMode, isHost, roomName])

  const toggleMute = () => {
    const newMutedState = !isMuted
    if (useSFU && sfuManagerRef.current) {
      sfuManagerRef.current.toggleAudio(newMutedState)
    } else if (webrtcManagerRef.current) {
      webrtcManagerRef.current.toggleAudio(!newMutedState)
    }
    setIsMuted(newMutedState)
    mediaStateRef.current.audioEnabled = !newMutedState
    broadcastMediaState()
  }

  const toggleVideo = () => {
    const newVideoMutedState = !isVideoMuted
    if (useSFU && sfuManagerRef.current) {
      sfuManagerRef.current.toggleVideo(newVideoMutedState)
    } else if (webrtcManagerRef.current) {
      webrtcManagerRef.current.toggleVideo(!newVideoMutedState)
    }
    setIsVideoMuted(newVideoMutedState)
    mediaStateRef.current.videoEnabled = !newVideoMutedState
    broadcastMediaState()
  }

  const toggleScreenShare = async () => {
    try {
      if (isScreenSharing) {
        if (useSFU && sfuManagerRef.current) {
          await sfuManagerRef.current.stopScreenShare()
        } else if (webrtcManagerRef.current) {
          await webrtcManagerRef.current.stopScreenShare()
        }
        setIsScreenSharing(false)
      } else {
        if (useSFU && sfuManagerRef.current) {
          await sfuManagerRef.current.startScreenShare()
        } else if (webrtcManagerRef.current) {
          await webrtcManagerRef.current.startScreenShare()
        }
        setIsScreenSharing(true)
      }
    } catch (error) {
      console.error('Error toggling screen share:', error)
    }
  }

  const toggleRecording = async () => {
    // Recording currently only works in P2P mode
    if (!useSFU && webrtcManagerRef.current) {
      try {
        if (isRecording) {
          // Check actual recording state before stopping
          const actuallyRecording = webrtcManagerRef.current.isRecording()
          if (actuallyRecording) {
            const blob = await webrtcManagerRef.current.stopRecording()
            const filename = `recording-${roomName}-${Date.now()}.webm`
            webrtcManagerRef.current.downloadRecording(blob, filename)
          } else {
            // Recording was already stopped (maybe by user via browser UI)
            console.log('Recording was already stopped')
          }
          setIsRecording(false)
        } else {
          // Recording will automatically capture browser tab/window
          // User will be prompted to select what to share
          await webrtcManagerRef.current.startRecording()
          setIsRecording(true)
          setError(null) // Clear any previous errors
        }
      } catch (error: any) {
        console.error('Error toggling recording:', error)
        // Only show error if it's not just "already stopped"
        if (!error.message?.includes('No active recording') || !isRecording) {
          setError(error.message || 'Failed to start/stop recording')
        }
        setIsRecording(false)
      }
    } else if (useSFU) {
      setError('Recording not yet supported in SFU mode')
    }
  }

  const handleLeave = () => {
    if (useSFU && sfuManagerRef.current) {
      sfuManagerRef.current.cleanup()
    } else if (webrtcManagerRef.current) {
      webrtcManagerRef.current.cleanup()
    }
    if (sfuSocketRef.current) {
      sfuSocketRef.current.disconnect()
    }
    if (socketRef.current) {
      socketRef.current.disconnect()
    }
    onLeave()
  }

  const participantArray = Array.from(participants.values())

  // Get local network IP address (for replacing localhost in invite links)
  const [localIP, setLocalIP] = useState<string | null>(null)

  useEffect(() => {
    // Try to get local IP address if we're on localhost
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      // Use WebRTC to get local IP (works in most browsers)
      const RTCPeerConnection = window.RTCPeerConnection || (window as any).webkitRTCPeerConnection || (window as any).mozRTCPeerConnection
      if (RTCPeerConnection) {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
        pc.createDataChannel('')
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            const candidate = event.candidate.candidate
            const match = candidate.match(/([0-9]{1,3}(\.[0-9]{1,3}){3})/)
            if (match && match[1]) {
              const ip = match[1]
              // Filter out localhost and invalid IPs, prefer private network IPs
              if (ip !== '127.0.0.1' && ip !== '0.0.0.0' && !ip.startsWith('169.254')) {
                // Prefer private network IPs (10.x.x.x, 192.168.x.x, 172.16-31.x.x)
                if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) {
                  setLocalIP(ip)
                  pc.close()
                } else if (!localIP) {
                  // Fallback to any valid IP if no private IP found yet
                  setLocalIP(ip)
                }
              }
            }
          }
        }
        pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(() => {
          // Silently fail if WebRTC is not available
        })
        
        // Cleanup after 3 seconds
        setTimeout(() => pc.close(), 3000)
      }
    }
  }, [])

  // Generate invite link - prioritize ngrok URL, then IP address, then current origin
  const getInviteLink = () => {
    // Priority 1: Check if we have a frontend URL from environment (ngrok)
    const frontendUrl = import.meta.env.VITE_FRONTEND_URL
    if (frontendUrl) {
      // Remove trailing slash if present
      const baseUrl = frontendUrl.replace(/\/$/, '')
      return `${baseUrl}${window.location.pathname}?room=${encodeURIComponent(roomName)}`
    }
    
    // Priority 2: If on localhost and we have a local IP, use that instead
    const hostname = window.location.hostname
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80')
    const protocol = window.location.protocol
    
    if ((hostname === 'localhost' || hostname === '127.0.0.1') && localIP) {
      // Use detected local IP address with the same port and protocol
      return `${protocol}//${localIP}:${port}${window.location.pathname}?room=${encodeURIComponent(roomName)}`
    }
    
    // Priority 3: If already accessing via IP address, use that
    if (hostname.match(/^(\d{1,3}\.){3}\d{1,3}$/)) {
      return `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomName)}`
    }
    
    // Priority 4: Fallback to current origin (localhost)
    return `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomName)}`
  }
  
  const inviteLink = getInviteLink()

  // Copy invite link to clipboard
  const copyInviteLink = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink)
      setCopiedToClipboard(true)
      setTimeout(() => {
        setCopiedToClipboard(false)
      }, 2000)
    } catch (error) {
      console.error('Failed to copy link:', error)
      // Fallback: select the input text
      const input = document.getElementById('invite-link-input') as HTMLInputElement
      if (input) {
        input.select()
        input.setSelectionRange(0, 99999) // For mobile devices
      }
    }
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (inviteDropdownRef.current && !inviteDropdownRef.current.contains(event.target as Node)) {
        setShowInviteDropdown(false)
      }
    }

    if (showInviteDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showInviteDropdown])

  // Screen sharing and browser-tab recording rely on getDisplayMedia, which is
  // not available on iOS Safari. Hide those controls when unsupported.
  const supportsScreenShare = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia

  // --- Fullscreen mode -------------------------------------------------------
  // Uses the Fullscreen API (Android/desktop Chromium). Hidden on iOS, where
  // document fullscreen isn't offered (only per-video element).
  const canFullscreen = typeof document !== 'undefined' &&
    (document.fullscreenEnabled ?? false)
  const [isFullscreen, setIsFullscreen] = useState(
    typeof document !== 'undefined' && !!document.fullscreenElement
  )

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('webkitfullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      document.removeEventListener('webkitfullscreenchange', onChange)
    }
  }, [])

  const toggleFullscreen = async () => {
    try {
      if (isFullscreen) {
        await document.exitFullscreen()
      } else {
        await document.documentElement.requestFullscreen()
      }
    } catch (err) {
      console.warn('Fullscreen toggle failed:', err)
    }
  }


  // Lock the document while in a meeting: the room scrolls internally, and the
  // browser's rubber-band/pull-to-refresh would otherwise fight with it.
  useEffect(() => {
    document.body.classList.add('meeting-active')
    document.title = `Meetup · ${roomName}`
    return () => {
      document.body.classList.remove('meeting-active')
      document.title = 'Meetup - Video Meetings'
    }
  }, [roomName])

  return (
    <div className="h-screen w-screen relative bg-white flex flex-col overflow-hidden" style={{ height: '100dvh' }}>
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-md border-b border-primary-200 shadow-sm" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="flex items-center justify-between gap-2 px-3 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            <div className="flex items-center gap-1.5 shrink-0 sm:pr-3 sm:mr-1 sm:border-r sm:border-primary-200">
              <span className="w-2 h-2 rounded-full bg-primary-500"></span>
              <span className="text-xs font-bold text-primary-700 sm:text-sm">Meetup</span>
            </div>
            <div className="text-gray-900 min-w-0">
              <p className="hidden text-sm text-gray-600 sm:block">Room</p>
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-primary-700 truncate sm:text-lg" title={roomName}>{roomName}</p>
                <div className="relative" ref={inviteDropdownRef}>
                  <button
                    onClick={() => setShowInviteDropdown(!showInviteDropdown)}
                    className="p-1.5 bg-primary-100 hover:bg-primary-200 text-primary-700 rounded transition"
                    title="Share invite link"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                    </svg>
                  </button>

                  {/* Dropdown Menu */}
                  {showInviteDropdown && (
                    <div className="absolute top-full left-0 mt-2 w-[min(24rem,calc(100vw-1.5rem))] bg-white border-2 border-primary-200 rounded-lg shadow-2xl z-50">
                      <div className="p-4">
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="text-sm font-semibold text-gray-900">Invite to Meeting</h3>
                          <button
                            onClick={() => setShowInviteDropdown(false)}
                            className="text-gray-400 hover:text-gray-600 transition"
                            title="Close"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                        
                        <div className="flex items-center gap-2 mb-3">
                          <input
                            id="invite-link-input"
                            type="text"
                            value={inviteLink}
                            readOnly
                            className="flex-1 bg-gray-50 border border-gray-300 text-gray-900 text-sm px-3 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 select-all"
                            onClick={(e) => (e.target as HTMLInputElement).select()}
                          />
                          <button
                            onClick={copyInviteLink}
                            className={`px-4 py-2 rounded-lg font-medium transition flex items-center gap-2 ${
                              copiedToClipboard
                                ? 'bg-green-500 hover:bg-green-600 text-white'
                                : 'bg-primary-600 hover:bg-primary-700 text-white'
                            }`}
                            title="Copy link"
                          >
                            {copiedToClipboard ? (
                              <>
                                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                </svg>
                                <span>Copied!</span>
                              </>
                            ) : (
                              <>
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                </svg>
                                <span>Copy</span>
                              </>
                            )}
                          </button>
                        </div>
                        
                        <p className="text-xs text-gray-500">
                          Share this link with others to invite them to the meeting. The link is automatically copied when you click the copy button.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
            {participantArray.length > 0 && (
              <div className="text-gray-900 shrink-0">
                <p className="hidden text-sm text-gray-600 sm:block">Participants</p>
                <p className="text-sm font-semibold text-primary-700 sm:text-lg">{participantArray.length + 1}</p>
              </div>
            )}
            {isHost && (
              <span
                title="You are the host — you can mute any participant"
                className="shrink-0 rounded-full bg-primary-100 border border-primary-300 text-primary-700 text-[10px] sm:text-xs font-semibold px-2 py-0.5"
              >
                Host
              </span>
            )}
            {isConnecting && (
              <div className="hidden items-center gap-2 text-primary-600 sm:flex">
                <div className="w-2 h-2 bg-primary-500 rounded-full animate-pulse"></div>
                <span className="text-sm">Connecting...</span>
              </div>
            )}
            {isRecording && (
              <div className="hidden items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg px-3 py-1.5 sm:flex">
                <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
                <span className="text-red-400 text-sm font-medium">Recording</span>
              </div>
            )}
            {useSFU && (
              <div className="hidden items-center gap-2 bg-primary-100 border border-primary-300 rounded-lg px-3 py-1.5 sm:flex">
                <span className="text-primary-700 text-sm font-medium">SFU Mode</span>
              </div>
            )}
            {error && (
              <div className="flex items-center gap-2 text-red-600 min-w-0">
                <span className="text-xs sm:text-sm truncate max-w-[40vw]">{error}</span>
              </div>
            )}
          </div>
          <button
            onClick={handleLeave}
            className="bg-red-600 hover:bg-red-700 text-white px-3 py-2 rounded-lg font-medium transition flex items-center gap-2 shrink-0 sm:px-4"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span className="hidden sm:inline">Leave</span>
          </button>
        </div>
      </div>

      {/* Host action notice (e.g. "You were muted by ...") */}
      {notice && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[60] bg-gray-900/90 text-white text-sm px-4 py-2 rounded-lg shadow-lg max-w-[90vw] text-center">
          {notice}
        </div>
      )}

      {/* Video Grid — spotlight layout focuses one tile and strips the rest to the bottom */}
      <div className="flex-1 p-2 pt-16 grid gap-3 overflow-auto scroll-container sm:p-4 sm:pt-20 sm:pb-24" style={isFocusMode ? {
        gridTemplateRows: 'minmax(0, 1fr) auto',
        maxWidth: '100vw',
        paddingBottom: 'max(6rem, calc(env(safe-area-inset-bottom, 0px) + 6.5rem))'
      } : {
        gridTemplateColumns: `repeat(auto-fit, minmax(min(280px, 100%), 1fr))`,
        gridAutoRows: 'minmax(200px, 1fr)',
        maxWidth: '100vw',
        paddingBottom: 'max(6rem, calc(env(safe-area-inset-bottom, 0px) + 6.5rem))'
      }}>
        {/* Local Video */}
        <div className={`${focusTarget === 'local'
          ? 'order-1 row-start-1 min-h-0 border-primary-400'
          : isFocusMode
            ? 'order-2 row-start-2 w-40 h-24 shrink-0 cursor-pointer hover:border-primary-400 border-primary-200'
            : 'border-primary-200'
        } relative bg-gray-100 rounded-lg overflow-hidden border-2 shadow-lg`}>
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className={focusTarget === 'local' ? 'w-full h-full object-contain' : 'w-full h-full object-cover'}
          />
          <div className="absolute bottom-2 left-2 bg-primary-600 text-white px-2 py-1 rounded text-sm font-medium shadow-md">
            {userName} (You)
          </div>
          {isVideoMuted && !isScreenSharing && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 sm:gap-2 bg-gradient-to-br from-primary-50 to-primary-100 px-2">
              <div className={`rounded-full bg-primary-500 text-white flex items-center justify-center font-semibold shadow-md ${
                focusTarget === 'local'
                  ? 'w-20 h-20 sm:w-24 sm:h-24 text-2xl sm:text-3xl'
                  : isFocusMode
                    ? 'w-8 h-8 text-xs'
                    : 'w-16 h-16 sm:w-20 sm:h-20 text-xl sm:text-2xl'
              }`}>
                {getInitials(userName || 'You')}
              </div>
              <div className={`text-gray-900 font-semibold text-center max-w-full truncate px-2 ${
                focusTarget === 'local'
                  ? 'text-base sm:text-xl'
                  : isFocusMode
                    ? 'hidden'
                    : 'text-sm sm:text-lg'
              }`}>
                {userName}
              </div>
            </div>
          )}
          {focusTarget === 'local' ? (
            <button
              onClick={() => setFocusedSocketId(null)}
              className="absolute top-2 right-2 z-10 bg-white/90 hover:bg-white text-gray-900 text-xs sm:text-sm px-3 py-1.5 rounded-full shadow-md font-medium"
            >
              ✕ Show all
            </button>
          ) : (
            <button
              onClick={() => setFocusedSocketId('local')}
              title={isScreenSharing ? 'You are sharing' : 'Spotlight your video'}
              className="absolute top-2 right-2 z-10 bg-primary-600 hover:bg-primary-700 text-white text-xs sm:text-sm px-3 py-1.5 rounded-full shadow-md font-medium"
            >
              ⤢ Focus
            </button>
          )}
        </div>

        {/* Remote Videos Container */}
        <div ref={remoteVideoContainerRef} className="contents"></div>
      </div>

      {/* Controls */}
      <div className="absolute bottom-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-md border-t border-primary-200 shadow-lg" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <div className="flex items-center justify-center gap-3 px-3 py-3 sm:gap-4 sm:px-6 sm:py-4">
          <button
            onClick={toggleMute}
            className={`p-3 rounded-full transition-all sm:p-4 ${
              isMuted 
                ? 'bg-red-600 hover:bg-red-700 text-white' 
                : 'bg-primary-100 hover:bg-primary-200 text-primary-700'
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

          <button
            onClick={toggleVideo}
            className={`p-3 rounded-full transition-all sm:p-4 ${
              isVideoMuted 
                ? 'bg-red-600 hover:bg-red-700 text-white' 
                : 'bg-primary-100 hover:bg-primary-200 text-primary-700'
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

          {/* Screen sharing — needs getDisplayMedia (not available on iOS) */}
          {supportsScreenShare && (
          <button
            onClick={toggleScreenShare}
            className={`p-3 rounded-full transition-all sm:p-4 ${
              isScreenSharing 
                ? 'bg-primary-600 hover:bg-primary-700 text-white' 
                : 'bg-primary-100 hover:bg-primary-200 text-primary-700'
            }`}
            title={isScreenSharing ? 'Stop sharing' : 'Share screen'}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </button>
          )}

          {/* Recording Button — also relies on getDisplayMedia */}
          {supportsScreenShare && (
          <button
            onClick={toggleRecording}
            className={`p-3 rounded-full transition-all sm:p-4 ${
              isRecording 
                ? 'bg-red-600 hover:bg-red-700 text-white' 
                : 'bg-primary-100 hover:bg-primary-200 text-primary-700'
            }`}
            title={isRecording ? 'Stop recording' : 'Start recording browser'}
          >
            {isRecording ? (
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd" />
              </svg>
            ) : (
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
              </svg>
            )}
          </button>
          )}

          {/* Fullscreen — not offered on iOS */}
          {canFullscreen && (
            <button
              onClick={toggleFullscreen}
              className="p-3 rounded-full transition-all sm:p-4 bg-primary-100 hover:bg-primary-200 text-primary-700"
              title={isFullscreen ? 'Exit fullscreen' : 'Go fullscreen'}
            >
              {isFullscreen ? (
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V5.5A1.5 1.5 0 007.5 4h-3A1.5 1.5 0 003 5.5v3A1.5 1.5 0 004.5 10H8m1 5v3.5a1.5 1.5 0 001.5 1.5h3a1.5 1.5 0 001.5-1.5v-3m0-5V5.5A1.5 1.5 0 0016.5 4h-3A1.5 1.5 0 0112 5.5V9" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.5 13.5H21v6m-4-4l4 4m-4-6h4v3" />
                </svg>
              ) : (
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V5.5A1.5 1.5 0 015.5 4H8m8 0h2.5A1.5 1.5 0 0120 5.5V8m0 8v2.5a1.5 1.5 0 01-1.5 1.5H16m-8 0H5.5A1.5 1.5 0 014 16.5V14" />
                </svg>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Message Notification Bar */}
      {!isChatOpen && messageCount > 0 && (
        <div className="absolute bottom-[calc(6.5rem+env(safe-area-inset-bottom,0px))] left-1/2 -translate-x-1/2 z-50 max-w-[calc(100vw-1rem)] sm:bottom-24">
          <div className="bg-primary-600 text-white px-4 sm:px-6 py-3 rounded-lg shadow-lg flex items-center gap-2 sm:gap-3 animate-pulse">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <span className="font-medium">
              {messageCount} new message{messageCount !== 1 ? 's' : ''}
            </span>
            <button
              onClick={() => setIsChatOpen(true)}
              className="ml-2 underline hover:no-underline font-semibold"
            >
              Open Chat
            </button>
          </div>
        </div>
      )}

      {/* Chat Component */}
      {socketRef.current && (
        <Chat
          socket={socketRef.current}
          roomId={roomName}
          userName={userName}
          userId={userIdRef.current}
          isOpen={isChatOpen}
          onToggle={() => {
            setIsChatOpen(!isChatOpen)
            if (isChatOpen) {
              setMessageCount(0) // Reset count when closing chat
            }
          }}
          onMessageCountChange={setMessageCount}
        />
      )}
    </div>
  )
}
