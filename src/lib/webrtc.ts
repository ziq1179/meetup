/**
 * WebRTC Connection Manager
 * 
 * Handles peer-to-peer WebRTC connections for video/audio streaming
 * Supports both mesh (P2P) and SFU modes
 */

import { getWebRTCConfig } from '../config/webrtc'
import { captureError } from './telemetry'

export interface PeerConnection {
  peerConnection: RTCPeerConnection;
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
  socketId: string;
  userId: string;
  userName: string;
}

export class WebRTCManager {
  private localStream: MediaStream | null = null;
  private screenShareStream: MediaStream | null = null;
  private recordingStream: MediaStream | null = null; // Separate stream for recording
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private remoteStreams: Map<string, MediaStream> = new Map();
  private socket: any = null;
  private roomId: string = '';
  // userId and userName stored for potential future use (e.g., logging, analytics)
  // @ts-ignore - stored for potential future use
  private _userId: string = '';
  // @ts-ignore - stored for potential future use
  private _userName: string = '';
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];

  // Use configuration with STUN and TURN servers
  private readonly rtcConfiguration: RTCConfiguration = getWebRTCConfig();

  constructor(
    socket: any,
    roomId: string,
    userId: string,
    userName: string,
    onRemoteStream: (socketId: string, stream: MediaStream, userName?: string, userId?: string) => void,
    onUserLeft: (socketId: string) => void
  ) {
    this.socket = socket;
    this.roomId = roomId;
    this._userId = userId; // Store for potential future use
    this._userName = userName; // Store for potential future use
    this.setupSocketListeners(onRemoteStream, onUserLeft);
  }

  private setupSocketListeners(
    onRemoteStream: (socketId: string, stream: MediaStream, userName?: string, userId?: string) => void,
    onUserLeft: (socketId: string) => void
  ) {
    // Handle incoming offer
    this.socket.on('offer', async ({ offer, senderSocketId, senderName, senderUserId }: any) => {
      await this.handleOffer(offer, senderSocketId, onRemoteStream, senderName, senderUserId);
    });

    // Handle incoming answer
    this.socket.on('answer', async ({ answer, senderSocketId }: any) => {
      await this.handleAnswer(answer, senderSocketId);
    });

    // Handle ICE candidates
    this.socket.on('ice-candidate', async ({ candidate, senderSocketId }: any) => {
      await this.handleIceCandidate(candidate, senderSocketId);
    });

    // Handle existing participants
    this.socket.on('existing-participants', async (participants: any[]) => {
      for (const participant of participants) {
        await this.createPeerConnection(participant.socketId, participant.userId, participant.userName, true, onRemoteStream);
      }
    });

    // Handle user joined
    this.socket.on('user-joined', async ({ socketId, userId, userName }: any) => {
      await this.createPeerConnection(socketId, userId, userName, false, onRemoteStream);
    });

    // Handle user left
    this.socket.on('user-left', ({ socketId }: any) => {
      this.removePeerConnection(socketId);
      onUserLeft(socketId);
    });
  }

  async initializeLocalStream(audio: boolean, video: boolean): Promise<MediaStream> {
    try {
      // Check if mediaDevices API is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(
          'getUserMedia is not supported in this browser. ' +
          'Please use a modern browser (Chrome, Firefox, Edge, Safari) and ensure you are accessing the site via HTTPS.'
        );
      }

      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio,
        video: video ? { width: 1280, height: 720 } : false
      });
      return this.localStream;
    } catch (error: any) {
      captureError(error, 'media-access')
      console.error('Error accessing media devices:', error);
      
      // Provide helpful error messages
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        throw new Error('Camera/microphone permission denied. Please allow access and try again.');
      } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
        throw new Error('No camera/microphone found. Please connect a device and try again.');
      } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
        throw new Error('Camera/microphone is already in use by another application.');
      } else if (error.message && error.message.includes('getUserMedia')) {
        throw new Error(
          'getUserMedia is not available. ' +
          'Make sure you are accessing the site via HTTPS (not HTTP). ' +
          'If using ngrok, use the HTTPS URL (https://...).'
        );
      }
      
      throw error;
    }
  }

  private async createPeerConnection(
    socketId: string,
    userId: string,
    userName: string,
    isInitiator: boolean,
    onRemoteStream: (socketId: string, stream: MediaStream, userName?: string, userId?: string) => void
  ) {
    if (this.peerConnections.has(socketId)) {
      return;
    }

    const peerConnection = new RTCPeerConnection(this.rtcConfiguration);

    // Add local stream tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, this.localStream!);
      });
    }

    // Handle remote stream
    peerConnection.ontrack = (event) => {
      const remoteStream = event.streams[0];
      if (remoteStream) {
        this.remoteStreams.set(socketId, remoteStream);
        onRemoteStream(socketId, remoteStream, userName, userId);
      }
    };

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('ice-candidate', {
          candidate: event.candidate,
          targetSocketId: socketId,
          roomId: this.roomId
        });
      }
    };

    // Handle connection state changes
    peerConnection.onconnectionstatechange = () => {
      console.log(`Connection state with ${socketId}:`, peerConnection.connectionState);
      if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected') {
        this.removePeerConnection(socketId);
      }
    };

    this.peerConnections.set(socketId, peerConnection);

    // Create offer if we're the initiator
    if (isInitiator) {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      this.socket.emit('offer', {
        offer,
        targetSocketId: socketId,
        roomId: this.roomId
      });
    }
  }

  private async handleOffer(offer: RTCSessionDescriptionInit, senderSocketId: string, onRemoteStream: (socketId: string, stream: MediaStream, userName?: string, userId?: string) => void, senderName?: string, senderUserId?: string) {
    await this.createPeerConnection(senderSocketId, senderUserId || '', senderName || '', false, onRemoteStream);
    const peerConnection = this.peerConnections.get(senderSocketId);
    if (peerConnection) {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      this.socket.emit('answer', {
        answer,
        targetSocketId: senderSocketId,
        roomId: this.roomId
      });
    }
  }

  private async handleAnswer(answer: RTCSessionDescriptionInit, senderSocketId: string) {
    const peerConnection = this.peerConnections.get(senderSocketId);
    if (peerConnection) {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  private async handleIceCandidate(candidate: RTCIceCandidateInit, senderSocketId: string) {
    const peerConnection = this.peerConnections.get(senderSocketId);
    if (peerConnection) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  toggleAudio(enabled: boolean) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = enabled;
      });
    }
  }

  toggleVideo(enabled: boolean) {
    if (this.localStream) {
      this.localStream.getVideoTracks().forEach(track => {
        track.enabled = enabled;
      });
    }
  }

  async startScreenShare(): Promise<MediaStream> {
    try {
      // Check if getDisplayMedia is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        throw new Error(
          'Screen sharing is not supported in this browser. ' +
          'Please use a modern browser and ensure you are accessing the site via HTTPS.'
        );
      }

      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      });

      // Replace video track in all peer connections
      const videoTrack = screenStream.getVideoTracks()[0];
      this.peerConnections.forEach((peerConnection) => {
        const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
        if (sender && videoTrack) {
          sender.replaceTrack(videoTrack);
        }
      });

      // Stop old video track
      if (this.localStream) {
        this.localStream.getVideoTracks().forEach(track => track.stop());
        this.localStream.removeTrack(this.localStream.getVideoTracks()[0]);
        this.localStream.addTrack(videoTrack);
      }

      // Store screen share stream for recording
      this.screenShareStream = screenStream;

      // Handle screen share stop
      videoTrack.onended = () => {
        this.stopScreenShare();
      };

      return screenStream;
    } catch (error) {
      captureError(error, 'screen-share-media')
      console.error('Error starting screen share:', error);
      throw error;
    }
  }

  async stopScreenShare() {
    // Clear screen share stream
    if (this.screenShareStream) {
      this.screenShareStream.getTracks().forEach(track => track.stop());
      this.screenShareStream = null;
    }

    // Get camera stream again
    if (this.localStream) {
      // Check if mediaDevices API is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('getUserMedia is not available. Please refresh the page.');
      }

      const cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
        audio: true
      });

      const videoTrack = cameraStream.getVideoTracks()[0];
      this.peerConnections.forEach((peerConnection) => {
        const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
        if (sender && videoTrack) {
          sender.replaceTrack(videoTrack);
        }
      });

      // Update local stream
      this.localStream.getVideoTracks().forEach(track => track.stop());
      this.localStream.removeTrack(this.localStream.getVideoTracks()[0]);
      this.localStream.addTrack(videoTrack);
    }
  }

  private removePeerConnection(socketId: string) {
    const peerConnection = this.peerConnections.get(socketId);
    if (peerConnection) {
      peerConnection.close();
      this.peerConnections.delete(socketId);
    }
    this.remoteStreams.delete(socketId);
  }

  cleanup() {
    // Stop local stream
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
    }

    // Close all peer connections
    this.peerConnections.forEach((peerConnection) => {
      peerConnection.close();
    });
    this.peerConnections.clear();
    this.remoteStreams.clear();
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStreams(): Map<string, MediaStream> {
    return this.remoteStreams;
  }

  // Recording functionality - Browser tab/window recording
  async startRecording(): Promise<void> {
    // Automatically capture browser tab/window for recording
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error('Screen capture is not supported in this browser. Please use a modern browser (Chrome, Firefox, Edge).')
    }

    // Request screen capture (browser will ask user to select tab/window)
    let recordingStream: MediaStream;
    try {
      recordingStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'browser', // Prefer browser tab
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: true // Include system audio if available
      });
    } catch (error: any) {
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        throw new Error('Screen capture permission denied. Please allow screen sharing to record.')
      }
      throw new Error(`Failed to start screen capture: ${error.message}`)
    }

    const videoTrack = recordingStream.getVideoTracks()[0];
    if (!videoTrack) {
      throw new Error('No video track in screen capture stream.')
    }

    // Store the recording stream separately (don't interfere with screen share)
    this.recordingStream = recordingStream;

    // Handle when user stops sharing (via browser UI)
    videoTrack.onended = () => {
      console.log('Screen capture ended by user')
      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        // Set up onstop handler before stopping
        this.mediaRecorder.onstop = () => {
          console.log('Recording stopped due to screen capture ending')
          // Clean up recording stream
          if (this.recordingStream) {
            this.recordingStream.getTracks().forEach(track => {
              if (track.readyState !== 'ended') {
                track.stop()
              }
            })
            this.recordingStream = null
          }
          // Clear recorded chunks if recording was interrupted
          this.recordedChunks = []
        }
        this.mediaRecorder.stop()
      }
    }

    console.log('Recording browser tab/window');

    // For recording, we'll record the screen/camera video + all audio tracks
    const tracks: MediaStreamTrack[] = []
    
    // Add video track (screen share or camera)
    tracks.push(videoTrack)
    
    // Add local audio track
    if (this.localStream) {
      const localAudioTrack = this.localStream.getAudioTracks()[0]
      if (localAudioTrack && localAudioTrack.enabled) {
        tracks.push(localAudioTrack)
      }
    }
    
    // Add remote audio tracks (to record audio from all participants)
    this.remoteStreams.forEach(stream => {
      stream.getAudioTracks().forEach(track => {
        if (track.enabled) {
          tracks.push(track)
        }
      })
    })

    // Create a combined stream for recording
    const combinedStream = new MediaStream(tracks)
    
    // Verify the stream has video
    if (combinedStream.getVideoTracks().length === 0) {
      throw new Error('No video track in recording stream. Make sure your camera is enabled.')
    }
    
    const options: MediaRecorderOptions = {
      mimeType: 'video/webm;codecs=vp9,opus',
      videoBitsPerSecond: 2500000,
      audioBitsPerSecond: 128000
    }

    // Fallback to webm if vp9 not supported
    if (!MediaRecorder.isTypeSupported(options.mimeType!)) {
      options.mimeType = 'video/webm;codecs=vp8,opus'
    }
    if (!MediaRecorder.isTypeSupported(options.mimeType!)) {
      options.mimeType = 'video/webm'
    }

    console.log('Starting screen recording with stream:', {
      videoSource: 'screen',
      videoTracks: combinedStream.getVideoTracks().length,
      audioTracks: combinedStream.getAudioTracks().length,
      mimeType: options.mimeType,
      videoTrackEnabled: combinedStream.getVideoTracks()[0]?.enabled,
      videoTrackLabel: combinedStream.getVideoTracks()[0]?.label
    })

    this.mediaRecorder = new MediaRecorder(combinedStream, options)
    this.recordedChunks = []

    this.mediaRecorder.onerror = (event: any) => {
      console.error('MediaRecorder error:', event)
    }

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        console.log('Recording data chunk:', event.data.size, 'bytes')
        this.recordedChunks.push(event.data)
      }
    }

    // Start recording with timeslice to ensure data is captured
    this.mediaRecorder.start(1000) // Collect data every second
    
    console.log('Recording started, state:', this.mediaRecorder.state)
  }

  async stopRecording(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      // Check if MediaRecorder exists
      if (!this.mediaRecorder) {
        // If no MediaRecorder, check if we have any recorded chunks (might have been stopped externally)
        if (this.recordedChunks.length > 0) {
          const blob = new Blob(this.recordedChunks, { type: 'video/webm' })
          this.recordedChunks = []
          // Clean up recording stream if it exists
          if (this.recordingStream) {
            this.recordingStream.getTracks().forEach(track => {
              if (track.readyState !== 'ended') {
                track.stop()
              }
            })
            this.recordingStream = null
          }
          resolve(blob)
          return
        }
        reject(new Error('No active recording'))
        return
      }

      // If already inactive, check if we have recorded data
      if (this.mediaRecorder.state === 'inactive') {
        if (this.recordedChunks.length > 0) {
          const blob = new Blob(this.recordedChunks, { type: 'video/webm' })
          this.recordedChunks = []
          // Clean up recording stream if it exists
          if (this.recordingStream) {
            this.recordingStream.getTracks().forEach(track => {
              if (track.readyState !== 'ended') {
                track.stop()
              }
            })
            this.recordingStream = null
          }
          resolve(blob)
          return
        }
        reject(new Error('No active recording'))
        return
      }

      // If recording is paused, resume first (though we don't use pause, this is defensive)
      if (this.mediaRecorder.state === 'paused') {
        this.mediaRecorder.resume()
      }

      // Set up onstop handler before stopping
      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: 'video/webm' })
        this.recordedChunks = []
        
        // Stop the recording stream tracks (browser capture)
        if (this.recordingStream) {
          this.recordingStream.getTracks().forEach(track => {
            // Only stop if track is still active (not already stopped by user)
            if (track.readyState !== 'ended') {
              track.stop()
            }
          })
          this.recordingStream = null
        }
        
        resolve(blob)
      }

      // Add error handler in case stop fails
      this.mediaRecorder.onerror = (event: any) => {
        console.error('Error stopping MediaRecorder:', event)
        // Still try to create blob from existing chunks
        if (this.recordedChunks.length > 0) {
          const blob = new Blob(this.recordedChunks, { type: 'video/webm' })
          this.recordedChunks = []
          // Clean up
          if (this.recordingStream) {
            this.recordingStream.getTracks().forEach(track => {
              if (track.readyState !== 'ended') {
                track.stop()
              }
            })
            this.recordingStream = null
          }
          resolve(blob)
        } else {
          reject(new Error('Failed to stop recording'))
        }
      }

      try {
        this.mediaRecorder.stop()
      } catch (error: any) {
        console.error('Exception stopping MediaRecorder:', error)
        // If stop() throws, try to recover with existing chunks
        if (this.recordedChunks.length > 0) {
          const blob = new Blob(this.recordedChunks, { type: 'video/webm' })
          this.recordedChunks = []
          // Clean up
          if (this.recordingStream) {
            this.recordingStream.getTracks().forEach(track => {
              if (track.readyState !== 'ended') {
                track.stop()
              }
            })
            this.recordingStream = null
          }
          resolve(blob)
        } else {
          reject(new Error(`Failed to stop recording: ${error.message}`))
        }
      }
    })
  }

  isRecording(): boolean {
    return this.mediaRecorder?.state === 'recording' || false
  }

  downloadRecording(blob: Blob, filename: string = 'recording.webm'): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }
}
