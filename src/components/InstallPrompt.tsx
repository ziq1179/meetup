import { useEffect, useState } from 'react'
import { trackEvent } from '../lib/telemetry'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const DISMISS_KEY = 'meetup-install-dismissed-at'
const DISMISS_COOLDOWN_DAYS = 7

// True when the app is already running as an installed PWA
function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

// iOS Safari (and iPadOS Safari, even with a desktop UA) never fires
// beforeinstallprompt, so it needs a manual-instructions banner instead.
function isIOS() {
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

function wasDismissedRecently() {
  const last = Number(localStorage.getItem(DISMISS_KEY) || 0)
  return Number.isFinite(last) && Date.now() - last < DISMISS_COOLDOWN_DAYS * 24 * 60 * 60 * 1000
}

/**
 * Popup that invites visitors to install Meetup as an app.
 * - Chromium/Android: uses the native beforeinstallprompt → one-tap install.
 * - iOS/Safari: shows manual "Add to Home Screen" instructions.
 * - Hidden when already installed, or for 7 days after dismissal.
 */
export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showIOS, setShowIOS] = useState(false)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    if (isStandalone() || wasDismissedRecently()) {
      setHidden(true)
      return
    }

    const onBeforeInstall = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)

    // Native install UI never appears for iOS — only fall back to manual
    // instructions if there is no Chromium prompt by the time the page settles.
    if (isIOS()) {
      const timer = window.setTimeout(() => setShowIOS(true), 1500)
      return () => {
        window.removeEventListener('beforeinstallprompt', onBeforeInstall)
        window.clearTimeout(timer)
      }
    }

    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall)
  }, [])

  if (hidden) return null

  const dismiss = () => {
    if (localStorage.getItem(DISMISS_KEY) === null || !isStandalone()) {
      localStorage.setItem(DISMISS_KEY, String(Date.now()))
    }
    setHidden(true)
  }

  const install = async () => {
    if (!deferredPrompt) {
      dismiss()
      return
    }
    try {
      await deferredPrompt.prompt()
      const choice = await deferredPrompt.userChoice
      if (choice.outcome === 'dismissed') {
        localStorage.setItem(DISMISS_KEY, String(Date.now()))
      } else {
        trackEvent('install_accepted')
      }
    } catch (err) {
      console.warn('Install prompt failed:', err)
    }
    setDeferredPrompt(null)
    setHidden(true)
  }

  if (!deferredPrompt && !showIOS) return null

  return (
    <div
      role="dialog"
      aria-label="Install Meetup app"
      className="fixed left-3 right-3 bottom-3 sm:left-auto sm:right-6 sm:bottom-6 sm:w-[380px] z-40"
      style={{ marginBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="bg-white rounded-2xl shadow-2xl border border-gray-100 p-4 flex items-start gap-3">
        <div className="w-11 h-11 rounded-xl bg-primary-500 flex items-center justify-center shrink-0">
          <svg className="w-6 h-6 text-white" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-gray-900 text-sm">Meetup on your phone?</p>
          {deferredPrompt ? (
            <>
              <p className="text-gray-600 text-sm mt-0.5">Install the app for one-tap access — no APK, no warnings.</p>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={install}
                  className="flex-1 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition"
                >
                  Install app
                </button>
                <button
                  onClick={dismiss}
                  className="bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium px-4 py-2.5 rounded-lg transition"
                >
                  Not now
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-gray-600 text-sm mt-0.5">
                Tap the <span className="font-medium text-gray-900">Share</span> button
                <svg className="inline w-4 h-4 mx-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 9V5a2 2 0 0 1 2-2h3m5 0h3a2 2 0 0 1 2 2v3m0 5v3a2 2 0 0 1-2 2h-3M9 21H5a2 2 0 0 1-2-2v-3" />
                </svg>
                at the bottom of Safari, then <span className="font-medium text-gray-900">Add to Home Screen</span>.
              </p>
              <div className="flex justify-end mt-3">
                <button
                  onClick={dismiss}
                  className="bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium px-4 py-2 rounded-lg transition"
                >
                  Got it
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
