# Troubleshooting Guide

## WebSocket Connection Errors

### Error: "WebSocket connection failed" or "Connection timeout"

This means the **signaling server isn't running**. Here's how to fix it:

### Solution 1: Start the Signaling Server

**Option A: Run both together (Recommended)**
```bash
npm run dev:full
```

**Option B: Run separately**

Terminal 1 (Frontend):
```bash
npm run dev
```

Terminal 2 (Signaling Server):
```bash
npm run signaling
```

You should see:
```
🚀 Signaling server running on port 3001
📡 WebSocket server ready for WebRTC connections
```

### Solution 2: Check Port Availability

If port 3001 is already in use:

1. **Find what's using the port:**
   - Windows: `netstat -ano | findstr :3001`
   - Mac/Linux: `lsof -i :3001`

2. **Change the port** in `server/signaling-server.js`:
   ```javascript
   const PORT = process.env.PORT || 3002; // Change to 3002 or another port
   ```

3. **Update the frontend** in `src/components/WebRTCRoom.tsx`:
   ```typescript
   const signalingServerUrl = import.meta.env.VITE_SIGNALING_SERVER || 'http://localhost:3002'
   ```

### Solution 3: Check Firewall/Antivirus

Sometimes firewalls or antivirus software block WebSocket connections:

- Temporarily disable firewall/antivirus to test
- Add exceptions for Node.js and your browser
- Check Windows Firewall settings

### Solution 4: Use Environment Variable

Create a `.env` file in the project root:

```env
VITE_SIGNALING_SERVER=http://localhost:3001
```

Then restart your dev server.

## Other Common Issues

### "Failed to access camera/microphone"

1. **Check browser permissions:**
   - Click the lock icon in your browser's address bar
   - Allow camera and microphone access

2. **Use HTTPS or localhost:**
   - WebRTC requires secure context (HTTPS or localhost)
   - Don't use `http://192.168.x.x` - use `http://localhost:5173`

3. **Try a different browser:**
   - Chrome/Edge usually work best
   - Firefox may need additional permissions

### "Can't see other participants"

1. **Check browser console** for errors (F12 → Console tab)

2. **Verify STUN servers are accessible:**
   - The app uses Google's public STUN servers
   - If blocked, you may need to configure your own

3. **Check network:**
   - Both users need to be on the same network (for local testing)
   - Or use a tunnel service (ngrok, localtunnel) for internet access

### "Module not found" errors

Run:
```bash
npm install
```

This installs all required dependencies including `socket.io` and `socket.io-client`.

## Still Having Issues?

1. **Check server logs:**
   - Look at the terminal where you ran `npm run signaling`
   - You should see "User connected" messages when someone joins

2. **Check browser console:**
   - Open DevTools (F12)
   - Look for errors in the Console tab

3. **Verify both servers are running:**
   - Frontend: Should be on `http://localhost:5173` (or port shown)
   - Signaling: Should be on `http://localhost:3001`

4. **Test the signaling server directly:**
   ```bash
   curl http://localhost:3001
   ```
   Should return a response (even if it's an error, it means the server is running)

## Quick Test

1. Open **two browser windows/tabs**
2. Go to `http://localhost:5173` in both
3. Join the same room name in both
4. You should see each other's video

If this works, your setup is correct!
