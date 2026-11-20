/**
 * WebRTC Configuration
 * 
 * Configure STUN/TURN servers and other WebRTC settings
 */

export interface TURNServer {
  urls: string | string[]
  username?: string
  credential?: string
}

export interface WebRTCConfig {
  iceServers: (RTCIceServer | TURNServer)[]
  iceTransportPolicy?: RTCIceTransportPolicy
  bundlePolicy?: RTCBundlePolicy
  rtcpMuxPolicy?: RTCRtcpMuxPolicy
}

/**
 * Get WebRTC configuration with STUN and TURN servers
 * 
 * For production, you should:
 * 1. Set up your own TURN server (using coturn, Twilio, Metered, etc.)
 * 2. Add your TURN server credentials here
 * 3. Use environment variables for sensitive credentials
 */
export function getWebRTCConfig(): RTCConfiguration {
  const turnServers: TURNServer[] = []

  // Add your TURN servers here
  // Option 1: Free public TURN servers (limited reliability)
  // Note: These may not always work. For production, use your own TURN server.
  
  // Option 2: Metered TURN (Free tier available)
  // Get credentials from: https://www.metered.ca/tools/openrelay/
  const meteredTurnUrl = import.meta.env.VITE_TURN_SERVER_URL
  const meteredTurnUsername = import.meta.env.VITE_TURN_USERNAME
  const meteredTurnCredential = import.meta.env.VITE_TURN_CREDENTIAL
  
  if (meteredTurnUrl && meteredTurnUsername && meteredTurnCredential) {
    turnServers.push({
      urls: meteredTurnUrl,
      username: meteredTurnUsername,
      credential: meteredTurnCredential
    })
  }

  // Option 3: Twilio TURN (Paid, reliable)
  // const twilioAccountSid = import.meta.env.VITE_TWILIO_ACCOUNT_SID
  // if (twilioAccountSid) {
  //   turnServers.push({
  //     urls: `turn:global.turn.twilio.com:3478?transport=udp`,
  //     username: twilioAccountSid,
  //     credential: import.meta.env.VITE_TWILIO_AUTH_TOKEN
  //   })
  // }

  // Option 4: Self-hosted coturn
  // turnServers.push({
  //   urls: 'turn:your-turn-server.com:3478',
  //   username: 'your-username',
  //   credential: 'your-password'
  // })

  // STUN servers (free, public)
  const stunServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ]

  return {
    iceServers: [
      ...stunServers,
      ...turnServers
    ],
    iceTransportPolicy: 'all', // Try both relay and direct connections
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  }
}

/**
 * SFU (Selective Forwarding Unit) Configuration
 * 
 * For better scalability, use an SFU instead of mesh networking.
 * Options: mediasoup, Janus, Kurento, or custom SFU
 */
export const SFU_CONFIG = {
  // Set to true to use SFU mode (requires SFU server)
  enabled: import.meta.env.VITE_USE_SFU === 'true',
  
  // SFU server URL (if using mediasoup or custom SFU)
  serverUrl: import.meta.env.VITE_SFU_SERVER_URL || 'ws://localhost:4000',
  
  // For mediasoup, you'll need to set up a mediasoup server
  // See: https://mediasoup.org/
}
