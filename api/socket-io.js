/**
 * Meetup Signaling Server — Vercel WebSocket Function
 *
 * Replacement for the standalone socket.io signaling server so the app
 * can run entirely on Vercel (no separate Node host required).
 *
 * Client connects to the same origin with:
 *   path: '/api/socket-io'
 *   transports: ['websocket']  (required on Vercel)
 *
 * Cross-instance support (optional):
 *   Vercel pins each WebSocket connection to a single function instance.
 *   To fan out events and share the room roster across instances, set the
 *   REDIS_URL env var to an Upstash Redis connection string (RESP protocol,
 *   e.g. rediss://default:PASSWORD@xxx.upstash.io:6379). When REDIS_URL is
 *   missing or unreachable the server falls back to single-instance mode.
 */

import http from 'http';
import { Server } from 'socket.io';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';

const httpServer = http.createServer((req, res) => {
  // Any non-upgrade request that reaches this function is treated as a health check
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    server: 'signaling-server',
    redis: process.env.REDIS_URL ? (redisReady ? 'connected' : 'connecting') : 'disabled',
    timestamp: new Date().toISOString()
  }));
});

const io = new Server(httpServer, {
  // Vercel routes this function at /api/socket-io and does not forward
  // deeper sub-paths, so engine.io must bind to the exact route.
  path: '/api/socket-io',
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false
  },
  transports: ['websocket'],
  allowEIO3: true,
  maxHttpBufferSize: 1e6
});

// Store room data (in-memory; scoped to the function instance this
// connection is pinned to)
const rooms = new Map();
const ROOM_TTL_SECONDS = 10800; // 3h backstop against stale roster entries

// ---------------------------------------------------------------------------
// Optional Upstash Redis adapter for cross-instance signaling
// ---------------------------------------------------------------------------
let redisReady = false;
let pubClient = null;
let subClient = null;

async function setupRedisAdapter() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.log('Redis adapter disabled (REDIS_URL not set) — single-instance mode');
    return;
  }

  try {
    pubClient = createClient({
      url: redisUrl,
      socket: { connectTimeout: 10000, reconnectStrategy: (r) => Math.min(r * 1000, 5000) }
    });
    subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);

    io.adapter(createAdapter(pubClient, subClient));
    redisReady = true;
    console.log('Redis adapter attached — cross-instance signaling enabled');
  } catch (err) {
    console.error('Redis adapter unavailable, falling back to single-instance mode:', err.message);
    try {
      await Promise.all([pubClient?.disconnect(), subClient?.disconnect()]);
    } catch {
      /* ignore */
    }
  }
}

setupRedisAdapter();

function rosterKey(roomId) {
  return `meetup:roster:${encodeURIComponent(roomId)}`;
}

function memberKey(roomId, socketId) {
  return `meetup:member:${encodeURIComponent(roomId)}:${socketId}`;
}

// Read the full room roster from Redis (includes members pinned to other
// instances) when the adapter is connected, otherwise the local in-memory map.
async function readExistingParticipants(roomId, socket) {
  const room = rooms.get(roomId);

  if (redisReady) {
    try {
      const ids = await pubClient.sMembers(rosterKey(roomId));
      const participants = [];
      for (const id of ids) {
        if (id === socket.id) continue;
        const raw = await pubClient.get(memberKey(roomId, id));
        if (raw) {
          try {
            participants.push(JSON.parse(raw));
          } catch {
            /* skip corrupt entries */
          }
        }
      }
      return participants;
    } catch (err) {
      console.error('Redis roster read failed, using local map:', err.message);
    }
  }

  if (!room) return [];
  return Array.from(room.participants.entries())
    .filter(([id]) => id !== socket.id)
    .map(([id, data]) => ({
      socketId: id,
      userId: data.userId,
      userName: data.userName
    }));
}

async function addToRoster(roomId, socketId, data) {
  if (!redisReady) return;
  try {
    await Promise.all([
      pubClient.sAdd(rosterKey(roomId), socketId),
      pubClient.set(memberKey(roomId, socketId), JSON.stringify(data)),
      pubClient.expire(rosterKey(roomId), ROOM_TTL_SECONDS),
      pubClient.expire(memberKey(roomId, socketId), ROOM_TTL_SECONDS)
    ]);
  } catch (err) {
    console.error('Redis roster add failed:', err.message);
  }
}

async function removeFromRoster(roomId, socketId) {
  if (!redisReady) return;
  try {
    await Promise.all([
      pubClient.sRem(rosterKey(roomId), socketId),
      pubClient.del(memberKey(roomId, socketId))
    ]);
  } catch (err) {
    console.error('Redis roster remove failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join a room
  socket.on('join-room', async ({ roomId, userId, userName }) => {
    socket.join(roomId);
    socket.data.userId = userId;
    socket.data.userName = userName;

    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        participants: new Map(),
        created: Date.now()
      });
    }

    const room = rooms.get(roomId);

    // First participant in a room becomes the host (admin)
    if (!room.hostSocketId) {
      room.hostSocketId = socket.id;
    }
    socket.data.isHost = room.hostSocketId === socket.id;

    const participant = { userId, userName, socketId: socket.id };
    room.participants.set(socket.id, participant);

    await addToRoster(roomId, socket.id, participant);

    // Notify others in the room (fanned out to other instances via Redis)
    socket.to(roomId).emit('user-joined', participant);

    // Send list of existing participants to the new user (from all instances)
    const existingParticipants = await readExistingParticipants(roomId, socket);
    socket.emit('existing-participants', existingParticipants);
    socket.emit('room-info', { hostSocketId: room.hostSocketId });

    console.log(`User ${userName} (${socket.id}) joined room ${roomId} (${existingParticipants.length} existing)`);
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

  // Host-only: ask a participant to mute their microphone
  socket.on('mute-participant', ({ roomId, targetSocketId }) => {
    if (!socket.data.isHost) return;
    io.to(targetSocketId).emit('muted-by-host', {
      byName: socket.data.userName || 'the host'
    });
  });

  // Handle chat messages
  socket.on('chat-message', ({ roomId, message, userName, userId, timestamp }, callback) => {
    if (!socket.rooms.has(roomId)) {
      socket.join(roomId);
    }

    io.to(roomId).emit('chat-message', {
      message,
      userName,
      userId,
      socketId: socket.id,
      timestamp: timestamp || Date.now()
    });

    if (callback) {
      callback({ success: true });
    }
  });

  // Handle user leaving
  socket.on('leave-room', ({ roomId }) => {
    socket.leave(roomId);
    const room = rooms.get(roomId);
    const participant = room?.participants.get(socket.id);
    if (participant) {
      room.participants.delete(socket.id);
      if (room.participants.size === 0) {
        rooms.delete(roomId);
      }
    }
    removeFromRoster(roomId, socket.id);
    io.to(roomId).emit('user-left', {
      socketId: socket.id,
      userId: participant?.userId
    });
  });

  socket.on('disconnect', async () => {
    console.log('User disconnected:', socket.id);

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

        io.to(roomId).emit('user-left', {
          socketId: socket.id,
          userId: participant.userId
        });

        if (room.participants.size === 0) {
          rooms.delete(roomId);
        }

        await removeFromRoster(roomId, socket.id);
        break;
      }
    }
  });
});

export default httpServer;