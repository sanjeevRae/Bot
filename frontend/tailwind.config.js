/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./pages/**/*.{js,jsx}', './components/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Premium monochrome — near-black accent, zinc neutrals.
        // brand-600 = primary buttons/links; 700 = hover.
        brand: {
          50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8',
          400: '#a1a1aa', 500: '#52525b', 600: '#18181b', 700: '#0a0a0a',
          800: '#27272a', 900: '#18181b',
        },
        ink: {
          900: '#111112',
          700: '#3f3f46',
          500: '#71717a',
          400: '#a1a1aa',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        sm: '0 1px 2px rgba(17,24,39,0.05)',
        DEFAULT: '0 1px 3px rgba(17,24,39,0.08)',
      },
    },
  },
  plugins: [],
};
