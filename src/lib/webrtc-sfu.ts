/**
 * WebRTC SFU Manager using Mediasoup
 * 
 * Handles SFU (Selective Forwarding Unit) connections for better scalability
 */

import * as mediasoupClient from 'mediasoup-client'

export interface SFUStreamCallback {
  (socketId: string, stream: MediaStream): void
}

export class WebRTCSFUManager {
  private device: mediasoupClient.types.Device | null = null
  private socket: any = null
  private roomId: string = ''
  private sendTransport: mediasoupClient.types.Transport | null = null
  private recvTransport: mediasoupClient.types.Transport | null = null
  private producers: Map<string, mediasoupClient.types.Producer> = new Map()
  private consumers: Map<string, mediasoupClient.types.Consumer> = new Map()
  private localStream: MediaStream | null = null
  private onRemoteStream: SFUStreamCallback | null = null

  constructor(
    socket: any,
    roomId: string,
    onRemoteStream: SFUStreamCallback
  ) {
    this.socket = socket
    this.roomId = roomId
    this.onRemoteStream = onRemoteStream
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

  async initialize() {
    // Create or join room
    return new Promise<void>((resolve, reject) => {
      this.socket.emit('create-room', { roomId: this.roomId }, async (response: any) => {
        if (response.error) {
          reject(new Error(response.error))
          return
        }

        try {
          this.device = new mediasoupClient.Device()
          await this.device.load({ routerRtpCapabilities: response.routerRtpCapabilities })

          // Join room
          this.socket.emit('join-room', {
            roomId: this.roomId,
            rtpCapabilities: this.device.rtpCapabilities,
          }, (joinResponse: any) => {
            if (joinResponse.error) {
              reject(new Error(joinResponse.error))
            } else {
              resolve()
            }
          })
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  async createSendTransport() {
    return new Promise<mediasoupClient.types.Transport>((resolve, reject) => {
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
          } catch (error: unknown) {
            errback(error instanceof Error ? error : new Error(String(error)))
          }
        })

        resolve(this.sendTransport)
      })
    })
  }

  async createRecvTransport() {
    return new Promise<mediasoupClient.types.Transport>((resolve, reject) => {
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
    if (!this.sendTransport || !this.device) {
      throw new Error('Transport or device not initialized')
    }

    this.localStream = stream

    // Produce audio
    if (stream.getAudioTracks().length > 0) {
      const track = stream.getAudioTracks()[0]
      const producer = await this.sendTransport.produce({ track })
      this.producers.set('audio', producer)
    }

    // Produce video
    if (stream.getVideoTracks().length > 0) {
      const track = stream.getVideoTracks()[0]
      const producer = await this.sendTransport.produce({ track })
      this.producers.set('video', producer)
    }
  }

  async consumeProducer(producerId: string, socketId: string, _kind: string) {
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

      try {
        if (!this.recvTransport) return
        const consumer = await this.recvTransport.consume({
          id: response.params.id,
          producerId: response.params.producerId,
          kind: response.params.kind,
          rtpParameters: response.params.rtpParameters,
        })

        this.consumers.set(producerId, consumer)

        const stream = new MediaStream([consumer.track])
        if (this.onRemoteStream) {
          this.onRemoteStream(socketId, stream)
        }
      } catch (error: unknown) {
        console.error('Error creating consumer:', error)
        if (error instanceof Error) {
          throw error
        }
      }
    })
  }

  toggleAudio(enabled: boolean) {
    const producer = this.producers.get('audio')
    if (producer) {
      producer.pause()
      if (enabled) {
        producer.resume()
      }
    }
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = enabled
      })
    }
  }

  toggleVideo(enabled: boolean) {
    const producer = this.producers.get('video')
    if (producer) {
      producer.pause()
      if (enabled) {
        producer.resume()
      }
    }
    if (this.localStream) {
      this.localStream.getVideoTracks().forEach(track => {
        track.enabled = enabled
      })
    }
  }

  async startScreenShare(): Promise<MediaStream> {
    if (!this.sendTransport) {
      throw new Error('Transport not initialized')
    }

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
    })

    const videoTrack = screenStream.getVideoTracks()[0]
    const videoProducer = this.producers.get('video')
    
    if (videoProducer) {
      videoProducer.replaceTrack({ track: videoTrack })
    } else {
      const producer = await this.sendTransport.produce({ track: videoTrack })
      this.producers.set('video', producer)
    }

    if (this.localStream) {
      this.localStream.getVideoTracks().forEach(track => track.stop())
      this.localStream.removeTrack(this.localStream.getVideoTracks()[0])
      this.localStream.addTrack(videoTrack)
    }

    videoTrack.onended = () => {
      this.stopScreenShare()
    }

    return screenStream
  }

  async stopScreenShare() {
    if (this.localStream) {
      // Check if mediaDevices API is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('getUserMedia is not available. Please refresh the page.');
      }

      const cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
        audio: true
      })

      const videoTrack = cameraStream.getVideoTracks()[0]
      const videoProducer = this.producers.get('video')
      
      if (videoProducer) {
        videoProducer.replaceTrack({ track: videoTrack })
      }

      if (this.localStream) {
        this.localStream.getVideoTracks().forEach(track => track.stop())
        this.localStream.removeTrack(this.localStream.getVideoTracks()[0])
        this.localStream.addTrack(videoTrack)
      }
    }
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

  getLocalStream(): MediaStream | null {
    return this.localStream
  }
}
