const spacing = Object.fromEntries(Array.from({ length: 321 }, (_, value) => [value, `${value / 10}rem`]));

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './*/index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    screens: { md: '768px', lg: '1024px', laptop: '1280px', xl: '1280px', '2xl': '1440px' },
    spacing: { ...spacing, px: '1px', auto: 'auto', full: '100%', screen: '100vw' },
    colors: {
      transparent: 'transparent', current: 'currentColor', black: '#000', white: '#fff',
      pink: '#e50083', orange: '#e94f0b', 'orange-dark': '#c44005',
      lavender: '#cfb3d4', teal: '#cfb3d4', gray: '#f1f1f1', 'gray-100': '#dedede', 'gray-dark': '#666',
      blue: '#cfb3d4', yellow: '#e94f0b',
    },
    fontFamily: { sans: ['Hanken Grotesk', 'Roboto', 'sans-serif'] },
    fontSize: {
      xs: '1rem', sm: '1.2rem', base: '1.4rem', md: '1.5rem', lg: '1.6rem', xl: '2rem',
      '2xl': '2.4rem', '3xl': '3.6rem', '4xl': '4.8rem', '5xl': '5.2rem',
      '6xl': '6.2rem', '7xl': '7.2rem', '8xl': '8.2rem', '9xl': '9.2rem',
    },
    lineHeight: { none: '1', xs: '.9', tight: '1.1', normal: '1.25', relaxed: '1.5' },
    letterSpacing: { tighter: '-.04em', tight: '-.025em', normal: '0', wide: '.025em' },
    zIndex: { '-3': '-3', '-2': '-2', '-1': '-1', 0: '0', 1: '1', 2: '2', 3: '3', 10: '10', 15: '15', 20: '20', 30: '30', 48: '48', 50: '50' },
    extend: { maxWidth: { 280: '28rem' }, minWidth: { 140: '14rem' }, height: { available: 'calc(100svh - var(--header))' }, minHeight: { available: 'calc(100svh - var(--header))' } },
  },
  plugins: [],
};
