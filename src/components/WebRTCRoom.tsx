import { useCallback, useEffect, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'
import { WebRTCManager } from '../lib/webrtc'
import { WebRTCSFUManager } from '../lib/webrtc-sfu'
import { SFU_CONFIG } from '../config/webrtc'
import { playHandConfirmSound, playHandRaiseSound, playReactionSound, unlockSounds } from '../lib/sounds'
import { captureError, trackEvent } from '../lib/telemetry'
import { countActivity, loadReports, saveReport } from '../lib/meetingReport'
import type { ActivityEntry, MeetingReport } from '../lib/meetingReport'
import Chat from './Chat'
import MeetingReportModal from './MeetingReport'

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
  handRaised: boolean
}

type QualityLevel = 'good' | 'poor' | 'critical'

// Slow-network thresholds. A short blip should not kick anyone out.
const POOR_AFTER_MS = 5000
const CRITICAL_AFTER_MS = 15000
const AUTO_LEAVE_AFTER_MS = 30000

// Two-letter initials for the avatar shown when a camera is off
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
  const initials = parts.map((p) => p[0]?.toUpperCase() ?? '').join('')
  return initials || '?'
}

// Quick-reaction palette shown above the call controls
const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '👏', '😮', '😢', '🔥']

// Line-art icons for the spotlight buttons. Corner brackets read as
// "expand to full screen"; the four-tile grid reads as "show everyone again".
// Kept as strings so the DOM-created remote tiles can share them with the JSX.
const FOCUS_ICON = `<svg class="meeting-focus-icon h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/></svg>`
const SHOW_ALL_ICON = `<svg class="meeting-focus-icon h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.5"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.5"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.5"/><rect x="14" y="14" width="6.5" height="6.5" rx="1.5"/></svg>`

