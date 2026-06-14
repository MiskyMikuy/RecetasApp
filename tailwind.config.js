/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        misky: {
          purple: '#602a80', /* El morado del logo */
          red: '#d12229',    /* El rojo del logo */
          green: '#127b46',  /* El verde de los adornos */
          yellow: '#f4a62a', /* El amarillo/naranja */
          bg: '#000000',     /* Fondo principal */
          text: '#F3F0DF'    /* Texto claro */
        }
      }
    },
  },
  plugins: [],
}
