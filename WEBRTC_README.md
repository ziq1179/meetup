# WebRTC Video Conferencing App

This is a **custom-built video conferencing application** using WebRTC technology - no Jitsi required!

## How It Works

### Architecture

1. **Signaling Server** (`server/signaling-server.js`)
   - Handles WebSocket connections
   - Exchanges connection information between peers
   - Manages room participants

2. **WebRTC Manager** (`src/lib/webrtc.ts`)
   - Manages peer-to-peer connections
   - Handles media streams (video/audio)
   - Manages ICE candidates for NAT traversal

3. **React Components**
   - `WebRTCRoom.tsx` - Main video room interface
   - `MeetingSetup.tsx` - Room setup screen

### Technology Stack

- **WebRTC** - Peer-to-peer video/audio communication
- **Socket.io** - WebSocket signaling server
- **React + TypeScript** - Frontend framework
- **STUN Servers** - NAT traversal (Google's public servers)

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the Application

**Option A: Run both servers together (Recommended)**
```bash
npm run dev:full
```

This starts:
- Frontend dev server on `http://localhost:5173` (or 3000)
- Signaling server on `http://localhost:3001`

**Option B: Run separately**

Terminal 1 (Frontend):
```bash
npm run dev
```

Terminal 2 (Signaling Server):
```bash
npm run signaling
```

### 3. Join a Meeting

1. Open `http://localhost:5173` in your browser
2. Enter your name and a room name
3. Click "Join Meeting"
4. Allow camera/microphone permissions
5. Share the room name with others to invite them!

## Features

✅ **Peer-to-Peer Video/Audio** - Direct connections between users  
✅ **No External Dependencies** - No Jitsi, Zoom, or other services  
✅ **Screen Sharing** - Share your screen with participants  
✅ **Mute/Unmute** - Control audio and video  
✅ **Multi-Participant Support** - Multiple people in one room  
✅ **Real-time Chat** - Text messaging during meetings  
✅ **Local Recording** - Record meetings and download as WebM files  
✅ **TURN Server Support** - Connect users behind strict NATs/firewalls  
✅ **SFU Configuration** - Ready for media server scalability  
✅ **Custom UI** - Fully customizable interface

See [FEATURES.md](./FEATURES.md) for detailed feature documentation.  

## How WebRTC Works

1. **Signaling**: Users connect to the signaling server via WebSocket
2. **Offer/Answer**: Peers exchange connection offers and answers
3. **ICE Candidates**: Exchange network information for NAT traversal
4. **Direct Connection**: Once connected, media flows directly between peers (peer-to-peer)

## Limitations & Future Improvements

### Current Limitations:
- **Peer-to-Peer Only**: Each participant connects directly to every other participant
  - Works well for 2-4 participants
  - May struggle with more participants (bandwidth/CPU intensive)

### Future Enhancements:
- **SFU (Selective Forwarding Unit)**: Use a media server (like Janus, Kurento, or Mediasoup) for better scalability
- **TURN Servers**: For users behind strict NATs/firewalls
- **Recording**: Server-side recording capabilities
- **Chat**: Text messaging during meetings
- **File Sharing**: Share files during meetings

## Production Deployment

### For Production:

1. **Deploy Signaling Server**:
   - Deploy `server/signaling-server.js` to a Node.js server
   - Update CORS settings to your frontend domain
   - Use environment variables for configuration

2. **Update Frontend Config**:
   - Set `VITE_SIGNALING_SERVER` environment variable to your signaling server URL
   - Or update the default in `WebRTCRoom.tsx`

3. **Add TURN Servers**:
   - For users behind strict NATs, you'll need TURN servers
   - Services: Twilio, Metered, or self-hosted (coturn)

4. **HTTPS Required**:
   - WebRTC requires HTTPS in production (except localhost)
   - Use Let's Encrypt or similar for SSL certificates

## Troubleshooting

### "Failed to connect to signaling server"
- Make sure the signaling server is running: `npm run signaling`
- Check that port 3001 is not in use
- Verify the server URL in your environment

### "Failed to access camera/microphone"
- Check browser permissions
- Make sure you're using HTTPS (or localhost)
- Try a different browser

### "Can't see other participants"
- Check browser console for errors
- Verify STUN servers are accessible
- For users behind strict NATs, you may need TURN servers

## Comparison with Jitsi

| Feature | This App (WebRTC) | Jitsi |
|---------|------------------|-------|
| Setup Complexity | Medium | Easy (uses their servers) |
| Customization | Full control | Limited |
| Server Required | Yes (signaling only) | Yes (full server) |
| Scalability | Limited (P2P) | Excellent (SFU) |
| Cost | Free (self-hosted) | Free (public) or paid (self-hosted) |
| No Login Required | ✅ Yes | ❌ Depends on server |

## License

MIT
