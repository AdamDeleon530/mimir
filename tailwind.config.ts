import type { Config } from 'tailwindcss'

export default {
  content: [
    './components/**/*.{vue,ts}',
    './pages/**/*.{vue,ts}',
    './app.vue',
  ],
  theme: {
    extend: {
      colors: {
        // The Nordic Nerd brand palette
        fjord: '#0F1B2D',
        bone: '#F5F2EC',
        copper: '#B87333',
        // Scoreboard / dark UI
        matte: '#0a0a0a',
        offwhite: '#e8e8e8',
        gold: '#c9a64a',
        critred: '#c43838',
        critgreen: '#3a8a3a',
      },
      fontFamily: {
        serif: ['Fraunces', 'ui-serif', 'Georgia', 'serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      animation: {
        'pulse-gold': 'pulse-gold 2.4s ease-in-out infinite',
        'fade-in': 'fade-in 400ms ease-out',
      },
      keyframes: {
        'pulse-gold': {
          '0%, 100%': { opacity: '0.6', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.04)' },
        },
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
} satisfies Config
