module.exports = {
  content: ['./pages/**/*.{js,jsx}','./components/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        primary: '#0f766e',
        accent: '#f97316',
        soft: '#f7f7f9',
        warn: '#fef3c7'
      },
      fontFamily: {
        inter: ['Inter', 'sans-serif']
      },
      borderRadius: {
        xl: '1rem'
      }
    }
  },
  plugins: [],
};
