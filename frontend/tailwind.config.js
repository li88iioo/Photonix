/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class', '[data-theme="dark"]'],
  content: [
    "./index.html",
    "./js/**/*.js"
  ],
  safelist: [
    'bg-surface-1','bg-surface-2','bg-surface-3',
    'text-foreground','text-muted',
    'border-border',
    'ring-accent',
    'bg-gradient-to-r','from-accent-1','via-accent-2','to-accent-3'
  ],
  theme: {
    extend: {
      colors: {
        background: 'var(--color-bg)',
        surface: {
          DEFAULT: 'var(--color-surface-1)',
          1: 'var(--color-surface-1)',
          2: 'var(--color-surface-2)',
          3: 'var(--color-surface-3)',
        },
        foreground: 'var(--color-text)',
        muted: 'var(--color-text-muted)',
        border: 'var(--color-border)',
        overlay: 'var(--color-overlay)',
        accent: {
          DEFAULT: 'var(--color-accent-1)',
          1: 'var(--color-accent-1)',
          2: 'var(--color-accent-2)',
          3: 'var(--color-accent-3)',
          4: 'var(--color-accent-4)',
        }
      },
      backgroundImage: {
        'gradient-morning-mist': 'var(--gradient-morning-mist)',
        'gradient-accent': 'var(--gradient-accent)',
        'gradient-ambient': 'var(--gradient-ambient)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-md)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
        '2xl': 'var(--shadow-2xl)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
        full: 'var(--radius-full)',
      },
      spacing: {
        1: 'var(--space-1)',
        2: 'var(--space-2)',
        3: 'var(--space-3)',
        4: 'var(--space-4)',
        6: 'var(--space-6)',
        8: 'var(--space-8)',
        12: 'var(--space-12)',
        16: 'var(--space-16)',
      },
      zIndex: {
        1: '1',
        10: '10',
        50: '50',
        100: '100',
        999: '999',
        max: 'var(--z-max)',
      },
      transitionDuration: {
        DEFAULT: 'var(--duration-normal)',
        fast: 'var(--duration-fast)',
        slow: 'var(--duration-slow)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      }
    }
  },
  plugins: [
    require('@tailwindcss/aspect-ratio'),
  ],
}