interface FloatingReaction {
  id: string
  emoji: string
  userName: string
  left: number // percentage across the stage
  swirlAlt: boolean // mirrored swirl direction for variety
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
  // Meeting activity report (host only) - metadata, never message contents
  const [reportOpen, setReportOpen] = useState(false)
  const [liveReport, setLiveReport] = useState<MeetingReport | null>(null)
  const startedAtRef = useRef(Date.now())
  const activityRef = useRef<ActivityEntry[]>([])
  const participantsSeenRef = useRef<Set<string>>(new Set())
  const participantNamesRef = useRef<Map<string, string>>(new Map())
  const [showInviteDropdown, setShowInviteDropdown] = useState(false)
  const [copiedToClipboard, setCopiedToClipboard] = useState(false)
  // Host (room admin) is the first participant; they can mute others.
  const [hostSocketId, setHostSocketId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Emoji reactions: palette visibility + the reactions currently floating up
  const [showReactions, setShowReactions] = useState(false)
  const [reactions, setReactions] = useState<FloatingReaction[]>([])
  const reactionTimersRef = useRef<number[]>([])
  const reactionPaletteTimerRef = useRef<number | null>(null)
  // Raise hand + sound preference
  const [isHandRaised, setIsHandRaised] = useState(false)
  const [soundMuted, setSoundMuted] = useState(() => {
    try {
      return window.localStorage.getItem('meetup:sound-muted') === '1'
    } catch {
      return false
    }
  })
  const handRaisedRef = useRef(false)
  const soundMutedRef = useRef(soundMuted)
  // Host-level switch: mute reaction sounds for the whole room
  const [roomSoundMuted, setRoomSoundMuted] = useState(false)
  const roomSoundMutedRef = useRef(false)
  // Hand states received before a participant's stream arrives, replayed when
  // their tile is created.
  const pendingHandStatesRef = useRef<Map<string, boolean>>(new Map())
  const remoteVideoContainerRef = useRef<HTMLDivElement>(null)
  const inviteDropdownRef = useRef<HTMLDivElement>(null)
  const userIdRef = useRef<string>('')

  // --- Connection quality / slow-network handling ---------------------------
  const [connectionQuality, setConnectionQuality] = useState<QualityLevel>('good')
  const [leaveSeconds, setLeaveSeconds] = useState<number | null>(null)
  const [badPeerIds, setBadPeerIds] = useState<Set<string>>(new Set())
  const [poorPeers, setPoorPeers] = useState<Map<string, QualityLevel>>(new Map())
  const qualityLevelRef = useRef<QualityLevel>('good')
  const disconnectedAtRef = useRef<number | null>(null)
  const peerStatesRef = useRef<Map<string, 'ok' | 'bad' | 'connecting'>>(new Map())
  const peerBadAtRef = useRef<number | null>(null)
  const troubleStartedAtRef = useRef<number | null>(null)
  const deadlineExtensionRef = useRef(0)
  const autoLeavingRef = useRef(false)
  const leavingRef = useRef(false)
  const handleLeaveRef = useRef<() => void>(() => {})
  const qualityMonitorStartedRef = useRef(0)

  // Current camera/mic state, kept in a ref so socket handlers registered once
  // always broadcast the latest values (no stale closures).
  const mediaStateRef = useRef({ videoEnabled: !isAudioOnly, audioEnabled: true })

  const broadcastMediaState = () => {
    const s = socketRef.current
    if (s?.connected) {
      s.emit('media-state', { roomId: roomName, ...mediaStateRef.current })
    }
  }

  const broadcastHandState = () => {
    const s = socketRef.current
    if (s?.connected) {
      s.emit('hand-state', { roomId: roomName, raised: handRaisedRef.current })
    }
  }

  // Tell the room to spotlight us while we share, and to release it after
  const broadcastScreenShareState = (sharing: boolean) => {
    const s = socketRef.current
    if (s?.connected) {
      s.emit('screen-share-state', { roomId: roomName, sharing })
    }
  }

  // Keep the ref (read by socket handlers) in sync and persist the preference
  useEffect(() => {
    soundMutedRef.current = soundMuted
    try {
      window.localStorage.setItem('meetup:sound-muted', soundMuted ? '1' : '0')
    } catch {
      // Ignore storage failures (private mode etc.)
    }
  }, [soundMuted])

  // Prepare the audio context right after joining (the Join tap is our gesture)
  useEffect(() => {
    unlockSounds()
  }, [])

  // No sound when either you or the host has muted sounds
  const soundsOff = () => soundMutedRef.current || roomSoundMutedRef.current

  const recordActivity = (type: ActivityEntry['type'], name?: string, detail?: string) => {
    activityRef.current.push({ at: Date.now(), type, name, detail })
    if (activityRef.current.length > 500) activityRef.current.shift()
  }

  const noteParticipant = (name: string, socketId?: string) => {
    const clean = name || 'Guest'
    if (socketId) participantNamesRef.current.set(socketId, clean)
    if (!participantsSeenRef.current.has(clean)) {
      participantsSeenRef.current.add(clean)
      recordActivity('join', clean)
    }
  }

  const handleChatActivity = useCallback((name: string) => {
    recordActivity('message', name)
  }, [])

  // Fed by WebRTCManager whenever a peer's connection state changes.
  const handlePeerState = useCallback((socketId: string, state: RTCPeerConnectionState) => {
    const status = state === 'connected'
      ? 'ok'
      : state === 'disconnected' || state === 'failed' || state === 'closed'
        ? 'bad'
        : 'connecting'
    peerStatesRef.current.set(socketId, status)

    const bad = new Set<string>()
    peerStatesRef.current.forEach((value, id) => { if (value === 'bad') bad.add(id) })
    setBadPeerIds(bad)

    const allBad = peerStatesRef.current.size > 0 && bad.size === peerStatesRef.current.size
    if (allBad) {
      if (!peerBadAtRef.current) peerBadAtRef.current = Date.now()
    } else {
      peerBadAtRef.current = null
    }
  }, [])

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
      if (disconnectedAtRef.current !== null) {
        trackEvent('signaling_reconnected')
        // Signaling is back — clear the warning immediately rather than
        // leaving a stale "leaving in 0s" banner up during the peer grace period.
        qualityLevelRef.current = 'good'
        troubleStartedAtRef.current = null
        deadlineExtensionRef.current = 0
        setConnectionQuality('good')
        setLeaveSeconds(null)
        setNotice(null)
        socket.emit('connection-quality', { roomId: roomName, level: 'good' })
      }
      disconnectedAtRef.current = null
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
                      audioEnabled: existing?.audioEnabled ?? true,
                      handRaised: existing?.handRaised ?? pendingHandStatesRef.current.get(socketId) ?? false
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
              captureError(err, 'sfu-init')
              setError(err.message || 'Failed to initialize SFU')
            }
          })

          sfuSocket.on('connect_error', (err) => {
            captureError(err, 'sfu-connect')
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
                    audioEnabled: existing?.audioEnabled ?? true,
                    handRaised: existing?.handRaised ?? pendingHandStatesRef.current.get(socketId) ?? false
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
                pendingHandStatesRef.current.delete(socketId)
                peerStatesRef.current.delete(socketId)
                setBadPeerIds(prev => {
                  const next = new Set(prev)
                  next.delete(socketId)
                  return next
                })
              },
              handlePeerState
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

        // On reconnect our socket has a new id: drop peers from the old session
        // and give fresh connections a short grace period before monitoring.
        if (!useSFU) webrtcManagerRef.current?.resetPeers()
        setParticipants(new Map())
        setBadPeerIds(new Set())
        peerStatesRef.current.clear()
        peerBadAtRef.current = null
        qualityMonitorStartedRef.current = Date.now() + 8000

        // Join the room for chat + WebRTC signaling. Done after the manager and
        // local stream are ready so existing participants are announced to
        // listeners that are already set up to handle them.
        socket.emit('join-room', {
          roomId: roomName,
          userId,
          userName
        })
        // Announce current camera/mic state so existing participants render our
        // tile correctly from the start.
        broadcastMediaState()
        noteParticipant(userName)
        trackEvent('meeting_joined', { audioOnly: isAudioOnly ? 1 : 0 })
      } catch (err: any) {
        captureError(err, 'webrtc-init')
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
      captureError(err, 'signaling-connect')
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

    // People already in the room when we arrived
    socket.on('existing-participants', (list: Array<{ userName?: string; socketId?: string }>) => {
      list.forEach((person) => noteParticipant(person.userName || 'Guest', person.socketId))
    })

    // A newcomer can't know our current state — tell them as soon as they join
    socket.on('user-joined', ({ userName: joinedName, socketId: joinedId }: { userName?: string; socketId?: string }) => {
      noteParticipant(joinedName || 'Guest', joinedId)
      broadcastMediaState()
      if (handRaisedRef.current) broadcastHandState()
    })

    socket.on('user-left', ({ socketId: leftId }: { socketId?: string }) => {
      if (leftId) {
        const name = participantNamesRef.current.get(leftId)
        if (name) recordActivity('leave', name)
        participantNamesRef.current.delete(leftId)
      }
    })

    // Who is the host (room admin) — first participant, promoted if they leave
    socket.on('room-info', ({ hostSocketId: hostId, soundMuted: roomMuted }: { hostSocketId: string; soundMuted?: boolean }) => {
      setHostSocketId(hostId)
      if (typeof roomMuted === 'boolean') {
        roomSoundMutedRef.current = roomMuted
        setRoomSoundMuted(roomMuted)
      }
    })
    socket.on('host-changed', ({ hostSocketId: hostId }: { hostSocketId: string }) => {
      setHostSocketId(hostId)
    })

    // The host muted or unmuted reaction sounds for the whole room
    socket.on('room-sound', ({ muted, byName }: { muted: boolean; byName?: string }) => {
      roomSoundMutedRef.current = muted
      setRoomSoundMuted(muted)
      setNotice(
        muted
          ? `Reaction sounds muted for everyone${byName ? ` by ${byName}` : ''}`
          : 'Reaction sounds turned back on'
      )
      window.setTimeout(() => setNotice(null), 3000)
    })

    // The host muted us
    socket.on('muted-by-host', ({ byName }: { byName?: string }) => {
      setIsMuted(true)
      if (useSFU && sfuManagerRef.current) {
        // Both managers take `enabled`, so muting means false.
        sfuManagerRef.current.toggleAudio(false)
      } else if (webrtcManagerRef.current) {
        webrtcManagerRef.current.toggleAudio(false)
      }
      mediaStateRef.current.audioEnabled = false
      broadcastMediaState()
      setNotice(`You were muted by ${byName || 'the host'}`)
      window.setTimeout(() => setNotice(null), 4000)
    })

    // Emoji reactions from anyone in the room (our own included)
    socket.on('reaction', ({ socketId, emoji, userName: reactorName }: { socketId?: string; emoji: string; userName?: string }) => {
      if (!emoji) return
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const left = 12 + Math.random() * 76
      setReactions(prev => [...prev.slice(-14), { id, emoji, userName: reactorName || 'Someone', left, swirlAlt: Math.random() < 0.5 }])
      recordActivity('reaction', reactorName || 'Someone', emoji)
      // No sound for your own reaction — the float is already the feedback
      if (socketId !== socketRef.current?.id && !soundsOff()) playReactionSound()
      // Matches the 3s float animation in tailwind.config.js
      const timer = window.setTimeout(() => {
        setReactions(prev => prev.filter(r => r.id !== id))
      }, 3100)
      reactionTimersRef.current.push(timer)
    })

    // Someone raised or lowered their hand
    socket.on('hand-state', ({ socketId, userName: handUserName, raised }: { socketId: string; userName?: string; raised: boolean }) => {
      // Our own raise is applied locally already
      if (socketId === socketRef.current?.id) return
      pendingHandStatesRef.current.set(socketId, raised)
      setParticipants(prev => {
        const existing = prev.get(socketId)
        if (!existing) return prev
        const newMap = new Map(prev)
        newMap.set(socketId, { ...existing, handRaised: raised })
        return newMap
      })
      if (raised) {
        recordActivity('hand', handUserName || 'A participant')
        if (!soundsOff()) playHandRaiseSound()
        setNotice(`${handUserName || 'A participant'} raised their hand`)
        window.setTimeout(() => setNotice(null), 3500)
      }
    })

    // Another participant told the room their connection is struggling.
    socket.on('connection-quality', ({ socketId, userName: peerName, level }: { socketId: string; userName?: string; level: QualityLevel }) => {
      setPoorPeers(prev => {
        const next = new Map(prev)
        if (level === 'good') next.delete(socketId)
        else next.set(socketId, level)
        return next
      })
      if (level !== 'good') {
        setNotice(`${peerName || 'A participant'} has a weak connection`)
        window.setTimeout(() => setNotice(null), 3500)
      }
    })

    // Auto-spotlight whoever starts sharing so a phone rotated to landscape
    // immediately shows that person's screen full-size.
    socket.on('screen-share-state', ({ socketId, userName: sharerName, sharing }: { socketId: string; userName?: string; sharing: boolean }) => {
      if (socketId === socketRef.current?.id) return
      if (sharing) {
        setFocusedSocketId(socketId)
        setNotice(`${sharerName || 'A participant'} is sharing — tap ✕ to show all`)
        window.setTimeout(() => setNotice(null), 3500)
      } else {
        setFocusedSocketId(prev => (prev === socketId ? null : prev))
      }
    })

    socket.on('reconnect_failed', () => {
      captureError(new Error('signaling reconnect failed'), 'signaling-reconnect')
      setError('Connection lost. Please refresh the page.')
      setIsConnecting(false)
    })

    socket.on('disconnect', () => {
      if (leavingRef.current) return
      disconnectedAtRef.current = Date.now()
      console.warn('Disconnected from signaling server')
      trackEvent('signaling_disconnected')
    })

    return () => {
      reactionTimersRef.current.forEach((timer) => window.clearTimeout(timer))
      reactionTimersRef.current = []
      if (reactionPaletteTimerRef.current) {
        window.clearTimeout(reactionPaletteTimerRef.current)
        reactionPaletteTimerRef.current = null
      }
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
  const raisedByNames = [
    ...(isHandRaised ? [userName] : []),
    ...Array.from(participants.values())
      .filter((p) => p.handRaised)
      .map((p) => p.userName || 'Participant'),
  ]

  const buildReport = (endedAt: number): MeetingReport => {
    const activity = [...activityRef.current]
    return {
      id: `${startedAtRef.current}-${Math.random().toString(36).slice(2, 8)}`,
      roomName,
      startedAt: startedAtRef.current,
      endedAt,
      host: isHost,
      participants: Array.from(participantsSeenRef.current),
      activity,
      counts: countActivity(activity),
    }
  }

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
        ? 'meeting-focused-tile relative bg-gray-100 rounded-lg overflow-hidden border-2 border-primary-400 shadow-xl order-1 row-start-1 min-h-0'
        : isFocusMode
          ? 'meeting-thumb relative bg-gray-100 rounded-lg overflow-hidden border-2 border-primary-200 shadow-lg order-2 row-start-2 w-40 h-24 shrink-0 cursor-pointer hover:border-primary-400'
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
      focusBtn.innerHTML = participantIsFocused
        ? `${SHOW_ALL_ICON}<span>Show all</span>`
        : `${FOCUS_ICON}<span>Focus</span>`
      focusBtn.title = participantIsFocused ? 'Show all participants' : 'Spotlight this video'
      focusBtn.className = participantIsFocused
        ? 'meeting-exit-focus absolute top-2 right-2 z-10 flex items-center gap-1.5 bg-white/90 hover:bg-white text-gray-900 text-xs sm:text-sm px-3 py-1.5 rounded-full shadow-md font-medium'
        : 'absolute top-1.5 right-1.5 z-10 flex items-center gap-1 bg-primary-600 hover:bg-primary-700 text-white text-[10px] px-2 py-1 rounded-full shadow-md font-medium'
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
        muteBtn.className = `${participantIsFocused
          ? 'absolute top-2 left-2 z-10 bg-white/90 hover:bg-white text-gray-900 text-xs sm:text-sm px-3 py-1.5 rounded-full shadow-md font-medium'
          : 'absolute top-1.5 left-1.5 z-10 bg-white/90 hover:bg-white text-gray-900 text-[10px] px-2 py-1 rounded-full shadow-md font-medium'} meeting-host-mute`
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

      // Weak-connection badge reported by that participant themselves.
      const peerQuality = poorPeers.get(participant.socketId)
      if (peerQuality) {
        const weakBadge = document.createElement('div')
        weakBadge.className = participantIsFocused
          ? 'absolute top-10 left-1/2 z-10 -translate-x-1/2 bg-red-600 text-white text-xs font-semibold px-2 py-1 rounded-full shadow-md'
          : 'absolute bottom-1 left-1/2 z-10 -translate-x-1/2 bg-red-600 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full shadow-md'
        weakBadge.textContent = peerQuality === 'critical' ? '⚠ Disconnecting' : '⚠ Weak connection'
        weakBadge.title = `${participant.userName || 'Participant'} has a ${peerQuality} connection`
        container.appendChild(weakBadge)
      }

      // Our own peer link to them is down: tell the user we're recovering
      // instead of leaving a black tile that looks like a broken camera.
      if (badPeerIds.has(participant.socketId)) {
        const reconnecting = document.createElement('div')
        reconnecting.className = 'absolute inset-0 z-[5] bg-black/55 flex items-center justify-center pointer-events-none'
        const reconnectingText = document.createElement('div')
        reconnectingText.className = 'text-white text-xs sm:text-sm font-medium bg-black/50 px-2 py-1 rounded'
        reconnectingText.textContent = 'Reconnecting…'
        reconnecting.appendChild(reconnectingText)
        container.appendChild(reconnecting)
      }

      // Raised-hand badge, centred at the bottom so it never fights with the
      // host mute button, name label or mic indicator.
      if (participant.handRaised) {
        const handBadge = document.createElement('div')
        handBadge.className = participantIsFocused
          ? 'absolute top-2 left-1/2 z-10 -translate-x-1/2 text-2xl leading-none animate-bounce'
          : 'absolute top-1 left-1/2 z-10 -translate-x-1/2 text-lg leading-none animate-bounce'
        handBadge.style.filter = 'drop-shadow(0 1px 3px rgba(0,0,0,0.9))'
        handBadge.textContent = '✋'
        handBadge.title = `${participant.userName || 'Participant'} raised their hand`
        container.appendChild(handBadge)
      }

      // Double-tap / double-click a tile to send a quick 👍
      container.ondblclick = (e) => {
        e.stopPropagation()
        emitReaction('👍')
      }
      // Mobile browsers don't always fire dblclick, so detect a double tap here
      let lastTapAt = 0
      container.addEventListener('touchend', (e) => {
        if ((e.target as HTMLElement).closest('button')) return
        const now = Date.now()
        if (now - lastTapAt < 350) {
          emitReaction('👍')
          lastTapAt = 0
        } else {
          lastTapAt = now
        }
      })
      container.style.touchAction = 'manipulation'
      container.title = participantIsFocused ? 'Double-click to react 👍' : 'Double-click to react 👍 · click to focus'

      if (remoteVideoContainerRef.current) {
        remoteVideoContainerRef.current.appendChild(container)
      }
    })
  }, [participants, focusTarget, isFocusMode, isHost, roomName, poorPeers, badPeerIds])

  const toggleMute = () => {
    const newMutedState = !isMuted
    if (useSFU && sfuManagerRef.current) {
      // Both managers take `enabled`, not `muted`.
      sfuManagerRef.current.toggleAudio(!newMutedState)
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
      // Both managers take `enabled`, not `muted`.
      sfuManagerRef.current.toggleVideo(!newVideoMutedState)
    } else if (webrtcManagerRef.current) {
      webrtcManagerRef.current.toggleVideo(!newVideoMutedState)
    }
    setIsVideoMuted(newVideoMutedState)
    mediaStateRef.current.videoEnabled = !newVideoMutedState
    broadcastMediaState()
  }

  // Fire a reaction to everyone in the room (used by the palette and by
  // double-tapping a tile)
  const emitReaction = (emoji: string) => {
    socketRef.current?.emit('reaction', { roomId: roomName, emoji })
  }

  // Send an emoji reaction to everyone in the room, then close the palette
  // right away so it never covers the call after a pick.
  const sendReaction = (emoji: string) => {
    emitReaction(emoji)
    trackEvent('reaction_sent')
    if (reactionPaletteTimerRef.current) {
      window.clearTimeout(reactionPaletteTimerRef.current)
      reactionPaletteTimerRef.current = null
    }
    setShowReactions(false)
  }

  // Raise/lower hand. Everyone sees a hand badge on the tile.
  const toggleHand = () => {
    const next = !handRaisedRef.current
    handRaisedRef.current = next
    setIsHandRaised(next)
    broadcastHandState()
    if (next) trackEvent('hand_raised')
    if (!soundsOff()) playHandConfirmSound()
  }

  const toggleReactionPalette = () => {
    if (showReactions) {
      if (reactionPaletteTimerRef.current) {
        window.clearTimeout(reactionPaletteTimerRef.current)
        reactionPaletteTimerRef.current = null
      }
      setShowReactions(false)
    } else {
      setShowReactions(true)
      // Close by itself if nobody picks an emoji
      if (reactionPaletteTimerRef.current) {
        window.clearTimeout(reactionPaletteTimerRef.current)
      }
      reactionPaletteTimerRef.current = window.setTimeout(() => {
        setShowReactions(false)
        reactionPaletteTimerRef.current = null
      }, 8000)
    }
  }

  // Double-tap the local tile to react 👍 as well
  const localTapRef = useRef(0)
  const handleLocalTileTap = (e: React.MouseEvent | React.TouchEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    const now = Date.now()
    if (now - localTapRef.current < 350) {
      emitReaction('👍')
      localTapRef.current = 0
    } else {
      localTapRef.current = now
    }
  }

  // Host: mute sounds for the whole room. Everyone else: mute only themselves.
  const toggleSounds = () => {
    if (isHost) {
      socketRef.current?.emit('room-sound', { roomId: roomName, muted: !roomSoundMuted })
    } else {
      setSoundMuted((muted) => !muted)
    }
  }

  const soundButtonTitle = isHost
    ? roomSoundMuted
      ? 'Turn reaction sounds back on for everyone'
      : 'Mute reaction sounds for everyone'
    : roomSoundMuted
      ? 'Reaction sounds are muted for everyone by the host'
      : soundMuted
        ? 'Unmute reaction sounds'
        : 'Mute reaction sounds'

  const soundIsOff = isHost ? roomSoundMuted : soundMuted || roomSoundMuted

  const toggleScreenShare = async () => {
    try {
      if (isScreenSharing) {
        if (useSFU && sfuManagerRef.current) {
          await sfuManagerRef.current.stopScreenShare()
        } else if (webrtcManagerRef.current) {
          await webrtcManagerRef.current.stopScreenShare()
        }
        setIsScreenSharing(false)
        broadcastScreenShareState(false)
      } else {
        if (useSFU && sfuManagerRef.current) {
          await sfuManagerRef.current.startScreenShare()
        } else if (webrtcManagerRef.current) {
          await webrtcManagerRef.current.startScreenShare()
        }
        setIsScreenSharing(true)
        broadcastScreenShareState(true)
        recordActivity('screen-share', userName)
        trackEvent('screen_share')
      }
    } catch (error) {
      captureError(error, 'screen-share')
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
    // Guard against the manual Leave button and the auto-leave timer both
    // firing, and stop the quality monitor from treating our own disconnect
    // as a network failure while we tear down.
    if (leavingRef.current) return
    leavingRef.current = true

    const endedAt = Date.now()
    const report = buildReport(endedAt)
    if (report.participants.length > 0) saveReport(report)
    trackEvent('meeting_ended', {
      durationSec: Math.round((endedAt - report.startedAt) / 1000),
      messages: report.counts.message || 0,
      reactions: report.counts.reaction || 0,
      host: isHost ? 1 : 0,
    })

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

  // The auto-leave timer reads this ref so it always calls the newest handler.
  handleLeaveRef.current = handleLeave

  // Give a struggling connection one more grace window before auto-leave.
  const postponeAutoLeave = () => {
    deadlineExtensionRef.current += 15000
    trackEvent('auto_leave_postponed')
    setNotice(null)
  }

  // --- Slow-network monitoring ----------------------------------------------
  // Escalates good -> poor -> critical from signaling loss and/or every peer
  // going bad, then leaves the call at the severe threshold. Without this, a
  // failed peer was destroyed locally while the React view stayed open, which
  // is the "I'm still in the call but everyone sees me left" zombie state.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (leavingRef.current || autoLeavingRef.current) return
      const now = Date.now()
      if (now < qualityMonitorStartedRef.current) return

      const signalingDownAt = disconnectedAtRef.current
      const peersBadAt = peerBadAtRef.current
      const inTrouble = signalingDownAt !== null || peersBadAt !== null

      if (inTrouble) {
        if (troubleStartedAtRef.current === null) {
          troubleStartedAtRef.current = Math.min(
            signalingDownAt ?? Infinity,
            peersBadAt ?? Infinity
          )
        }
        const elapsed = now - troubleStartedAtRef.current

        const level: QualityLevel = elapsed >= CRITICAL_AFTER_MS
          ? 'critical'
          : elapsed >= POOR_AFTER_MS
            ? 'poor'
            : 'good'

        if (level !== qualityLevelRef.current) {
          qualityLevelRef.current = level
          setConnectionQuality(level)
          socketRef.current?.emit('connection-quality', { roomId: roomName, level })
          trackEvent('connection_quality', { level, elapsedSec: Math.round(elapsed / 1000) })
        }

        if (level === 'critical') {
          const deadline = AUTO_LEAVE_AFTER_MS + deadlineExtensionRef.current
          setLeaveSeconds(Math.max(0, Math.ceil((deadline - elapsed) / 1000)))
          if (elapsed >= deadline) {
            autoLeavingRef.current = true
            trackEvent('auto_left_slow_connection', { elapsedSec: Math.round(elapsed / 1000) })
            setNotice('Connection lost — leaving the meeting')
            handleLeaveRef.current()
          }
        } else {
          setLeaveSeconds(null)
        }
      } else {
        if (troubleStartedAtRef.current !== null) {
          trackEvent('connection_recovered', {
            elapsedSec: Math.round((now - troubleStartedAtRef.current) / 1000)
          })
          troubleStartedAtRef.current = null
          deadlineExtensionRef.current = 0
          setNotice(null)
        }
        if (qualityLevelRef.current !== 'good') {
          qualityLevelRef.current = 'good'
          setConnectionQuality('good')
          socketRef.current?.emit('connection-quality', { roomId: roomName, level: 'good' })
        }
        setLeaveSeconds(null)
      }
    }, 1000)

    return () => window.clearInterval(timer)
  }, [roomName])

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
    <div className={`meeting-room h-screen w-screen relative bg-white flex flex-col overflow-hidden ${isFocusMode ? 'meeting-focus-active' : ''}`} style={{ height: '100dvh' }}>
      {/* Header */}
      <div className="meeting-header absolute top-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-md border-b border-primary-200 shadow-sm" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
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
            {isHost && (
              <button
                onClick={() => {
                  setLiveReport(buildReport(Date.now()))
                  setReportOpen(true)
                }}
                title="Meeting report"
                aria-label="Meeting report"
                className="shrink-0 rounded-full bg-primary-100 border border-primary-300 text-primary-700 text-xs px-2 py-0.5 hover:bg-primary-200"
              >
                📋
              </button>
            )}
            {raisedByNames.length > 0 && (
              <span
                title={`Hand raised by ${raisedByNames.join(', ')}`}
                className="shrink-0 max-w-[8rem] truncate rounded-full bg-amber-100 border border-amber-300 text-amber-800 text-[10px] sm:max-w-[16rem] sm:text-xs font-semibold px-2 py-0.5"
              >
                <span className="sm:hidden">
                  ✋ {raisedByNames[0]}
                  {raisedByNames.length > 1 ? ` +${raisedByNames.length - 1}` : ''}
                </span>
                <span className="hidden sm:inline">✋ {raisedByNames.join(', ')}</span>
              </span>
            )}
            {roomSoundMuted && (
              <span
                title="Reaction sounds are muted for everyone"
                className="shrink-0 rounded-full bg-gray-100 border border-gray-300 text-gray-600 text-[10px] sm:text-xs font-semibold px-2 py-0.5"
              >
                🔇
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
            className="meeting-leave-btn bg-red-600 hover:bg-red-700 text-white px-3 py-2 rounded-lg font-medium transition flex items-center gap-2 shrink-0 sm:px-4"
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

      {/* Persistent warning for the participant actually experiencing the slow
          connection, with a countdown before the app leaves the dead call. */}
      {connectionQuality !== 'good' && (
        <div className={`meeting-connection-banner absolute left-1/2 -translate-x-1/2 z-[70] px-3 py-2 rounded-lg shadow-xl text-center text-xs sm:text-sm max-w-[92vw] ${
          connectionQuality === 'critical' ? 'bg-red-600 text-white' : 'bg-amber-500 text-white'
        }`} style={{ top: 'calc(4.5rem + env(safe-area-inset-top, 0px))' }}>
          <div className="font-semibold">
            {connectionQuality === 'critical'
              ? `Connection lost — leaving in ${leaveSeconds ?? 0}s`
              : 'Your connection is unstable. Trying to reconnect…'}
          </div>
          {connectionQuality === 'critical' && (
            <div className="flex items-center justify-center gap-2 mt-1.5">
              <button
                type="button"
                onClick={() => handleLeaveRef.current()}
                className="bg-white text-red-700 font-semibold px-3 py-1 rounded-full text-xs"
              >
                Leave now
              </button>
              <button
                type="button"
                onClick={postponeAutoLeave}
                className="bg-white/20 text-white font-semibold px-3 py-1 rounded-full text-xs"
              >
                Keep waiting
              </button>
            </div>
          )}
        </div>
      )}

      {/* Video Grid — spotlight layout focuses one tile and strips the rest to the bottom */}
      <div className="meeting-video-grid flex-1 p-2 pt-16 grid gap-3 overflow-auto scroll-container sm:p-4 sm:pt-20 sm:pb-24" style={isFocusMode ? {
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
        <div
          onDoubleClick={() => emitReaction('👍')}
          onTouchEnd={handleLocalTileTap}
          title="Double-tap to react 👍"
          className={`${focusTarget === 'local'
          ? 'meeting-focused-tile order-1 row-start-1 min-h-0 border-primary-400'
          : isFocusMode
            ? 'meeting-thumb order-2 row-start-2 w-40 h-24 shrink-0 cursor-pointer hover:border-primary-400 border-primary-200'
            : 'border-primary-200'
        } relative bg-gray-100 rounded-lg overflow-hidden border-2 shadow-lg touch-manipulation`}>
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
          {isHandRaised && (
            <div
              title="Your hand is raised"
              style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.9))' }}
              className={`absolute top-2 left-1/2 z-10 -translate-x-1/2 leading-none animate-bounce ${
                focusTarget === 'local' ? 'text-2xl' : 'text-lg'
              }`}
            >
              ✋
            </div>
          )}
          {focusTarget === 'local' ? (
            <>
              <button
                onClick={() => setFocusedSocketId(null)}
                title="Show all participants"
                className="meeting-exit-focus absolute top-2 right-2 z-10 flex items-center gap-1.5 bg-white/90 hover:bg-white text-gray-900 text-xs sm:text-sm px-3 py-1.5 rounded-full shadow-md font-medium"
              >
                <span dangerouslySetInnerHTML={{ __html: SHOW_ALL_ICON }} />
                <span>Show all</span>
              </button>
              {isScreenSharing && (
                <button
                  onClick={toggleScreenShare}
                  className="meeting-landscape-stop absolute bottom-6 left-1/2 z-10 hidden -translate-x-1/2 rounded-full bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-lg"
                >
                  ⏹ Stop sharing
                </button>
              )}
            </>
          ) : (
            <button
              onClick={() => setFocusedSocketId('local')}
              title={isScreenSharing ? 'You are sharing' : 'Spotlight your video'}
              className="absolute top-2 right-2 z-10 flex items-center gap-1.5 bg-primary-600 hover:bg-primary-700 text-white text-xs sm:text-sm px-3 py-1.5 rounded-full shadow-md font-medium"
            >
              <span dangerouslySetInnerHTML={{ __html: FOCUS_ICON }} />
              <span>Focus</span>
            </button>
          )}
        </div>

        {/* Remote Videos Container */}
        <div ref={remoteVideoContainerRef} className="contents"></div>
      </div>

      {/* Landscape spotlight hides the normal control bar. Keep mic and camera
          as two clearly separate buttons so one tap can never affect both. */}
      <button
        type="button"
        onClick={toggleMute}
        title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
        aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
        aria-pressed={isMuted}
        className={`meeting-landscape-mic absolute z-[80] hidden h-11 w-11 items-center justify-center rounded-full shadow-lg ${
          isMuted ? 'bg-red-600 text-white' : 'bg-white/90 text-primary-700'
        }`}
      >
        {isMuted ? (
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
          </svg>
        ) : (
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        )}
      </button>

      <button
        type="button"
        onClick={toggleVideo}
        title={isVideoMuted ? 'Turn on camera' : 'Turn off camera'}
        aria-label={isVideoMuted ? 'Turn on camera' : 'Turn off camera'}
        aria-pressed={isVideoMuted}
        className={`meeting-landscape-camera absolute z-[80] hidden h-11 w-11 items-center justify-center rounded-full shadow-lg ${
          isVideoMuted ? 'bg-red-600 text-white' : 'bg-white/90 text-primary-700'
        }`}
      >
        {isVideoMuted ? (
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M1 1l22 22" />
          </svg>
        ) : (
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        )}
      </button>

      {/* Floating emoji reactions — rise from above the controls and fade out */}
      <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
        {reactions.map((reaction) => (
          <div
            key={reaction.id}
            className="absolute bottom-[calc(6.5rem+env(safe-area-inset-bottom,0px))]"
            style={{ left: `${reaction.left}%`, transform: 'translateX(-50%)' }}
          >
            <div className={`flex flex-col items-center ${reaction.swirlAlt ? 'animate-reaction-swirl-alt' : 'animate-reaction-swirl'}`}>
              <span className="text-4xl drop-shadow-lg sm:text-5xl">{reaction.emoji}</span>
              <span className="mt-0.5 max-w-[7rem] truncate rounded-full bg-gray-900/75 px-1.5 py-0.5 text-[10px] font-medium text-white">
                {reaction.userName}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Reaction palette */}
      {showReactions && (
        <div className="absolute bottom-[calc(5.75rem+env(safe-area-inset-bottom,0px))] left-1/2 z-50 w-max max-w-[calc(100vw-1rem)] -translate-x-1/2 rounded-2xl border border-primary-200 bg-white/95 px-2 py-1.5 shadow-xl backdrop-blur-md">
          <div className="flex items-center justify-center gap-0.5">
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                onClick={() => sendReaction(emoji)}
                title={`React with ${emoji}`}
                aria-label={`React with ${emoji}`}
                className="h-8 w-8 rounded-full text-lg leading-none transition-transform hover:scale-125 active:scale-95 sm:h-10 sm:w-10 sm:text-2xl"
              >
                {emoji}
              </button>
            ))}
            <span className="mx-1 h-6 w-px bg-primary-200" aria-hidden="true" />
            <button
              onClick={toggleSounds}
              title={soundButtonTitle}
              aria-label={soundButtonTitle}
              aria-pressed={soundIsOff}
              className={`h-8 w-8 rounded-full text-base leading-none transition-colors hover:bg-primary-100 sm:h-10 sm:w-10 sm:text-lg ${
                soundIsOff ? 'text-gray-400' : 'text-primary-700'
              }`}
            >
              {soundIsOff ? '🔇' : '🔊'}
            </button>
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="absolute bottom-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-md border-t border-primary-200 shadow-lg" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <div className="flex flex-wrap items-center justify-center gap-2 px-2 py-3 sm:gap-4 sm:px-6 sm:py-4">
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

          {/* Raise hand */}
          <button
            onClick={toggleHand}
            className={`p-2.5 rounded-full transition-all sm:p-4 ${
              isHandRaised
                ? 'bg-amber-400 hover:bg-amber-500 text-white ring-2 ring-amber-200'
                : 'bg-primary-100 hover:bg-primary-200 text-primary-700'
            }`}
            title={isHandRaised ? 'Lower your hand' : 'Raise your hand'}
            aria-label={isHandRaised ? 'Lower your hand' : 'Raise your hand'}
            aria-pressed={isHandRaised}
          >
            <span className="block text-xl leading-none sm:text-2xl">✋</span>
          </button>

          {/* Emoji reactions */}
          <button
            onClick={toggleReactionPalette}
            className={`p-3 rounded-full transition-all sm:p-4 ${
              showReactions
                ? 'bg-primary-600 hover:bg-primary-700 text-white ring-2 ring-primary-300'
                : 'bg-primary-100 hover:bg-primary-200 text-primary-700'
            }`}
            title="Send a reaction"
            aria-label="Send a reaction"
            aria-expanded={showReactions}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
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
              className="p-2.5 rounded-full transition-all sm:p-4 bg-primary-100 hover:bg-primary-200 text-primary-700"
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
          onActivity={handleChatActivity}
        />
      )}

      {reportOpen && (
        <MeetingReportModal
          live={liveReport}
          past={loadReports()}
          onClose={() => setReportOpen(false)}
        />
      )}
    </div>
  )
}
