# Mediasoup SFU Server Setup Guide

This guide will help you set up a mediasoup server for better scalability (50+ participants) instead of peer-to-peer mesh networking.

## What is Mediasoup?

Mediasoup is a modern, efficient Selective Forwarding Unit (SFU) that:
- Routes media streams through a central server
- Scales to hundreds of participants
- Reduces bandwidth per participant
- Provides better quality control

## Prerequisites

- Node.js v18 or higher
- npm or yarn
- Basic understanding of Node.js/JavaScript

## Step 1: Create Mediasoup Server

### Option A: Separate Mediasoup Server (Recommended)

Create a new directory for the mediasoup server:

```bash
# In your project root
mkdir mediasoup-server
cd mediasoup-server
npm init -y
```

### Install Dependencies

```bash
npm install mediasoup@^3.11.0 express socket.io cors
npm install --save-dev @types/node @types/express typescript ts-node nodemon
```

### Create TypeScript Config

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

### Create Mediasoup Server

Create `src/server.ts`:

```typescript
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import mediasoup from 'mediasoup';
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
  const numWorkers = Object.keys(os.networkInterfaces()).length;
  
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
    transport: mediasoup.types.WebRtcTransport;
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

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          router,
          peers: new Map(),
        });
      }

      const room = rooms.get(roomId)!;
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

      if (!room.peers.has(socket.id)) {
        room.peers.set(socket.id, {
          socketId: socket.id,
          transport,
          consumers: new Map(),
        });
      } else {
        const peer = room.peers.get(socket.id)!;
        if (direction === 'send') {
          peer.transport = transport;
        }
      }

      callback({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        },
      });

      console.log(`Transport created for ${socket.id} in room ${roomId}`);
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
      if (!peer || peer.transport.id !== transportId) {
        callback({ error: 'Transport not found' });
        return;
      }

      await peer.transport.connect({ dtlsParameters });
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
      if (!peer) {
        callback({ error: 'Peer not found' });
        return;
      }

      const producer = await peer.transport.produce({
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

      console.log(`Producer created: ${producer.id} for ${socket.id}`);
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
      if (!peer) {
        callback({ error: 'Peer not found' });
        return;
      }

      const producer = Array.from(room.peers.values())
        .find(p => p.producer?.id === producerId)?.producer;

      if (!producer) {
        callback({ error: 'Producer not found' });
        return;
      }

      const consumer = await peer.transport.consume({
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
        peer.transport.close();
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
  });
}

start().catch(console.error);
```

### Update package.json Scripts

Add to `package.json`:

```json
{
  "scripts": {
    "dev": "nodemon --exec ts-node src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js"
  }
}
```

## Step 2: Update Frontend for SFU

### Update WebRTC Manager

We need to add SFU support to `src/lib/webrtc.ts`. Create a new file `src/lib/webrtc-sfu.ts`:

```typescript
import { getWebRTCConfig } from '../config/webrtc'
import * as mediasoupClient from 'mediasoup-client'

export class WebRTCSFUManager {
  private device: mediasoupClient.types.Device | null = null
  private socket: any = null
  private roomId: string = ''
  private sendTransport: mediasoupClient.types.Transport | null = null
  private recvTransport: mediasoupClient.types.Transport | null = null
  private producers: Map<string, mediasoupClient.types.Producer> = new Map()
  private consumers: Map<string, mediasoupClient.types.Consumer> = new Map()
  private localStream: MediaStream | null = null

  constructor(socket: any, roomId: string) {
    this.socket = socket
    this.roomId = roomId
    this.setupSocketListeners()
  }

  private setupSocketListeners() {
    this.socket.on('new-producer', async ({ producerId, socketId, kind }: any) => {
      await this.consumeProducer(producerId, socketId, kind)
    })

    this.socket.on('producer-closed', ({ producerId }: any) => {
      const consumer = this.consumers.get(producerId)
      if (consumer) {
        consumer.close()
        this.consumers.delete(producerId)
      }
    })
  }

  async initialize(rtpCapabilities: mediasoupClient.types.RtpCapabilities) {
    this.device = new mediasoupClient.Device()
    await this.device.load({ routerRtpCapabilities: rtpCapabilities })
  }

  async createSendTransport() {
    return new Promise((resolve, reject) => {
      this.socket.emit('create-transport', { roomId: this.roomId, direction: 'send' }, (response: any) => {
        if (response.error) {
          reject(new Error(response.error))
          return
        }

        this.sendTransport = this.device!.createSendTransport(response.params)

        this.sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
          this.socket.emit('connect-transport', {
            roomId: this.roomId,
            transportId: this.sendTransport!.id,
            dtlsParameters,
          }, (response: any) => {
            if (response.error) {
              errback(new Error(response.error))
            } else {
              callback()
            }
          })
        })

        this.sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
          try {
            this.socket.emit('produce', {
              roomId: this.roomId,
              kind,
              rtpParameters,
            }, (response: any) => {
              if (response.error) {
                errback(new Error(response.error))
              } else {
                callback({ id: response.id })
              }
            })
          } catch (error) {
            errback(error)
          }
        })

        resolve(this.sendTransport)
      })
    })
  }

  async createRecvTransport() {
    return new Promise((resolve, reject) => {
      this.socket.emit('create-transport', { roomId: this.roomId, direction: 'recv' }, (response: any) => {
        if (response.error) {
          reject(new Error(response.error))
          return
        }

        this.recvTransport = this.device!.createRecvTransport(response.params)

        this.recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
          this.socket.emit('connect-transport', {
            roomId: this.roomId,
            transportId: this.recvTransport!.id,
            dtlsParameters,
          }, (response: any) => {
            if (response.error) {
              errback(new Error(response.error))
            } else {
              callback()
            }
          })
        })

        resolve(this.recvTransport)
      })
    })
  }

  async produce(stream: MediaStream) {
    this.localStream = stream

    // Produce audio
    if (stream.getAudioTracks().length > 0) {
      const track = stream.getAudioTracks()[0]
      const producer = await this.sendTransport!.produce({ track })
      this.producers.set('audio', producer)
    }

    // Produce video
    if (stream.getVideoTracks().length > 0) {
      const track = stream.getVideoTracks()[0]
      const producer = await this.sendTransport!.produce({ track })
      this.producers.set('video', producer)
    }
  }

  async consumeProducer(producerId: string, socketId: string, kind: string) {
    if (!this.device || !this.recvTransport) return

    this.socket.emit('consume', {
      roomId: this.roomId,
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    }, async (response: any) => {
      if (response.error) {
        console.error('Error consuming:', response.error)
        return
      }

      const consumer = await this.recvTransport!.consume({
        id: response.params.id,
        producerId: response.params.producerId,
        kind: response.params.kind,
        rtpParameters: response.params.rtpParameters,
      })

      this.consumers.set(producerId, consumer)

      const stream = new MediaStream([consumer.track])
      // Emit event or callback with stream
    })
  }

  cleanup() {
    this.producers.forEach(producer => producer.close())
    this.consumers.forEach(consumer => consumer.close())
    this.sendTransport?.close()
    this.recvTransport?.close()
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop())
    }
  }
}
```

