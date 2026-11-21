/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#fff7ed',
          100: '#ffedd5',
          200: '#fed7aa',
          300: '#fdba74',
          400: '#fb923c',
          500: '#f97316',
          600: '#ea580c',
          700: '#c2410c',
          800: '#9a3412',
          900: '#7c2d12',
        },
      },
      keyframes: {
        // Emoji spirals side-to-side as it rises, then fades out.
        'reaction-swirl': {
          '0%': { opacity: '0', transform: 'translate(0, 0) scale(0.4) rotate(-35deg)' },
          '10%': { opacity: '1', transform: 'translate(-14px, -20px) scale(1.25) rotate(22deg)' },
          '25%': { transform: 'translate(22px, -58px) scale(1) rotate(-20deg)' },
          '40%': { transform: 'translate(-22px, -98px) rotate(24deg)' },
          '55%': { transform: 'translate(20px, -138px) rotate(-22deg)' },
          '70%': { transform: 'translate(-16px, -178px) rotate(18deg)' },
          '85%': { opacity: '0.75', transform: 'translate(11px, -212px) scale(0.95) rotate(-12deg)' },
          '100%': { opacity: '0', transform: 'translate(-4px, -245px) scale(0.85) rotate(6deg)' },
        },
        // Mirrored path so consecutive reactions don't all swirl the same way.
        'reaction-swirl-alt': {
          '0%': { opacity: '0', transform: 'translate(0, 0) scale(0.4) rotate(35deg)' },
          '10%': { opacity: '1', transform: 'translate(14px, -20px) scale(1.25) rotate(-22deg)' },
          '25%': { transform: 'translate(-22px, -58px) scale(1) rotate(20deg)' },
          '40%': { transform: 'translate(22px, -98px) rotate(-24deg)' },
          '55%': { transform: 'translate(-20px, -138px) rotate(22deg)' },
          '70%': { transform: 'translate(16px, -178px) rotate(-18deg)' },
          '85%': { opacity: '0.75', transform: 'translate(-11px, -212px) scale(0.95) rotate(12deg)' },
          '100%': { opacity: '0', transform: 'translate(4px, -245px) scale(0.85) rotate(-6deg)' },
        },
      },
      animation: {
        'reaction-swirl': 'reaction-swirl 3s ease-out forwards',
        'reaction-swirl-alt': 'reaction-swirl-alt 3s ease-out forwards',
      },
    },
  },
  plugins: [],
}

