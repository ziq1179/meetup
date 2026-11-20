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
        'reaction-float': {
          '0%': { opacity: '0', transform: 'translateY(0) scale(0.5)' },
          '12%': { opacity: '1', transform: 'translateY(-14px) scale(1.15)' },
          '25%': { transform: 'translateY(-34px) scale(1)' },
          '100%': { opacity: '0', transform: 'translateY(-230px) scale(0.95)' },
        },
      },
      animation: {
        'reaction-float': 'reaction-float 3s ease-out forwards',
      },
    },
  },
  plugins: [],
}

