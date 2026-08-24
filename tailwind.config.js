/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}", "./public/index.html"],
  theme: {
    extend: {
      colors: {
        // Paleta de marca Misky Mikuy (violeta tomado del isologo)
        misky: {
          50:  "#F9F4FB",
          100: "#F1E5F6",
          200: "#E2C6EC",
          300: "#CD9ADF",
          400: "#AE5BCD",
          500: "#8F35B1",
          600: "#7A2C96",
          700: "#612577", // color exacto del isologo
          800: "#4B1F5C",
          900: "#351740",
        },
        // Rojo del isologo, para acentos puntuales
        mikuy: {
          50:  "#FDEEEE",
          100: "#FAD6D8",
          200: "#F3A6AB",
          300: "#E9747C",
          400: "#DE4550",
          500: "#D31A23", // color exacto del isologo
          600: "#B0151D",
          700: "#8C1117",
          800: "#690D12",
          900: "#46080C",
        },
      },
    },
  },
  plugins: [],
};
