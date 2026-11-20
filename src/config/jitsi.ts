/**
 * Jitsi Meet Configuration
 * 
 * If meet.jit.si requires login, you have two options:
 * 1. Change the domain to your own Jitsi server (recommended for production)
 * 2. Use an alternative public Jitsi instance
 * 
 * To set up your own Jitsi server, see: https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-quickstart
 */

export const JITSI_CONFIG = {
  // Change this to your own Jitsi server domain if meet.jit.si requires login
  // Example: 'jitsi.yourdomain.com' or 'meet.example.com'
  // 
  // IMPORTANT: If you're seeing "waiting for moderator" screen, try these alternatives:
  // - Use a completely random/unique room name (click Generate in the setup screen)
  // - Or set up your own Jitsi server (see instructions below)
  // - Or try alternative public instances (uncomment one below)
  
  domain: 'meet.jit.si',
  
  // Alternative public instances (uncomment to try):
  // domain: 'meet.jit.si', // Default - may require moderator for some rooms
  // domain: '8x8.vc', // 8x8's public Jitsi instance (may have different policies)
  
  // For your own server, you might need to specify the external API script:
  // externalApiScript: 'https://your-jitsi-server.com/external_api.js',
  
  // Quick setup for your own Jitsi server using Docker:
  // docker run -d -p 80:80 -p 443:443 -p 4443:4443 -p 10000:10000/udp jitsi/web
  // Then change domain above to your server's IP or domain
}
