/**
 * WebRTC Signaling Server
 * 
 * This server handles WebRTC signaling - exchanging connection information
 * between peers so they can establish direct peer-to-peer connections.
 * 
 * Run with: npm run signaling
 * Or: node server/signaling-server.js
 */

import { Server } from 'socket.io';
import { createServer } from 'http';

const httpServer = createServer((req, res) => {
  // Add CORS headers for all requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Health check endpoint
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      server: 'signaling-server',
      port: process.env.PORT || 3001,
      timestamp: new Date().toISOString()
    }));
    return;
  }
  
  res.writeHead(404);
  res.end('Not found');
});

const io = new Server(httpServer, {
  cors: {
    origin: '*', // In production, specify your frontend domain
    methods: ['GET', 'POST'],
    credentials: false
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

// Store room data
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join a room
  socket.on('join-room', ({ roomId, userId, userName }) => {
    socket.join(roomId);
    socket.data.userId = userId;
    socket.data.userName = userName;
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        participants: new Map(),
        created: Date.now(),
        soundMuted: false,
        screenShare: null
      });
    }

    const room = rooms.get(roomId);

    // First participant in a room becomes the host (admin)
    if (!room.hostSocketId) {
      room.hostSocketId = socket.id;
    }
    socket.data.isHost = room.hostSocketId === socket.id;

    room.participants.set(socket.id, { userId, userName, socketId: socket.id });

    // Notify others in the room
    socket.to(roomId).emit('user-joined', {
      userId,
      userName,
      socketId: socket.id
    });

    // Send list of existing participants to the new user
    const existingParticipants = Array.from(room.participants.entries())
      .filter(([id]) => id !== socket.id)
      .map(([id, data]) => ({
        socketId: id,
        userId: data.userId,
        userName: data.userName
      }));

    socket.emit('existing-participants', existingParticipants);
    socket.emit('room-info', { hostSocketId: room.hostSocketId, soundMuted: Boolean(room.soundMuted) });
    // A newcomer should land on the current screen share, if one is running
    if (room.screenShare) socket.emit('screen-share-state', room.screenShare);

    console.log(`User ${userName} (${socket.id}) joined room ${roomId}`);
  });

  // Handle WebRTC offer
  socket.on('offer', ({ offer, targetSocketId, roomId }) => {
    socket.to(targetSocketId).emit('offer', {
      offer,
      senderSocketId: socket.id,
      senderName: socket.data.userName || '',
      senderUserId: socket.data.userId || ''
    });
  });

  // Handle WebRTC answer
  socket.on('answer', ({ answer, targetSocketId, roomId }) => {
    socket.to(targetSocketId).emit('answer', {
      answer,
      senderSocketId: socket.id
    });
  });

  // Handle ICE candidates
  socket.on('ice-candidate', ({ candidate, targetSocketId, roomId }) => {
    socket.to(targetSocketId).emit('ice-candidate', {
      candidate,
      senderSocketId: socket.id
    });
  });

  // Relay camera/mic on-off state so remote tiles can show a name/avatar
  // instead of a black frame when someone's camera is off.
  socket.on('media-state', ({ roomId, videoEnabled, audioEnabled }) => {
    socket.to(roomId).emit('media-state', {
      socketId: socket.id,
      videoEnabled: Boolean(videoEnabled),
      audioEnabled: Boolean(audioEnabled)
    });
  });

  // Emoji reactions — broadcast to the whole room (including the sender so
  // they see their own reaction float up too).
  socket.on('reaction', ({ roomId, emoji }) => {
    if (!emoji || typeof emoji !== 'string') return;
    io.to(roomId).emit('reaction', {
      socketId: socket.id,
      userName: socket.data.userName || '',
      emoji: emoji.slice(0, 8)
    });
  });

  // Raise/lower hand — broadcast to the whole room so tiles show a hand badge
  socket.on('hand-state', ({ roomId, raised }) => {
    io.to(roomId).emit('hand-state', {
      socketId: socket.id,
      userName: socket.data.userName || '',
      raised: Boolean(raised)
    });
  });

  // Spotlight whoever starts sharing so landscape phones show the shared
  // screen full-size. Excludes the sender (they spotlight themselves locally).
  socket.on('screen-share-state', ({ roomId, sharing }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const payload = {
      socketId: socket.id,
      userName: socket.data.userName || '',
      sharing: Boolean(sharing)
    };
    room.screenShare = payload.sharing ? payload : null;
    socket.to(roomId).emit('screen-share-state', payload);
  });

  // Connection quality updates so others can see who is struggling
  socket.on('connection-quality', ({ roomId, level }) => {
    const clean = ['good', 'poor', 'critical'].includes(level) ? level : 'good';
    const participant = rooms.get(roomId)?.participants.get(socket.id);
    if (participant) participant.quality = clean;
    socket.to(roomId).emit('connection-quality', {
      socketId: socket.id,
      userName: socket.data.userName || '',
      level: clean
    });
  });

  // Host-only: mute or unmute reaction sounds for the whole room
  socket.on('room-sound', ({ roomId, muted }) => {
    if (!socket.data.isHost) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.soundMuted = Boolean(muted);
    io.to(roomId).emit('room-sound', {
      muted: room.soundMuted,
      byName: socket.data.userName || 'the host'
    });
  });

  // Host-only: ask a participant to mute their microphone
  socket.on('mute-participant', ({ roomId, targetSocketId }) => {
    if (!socket.data.isHost) return;
    io.to(targetSocketId).emit('muted-by-host', {
      byName: socket.data.userName || 'the host'
    });
  });

  // Handle chat messages
  socket.on('chat-message', ({ roomId, message, userName, userId, timestamp }, callback) => {
    // Log metadata only - chat content is private and never written to logs
    console.log(`Chat message sent in room ${roomId}`);

    // Ensure socket is in the room
    if (!socket.rooms.has(roomId)) {
      socket.join(roomId);
    }

    // Broadcast to all users in the room (including sender)
    const messageData = {
      message,
      userName,
      userId,
      socketId: socket.id,
      timestamp: timestamp || Date.now()
    };

    io.to(roomId).emit('chat-message', messageData);
    
    // Send acknowledgment
    if (callback) {
      callback({ success: true });
    }
  });

  // Handle user leaving
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    // Find and remove from all rooms
    for (const [roomId, room] of rooms.entries()) {
      if (room.participants.has(socket.id)) {
        const participant = room.participants.get(socket.id);
        room.participants.delete(socket.id);

        // If the host left, promote the next participant so the room keeps an admin
        if (room.hostSocketId === socket.id && room.participants.size > 0) {
          const nextHostId = room.participants.keys().next().value;
          room.hostSocketId = nextHostId;
          const nextHostSocket = io.sockets.sockets.get(nextHostId);
          if (nextHostSocket) nextHostSocket.data.isHost = true;
          io.to(roomId).emit('host-changed', { hostSocketId: nextHostId });
        }

        // If the sharer left, drop everyone out of the spotlight
        if (room.screenShare?.socketId === socket.id) {
          room.screenShare = null;
          io.to(roomId).emit('screen-share-state', {
            socketId: socket.id,
            userName: participant.userName || '',
            sharing: false
          });
        }

        // Notify others
        io.to(roomId).emit('user-left', {
          socketId: socket.id,
          userId: participant.userId
        });

        // Clean up empty rooms
        if (room.participants.size === 0) {
          rooms.delete(roomId);
        }

        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0'; // Listen on all network interfaces
httpServer.listen(PORT, HOST, () => {
  console.log(`🚀 Signaling server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready for WebRTC connections`);
  console.log(`🌐 Accessible at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} (and via network IP)`);
});