### Install Mediasoup Client

```bash
npm install mediasoup-client
```

## Step 3: Configuration

### Create/Update .env File

In your project root, create or update `.env`:

```env
# Signaling Server (existing)
VITE_SIGNALING_SERVER=http://localhost:3001

# SFU Configuration
VITE_USE_SFU=true
VITE_SFU_SERVER_URL=ws://localhost:4000

# TURN Servers (optional but recommended)
VITE_TURN_SERVER_URL=turn:your-server.metered.ca:80
VITE_TURN_USERNAME=your-username
VITE_TURN_CREDENTIAL=your-credential

# Mediasoup Server (for production)
ANNOUNCED_IP=your-public-ip-or-domain
```

### Update package.json Scripts

Add mediasoup server to your main project:

```json
{
  "scripts": {
    "dev": "vite",
    "dev:full": "concurrently \"npm run dev\" \"npm run signaling\" \"npm run mediasoup\"",
    "signaling": "node server/signaling-server.js",
    "mediasoup": "cd mediasoup-server && npm run dev",
    "build": "tsc && vite build"
  }
}
```

## Step 4: Production Deployment

### Important Settings

1. **ANNOUNCED_IP**: Set to your public IP or domain
   ```env
   ANNOUNCED_IP=your-domain.com
   ```

2. **Firewall**: Open ports 40000-49999 (UDP) for RTP
   ```bash
   # Example for Ubuntu/Debian
   sudo ufw allow 40000:49999/udp
   ```

3. **HTTPS**: Required for production (WebRTC needs secure context)

### Docker Deployment (Optional)

Create `mediasoup-server/Dockerfile`:

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 4000
EXPOSE 40000-49999/udp

CMD ["npm", "start"]
```

## Step 5: Testing

1. **Start all servers:**
   ```bash
   npm run dev:full
   ```

2. **Open browser:**
   - Go to `http://localhost:5173`
   - Join a room
   - Open another browser window
   - Join the same room
   - You should see video/audio working through SFU

3. **Check console:**
   - Mediasoup server should show: "Client connected"
   - Browser console should show SFU connection

## Troubleshooting

### "Cannot consume media"
- Check that router RTP capabilities match
- Verify codec support

### "Transport connection failed"
- Check ANNOUNCED_IP is set correctly
- Verify firewall allows UDP ports 40000-49999
- Check TURN server if behind NAT

### "Room not found"
- Ensure room is created before joining
- Check socket.io connection

## Next Steps

1. Integrate SFU manager into `WebRTCRoom.tsx`
2. Add error handling and reconnection logic
3. Implement bandwidth adaptation
4. Add recording through SFU
5. Scale horizontally with multiple workers

## Resources

- [Mediasoup Documentation](https://mediasoup.org/documentation/)
- [Mediasoup Examples](https://github.com/versatica/mediasoup-demo)
- [Mediasoup Client API](https://mediasoup.org/documentation/v3/mediasoup-client/api/)
