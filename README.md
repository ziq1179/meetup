# Meetup - Video Meeting App

A modern, self-hosted video meeting application built on WebRTC — no third-party infrastructure required. Live at: **https://meetup-xi-lilac.vercel.app**

## Features

- 🎥 High-quality P2P video conferencing (WebRTC)
- 📺 **Screen sharing** with spotlight layout — focus the presenter's screen while other participants shrink to a thumbnail strip
- 💬 Real-time chat
- 🎬 **Local recording** — record meetings and download as WebM
- 🔊 Audio-only mode
- 📱 Mobile-first responsive UI + **installable PWA** (no APK, no Play Protect warnings)
- 🔒 Secure meetings with room names
- 🔗 **Deep links** — shared `?room=` links open the Android app directly
- 🚀 No external dependencies — custom WebRTC stack, full control

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- npm

### Local Development

```bash
npm install
npm run dev:full   # starts frontend (5173) + signaling server (3001)
```

Open `http://localhost:5173`.

## Deployment (Vercel)

```bash
vercel deploy --prod
```

The signaling backend runs as the Vercel function `api/socket-io.js`. No extra infrastructure is needed for P2P meetings.

## Installing on a Phone

Two options:

1. **PWA (recommended)** — open the site in Chrome, then **⋮ menu → Install app**. No warnings, no APK, auto-updates with every deploy.
2. **Android APK** — install `Meetup.apk` from the `meetup-android` project. First-time sideload requires confirming Chrome's "Install unknown apps" and Play Protect's "Install anyway". The APK is linked to this site's deep-link verification via `public/.well-known/assetlinks.json`.

## Usage

1. Enter your name
2. Create or enter a room name
3. Join and share the room link with others
4. Optional: share your screen, chat, record

## Tech Stack

- **React 18** + **TypeScript** — UI framework
- **Vite** — build tool and dev server
- **Tailwind CSS** — styling
- **WebRTC** — media transport (P2P mesh)
- **Socket.IO** — signaling (Vercel serverless function)
- **PWA** — manifest + service worker for installability

## Documentation

- [WEBRTC_README.md](./WEBRTC_README.md) — the custom WebRTC implementation
- [MEDIASOUP_SETUP.md](./MEDIASOUP_SETUP.md) — SFU server setup if later needed for 50+ participants
- [FEATURES.md](./FEATURES.md) — advanced feature guide
- [RECORDING_INFO.md](./RECORDING_INFO.md) — where recordings are saved
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — common issues

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
