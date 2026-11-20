import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react()
  ],
  server: {
    port: 3000,
    host: '0.0.0.0', // Allow access from network
    // HTTPS is provided by Netlify in production
    // For local development, you can use http://localhost:3000 (WebRTC works on localhost)
    // Or install @vitejs/plugin-basic-ssl separately if you need HTTPS locally
    open: true
  }
})

