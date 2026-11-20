# Advanced Features Guide

This document explains the advanced features that have been implemented in the WebRTC video conferencing app.

## ✅ Implemented Features

### 1. TURN Servers for NAT Traversal

**What it does:** Helps users behind strict NATs/firewalls connect to each other.

**Configuration:**
- Edit `src/config/webrtc.ts` to add your TURN server credentials
- Uses environment variables for security

**Free TURN Server Options:**
1. **Metered TURN** (Free tier available)
   - Sign up at: https://www.metered.ca/tools/openrelay/
   - Get your credentials and add to `.env`:
     ```
     VITE_TURN_SERVER_URL=turn:your-server.metered.ca:80
     VITE_TURN_USERNAME=your-username
     VITE_TURN_CREDENTIAL=your-credential
     ```

2. **Twilio TURN** (Paid, very reliable)
   - Sign up at: https://www.twilio.com/
   - Add to `.env`:
     ```
     VITE_TWILIO_ACCOUNT_SID=your-account-sid
     VITE_TWILIO_AUTH_TOKEN=your-auth-token
     ```

3. **Self-hosted coturn**
   - Install and configure coturn on your server
   - See: https://github.com/coturn/coturn

**How it works:**
- STUN servers (free, public) - Used first to discover public IP
- TURN servers (relay) - Used when direct connection fails
- Automatically falls back to TURN if STUN fails

### 2. Chat Functionality

**What it does:** Real-time text messaging during video calls.

**Features:**
- ✅ Send/receive messages in real-time
- ✅ Message timestamps
- ✅ User names displayed
- ✅ Chat panel that can be toggled
- ✅ Unread message indicator

**How to use:**
1. Click the chat icon in the bottom controls
2. Type your message and press Enter or click Send
3. Messages are broadcast to all participants in the room

**Technical details:**
- Uses Socket.io for real-time messaging
- Messages stored in memory (not persisted)
- Each message includes: content, sender name, timestamp

### 3. Recording Capabilities

**What it does:** Record video meetings locally in your browser.

**Features:**
- ✅ Start/stop recording during meeting
- ✅ Records local video/audio + remote audio
- ✅ Downloads as WebM file
- ✅ Visual recording indicator

**How to use:**
1. Click the record button (red circle icon) in controls
2. Recording indicator appears in header
3. Click again to stop and download

**Limitations:**
- Currently records local video + all remote audio
- For full multi-video recording, you'd need server-side recording
- File format: WebM (playable in most browsers/media players)

**Future improvements:**
- Server-side recording for better quality
- Record all video streams
- Cloud storage integration
- Recording permissions/controls

### 4. SFU (Selective Forwarding Unit) Support

**Status:** ✅ Server setup guide available, ready for implementation

**What it does:** Instead of peer-to-peer mesh, uses a media server to forward streams. Better for scalability.

**Setup Guide:** See [MEDIASOUP_SETUP.md](./MEDIASOUP_SETUP.md) for complete setup instructions.

**Current setup:**
- Configuration in `src/config/webrtc.ts`
- Set `VITE_USE_SFU=true` to enable (when SFU server is ready)

**SFU Options:**

1. **mediasoup** (Recommended)
   - Modern, efficient, JavaScript-based
   - See: https://mediasoup.org/
   - Requires setting up mediasoup server

2. **Janus Gateway**
   - C-based, very stable
   - See: https://janus.conf.meetecho.com/
   - More complex setup

3. **Kurento**
   - Java-based
   - See: https://www.kurento.org/
   - Good for enterprise

**Why SFU?**
- **Mesh (current):** Each participant connects to every other participant
  - Works well for 2-4 people
  - Bandwidth/CPU intensive with more participants
  
- **SFU:** All participants connect to a central server
  - Scales to 50+ participants
  - Lower bandwidth per participant
  - Better quality control

## 🚀 Quick Setup

### TURN Server (Metered - Free)

1. Sign up at https://www.metered.ca/tools/openrelay/
2. Create a `.env` file in project root:
   ```env
   VITE_TURN_SERVER_URL=turn:your-server.metered.ca:80
   VITE_TURN_USERNAME=your-username
   VITE_TURN_CREDENTIAL=your-credential
   ```
3. Restart your dev server

### Testing Features

1. **Chat:**
   - Open two browser windows
   - Join the same room
   - Click chat icon and send messages

2. **Recording:**
   - Start a meeting
   - Click record button
   - Stop recording to download file

3. **TURN:**
   - Test from different networks
   - Check browser console for connection types
   - Should see "relay" in ICE candidates if TURN is used

## 📝 Environment Variables

Create a `.env` file in the project root:

```env
# Signaling Server
VITE_SIGNALING_SERVER=http://localhost:3001

# TURN Servers (Metered)
VITE_TURN_SERVER_URL=turn:your-server.metered.ca:80
VITE_TURN_USERNAME=your-username
VITE_TURN_CREDENTIAL=your-credential

# TURN Servers (Twilio)
VITE_TWILIO_ACCOUNT_SID=your-account-sid
VITE_TWILIO_AUTH_TOKEN=your-auth-token

# SFU (when ready)
VITE_USE_SFU=false
VITE_SFU_SERVER_URL=ws://localhost:4000
```

## 🔧 Troubleshooting

### TURN Server Not Working
- Check credentials in `.env`
- Verify TURN server is accessible
- Check browser console for ICE candidate errors
- Try a different TURN provider

### Recording Not Working
- Check browser permissions
- Ensure MediaRecorder API is supported (Chrome, Firefox, Edge)
- Check console for errors

### Chat Messages Not Appearing
- Verify signaling server is running
- Check Socket.io connection in browser console
- Ensure you're in the same room

## 📚 Next Steps

1. **Implement SFU Server:**
   - Set up mediasoup server
   - Update WebRTC manager to use SFU mode
   - Test with multiple participants

2. **Enhanced Recording:**
   - Server-side recording with FFmpeg
   - Record all video streams
   - Cloud storage integration

3. **Additional Features:**
   - File sharing
   - Whiteboard
   - Breakout rooms
   - Meeting scheduling
