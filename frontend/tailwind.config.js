/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./pages/**/*.{js,jsx}', './components/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // "Brand" is the site's action colour. It is now the black theme: the
        // primary steps sit on ink-900 (#111827) with a darker hover, and the
        // lighter steps are neutral greys for chips, rings and subtle tints.
        brand: {
          50: '#f6f6f7', 100: '#e7e7e9', 200: '#d3d3d6', 300: '#adadb3',
          400: '#74747c', 500: '#3d3d44', 600: '#111827', 700: '#0a0e18',
          800: '#060810', 900: '#03040a',
        },
        ink: {
          900: '#111827',
          700: '#374151',
          500: '#6b7280',
          400: '#9ca3af',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        // Hero headline face — Suisse Intl Book (licensed/local; used when installed)
        // with the closest universally-available neutral grotesques behind it.
        // To activate the real font: drop the woff2 files in frontend/public/fonts and
        // add an @font-face block to styles/globals.css, e.g.
        //   @font-face { font-family: 'Suisseintl Book'; src: url('/fonts/SuisseIntl-Book.woff2') format('woff2'); font-weight: 400; font-display: swap; }
        suisse: ['"Suisseintl Book"', '"Suisse Intl"', '"Helvetica Neue"', 'Helvetica', 'Arial', 'sans-serif'],
      },
      boxShadow: {
        sm: '0 1px 2px rgba(17,24,39,0.05)',
        DEFAULT: '0 1px 3px rgba(17,24,39,0.08)',
        premium: '0 1px 2px rgba(17,24,39,0.04), 0 12px 28px rgba(17,24,39,0.06)',
        'premium-lg': '0 1px 2px rgba(17,24,39,0.05), 0 18px 42px rgba(17,24,39,0.09)',
        'inner-soft': 'inset 0 1px 1px rgba(17,24,39,0.03)',
      },
      keyframes: {
        // Testimonial carousel — each swap replays this on the keyed content block.
        'fade-slide': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-slide': 'fade-slide 0.35s ease-out',
      },
    },
  },
  plugins: [],
};
