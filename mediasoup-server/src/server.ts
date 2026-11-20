import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import * as mediasoup from 'mediasoup';
import os from 'os';

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*', // In production, specify your frontend domain
    methods: ['GET', 'POST']
  }
});

// Mediasoup workers
const workers: mediasoup.types.Worker[] = [];
let nextWorkerIndex = 0;

// Create mediasoup workers
async function createWorkers() {
  const numWorkers = Math.max(1, os.cpus().length);
  
  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
    });

    worker.on('died', () => {
      console.error('Mediasoup worker died, exiting in 2 seconds...');
      setTimeout(() => process.exit(1), 2000);
    });

    workers.push(worker);
  }

  console.log(`Created ${workers.length} mediasoup workers`);
}

// Get next worker (round-robin)
function getNextWorker(): mediasoup.types.Worker {
  const worker = workers[nextWorkerIndex];
  nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
  return worker;
}

// Store rooms and routers
const rooms = new Map<string, {
  router: mediasoup.types.Router;
  peers: Map<string, {
    socketId: string;
    sendTransport?: mediasoup.types.WebRtcTransport;
    recvTransport?: mediasoup.types.WebRtcTransport;
    producer?: mediasoup.types.Producer;
    consumers: Map<string, mediasoup.types.Consumer>;
  }>;
}>();

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Create router for room
  socket.on('create-room', async ({ roomId }, callback) => {
    try {
      if (rooms.has(roomId)) {
        const room = rooms.get(roomId)!;
        callback({
          routerRtpCapabilities: room.router.rtpCapabilities,
        });
        return;
      }

      const worker = getNextWorker();
      const router = await worker.createRouter({
        mediaCodecs: [
          {
            kind: 'audio',
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2,
          },
          {
            kind: 'video',
            mimeType: 'video/VP8',
            clockRate: 90000,
          },
          {
            kind: 'video',
            mimeType: 'video/VP9',
            clockRate: 90000,
          },
          {
            kind: 'video',
            mimeType: 'video/H264',
            clockRate: 90000,
          },
        ],
      });

      rooms.set(roomId, {
        router,
        peers: new Map(),
      });

      callback({
        routerRtpCapabilities: router.rtpCapabilities,
      });

      console.log(`Room ${roomId} created`);
    } catch (error) {
      console.error('Error creating room:', error);
      callback({ error: 'Failed to create room' });
    }
  });

  // Join room
  socket.on('join-room', async ({ roomId, rtpCapabilities }, callback) => {
    try {
      const room = rooms.get(roomId);
      if (!room) {
        callback({ error: 'Room not found' });
        return;
      }

      // Check if router can consume this peer's media
      if (!room.router.canConsume({ producerId: '', rtpCapabilities })) {
        callback({ error: 'Cannot consume media' });
        return;
      }

      if (!room.peers.has(socket.id)) {
        room.peers.set(socket.id, {
          socketId: socket.id,
          consumers: new Map(),
        });
      }

      callback({
        routerRtpCapabilities: room.router.rtpCapabilities,
      });

      socket.join(roomId);
      console.log(`Client ${socket.id} joined room ${roomId}`);
    } catch (error) {
      console.error('Error joining room:', error);
      callback({ error: 'Failed to join room' });
    }
  });

  // Create transport
  socket.on('create-transport', async ({ roomId, direction }, callback) => {
    try {
      const room = rooms.get(roomId);
      if (!room) {
        callback({ error: 'Room not found' });
        return;
      }

      const peer = room.peers.get(socket.id);
      if (!peer) {
        callback({ error: 'Peer not found. Join room first.' });
        return;
      }

      const transport = await room.router.createWebRtcTransport({
        listenIps: [
          {
            ip: '0.0.0.0',
            announcedIp: process.env.ANNOUNCED_IP || '127.0.0.1', // Your public IP or domain
          },
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });

      transport.on('dtlsstatechange', (dtlsState) => {
        if (dtlsState === 'closed') {
          transport.close();
        }
      });

      if (direction === 'send') {
        peer.sendTransport = transport;
      } else {
        peer.recvTransport = transport;
      }

      callback({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        },
      });

      console.log(`Transport created for ${socket.id} in room ${roomId} (${direction})`);
    } catch (error) {
      console.error('Error creating transport:', error);
      callback({ error: 'Failed to create transport' });
    }
  });

  // Connect transport
  socket.on('connect-transport', async ({ roomId, transportId, dtlsParameters }, callback) => {
    try {
      const room = rooms.get(roomId);
      if (!room) {
        callback({ error: 'Room not found' });
        return;
      }

      const peer = room.peers.get(socket.id);
      if (!peer) {
        callback({ error: 'Peer not found' });
        return;
      }

      const transport = peer.sendTransport?.id === transportId 
        ? peer.sendTransport 
        : peer.recvTransport?.id === transportId 
        ? peer.recvTransport 
        : null;

      if (!transport) {
        callback({ error: 'Transport not found' });
        return;
      }

      await transport.connect({ dtlsParameters });
      callback({});

      console.log(`Transport connected for ${socket.id}`);
    } catch (error) {
      console.error('Error connecting transport:', error);
      callback({ error: 'Failed to connect transport' });
    }
  });

  // Produce (send media)
  socket.on('produce', async ({ roomId, kind, rtpParameters }, callback) => {
    try {
      const room = rooms.get(roomId);
      if (!room) {
        callback({ error: 'Room not found' });
        return;
      }

      const peer = room.peers.get(socket.id);
      if (!peer || !peer.sendTransport) {
        callback({ error: 'Peer or transport not found' });
        return;
      }

      const producer = await peer.sendTransport.produce({
        kind,
        rtpParameters,
      });

      peer.producer = producer;

      // Notify other peers about new producer
      socket.to(roomId).emit('new-producer', {
        producerId: producer.id,
        socketId: socket.id,
        kind: producer.kind,
      });

      callback({ id: producer.id });

      console.log(`Producer created: ${producer.id} (${kind}) for ${socket.id}`);
    } catch (error) {
      console.error('Error producing:', error);
      callback({ error: 'Failed to produce' });
    }
  });

  // Consume (receive media)
  socket.on('consume', async ({ roomId, producerId, rtpCapabilities }, callback) => {
    try {
      const room = rooms.get(roomId);
      if (!room) {
        callback({ error: 'Room not found' });
        return;
      }

      const peer = room.peers.get(socket.id);
      if (!peer || !peer.recvTransport) {
        callback({ error: 'Peer or transport not found' });
        return;
      }

      const producer = Array.from(room.peers.values())
        .find(p => p.producer?.id === producerId)?.producer;

      if (!producer) {
        callback({ error: 'Producer not found' });
        return;
      }

      const consumer = await peer.recvTransport.consume({
        producerId: producer.id,
        rtpCapabilities,
      });

      peer.consumers.set(consumer.id, consumer);

      consumer.on('transportclose', () => {
        peer.consumers.delete(consumer.id);
      });

      callback({
        params: {
          id: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        },
      });

      console.log(`Consumer created: ${consumer.id} for ${socket.id}`);
    } catch (error) {
      console.error('Error consuming:', error);
      callback({ error: 'Failed to consume' });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);

    // Clean up peer from all rooms
    for (const [roomId, room] of rooms.entries()) {
      const peer = room.peers.get(socket.id);
      if (peer) {
        if (peer.producer) {
          peer.producer.close();
          socket.to(roomId).emit('producer-closed', {
            producerId: peer.producer.id,
          });
        }

        peer.consumers.forEach(consumer => consumer.close());
        peer.sendTransport?.close();
        peer.recvTransport?.close();
        room.peers.delete(socket.id);

        // Clean up empty rooms
        if (room.peers.size === 0) {
          room.router.close();
          rooms.delete(roomId);
          console.log(`Room ${roomId} closed`);
        }
      }
    }
  });
});

// Start server
async function start() {
  await createWorkers();

  const PORT = process.env.PORT || 4000;
  httpServer.listen(PORT, () => {
    console.log(`🚀 Mediasoup server running on port ${PORT}`);
    console.log(`📡 WebSocket server ready for SFU connections`);
    console.log(`🌐 ANNOUNCED_IP: ${process.env.ANNOUNCED_IP || '127.0.0.1 (localhost)'}`);
  });
}

start().catch(console.error);
