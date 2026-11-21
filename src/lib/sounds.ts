// Lightweight UI sound effects generated with the Web Audio API — no asset
// files to download, and nothing plays until the user has interacted with the
// page (browser autoplay policy).

let audioContext: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!audioContext) {
    try {
      audioContext = new Ctor()
    } catch {
      return null
    }
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {})
  }
  return audioContext
}

// Call from a user gesture (e.g. joining a call) so later sounds are allowed
export function unlockSounds() {
  getAudioContext()
}

function blip(frequencies: number[], duration: number, volume: number) {
  const ctx = getAudioContext()
  if (!ctx) return
  const now = ctx.currentTime
  frequencies.forEach((frequency, index) => {
    const start = now + index * (duration * 0.55)
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(frequency, start)
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(volume, start + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(start)
    osc.stop(start + duration + 0.02)
  })
}

// Incoming emoji reaction — a soft, quick pop
export function playReactionSound() {
  blip([740, 988], 0.16, 0.06)
}

// Someone raised their hand — a short two-note chime
export function playHandRaiseSound() {
  blip([523.25, 783.99, 1046.5], 0.22, 0.055)
}

// Your own hand raised — quieter single note
export function playHandConfirmSound() {
  blip([880], 0.12, 0.045)
}
