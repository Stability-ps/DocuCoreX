import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        royal: {
          50: "#eef6ff",
          100: "#d9ecff",
          200: "#b9ddff",
          300: "#88c8ff",
          400: "#4eadff",
          500: "#178ff6",
          600: "#0571dc",
          700: "#075ab2",
          800: "#0b4d93",
          900: "#0d4178",
        },
        navy: {
          950: "#020b24",
          900: "#071433",
          800: "#0a1d48",
          700: "#0d2a64",
        },
      },
      boxShadow: {
        glow: "0 28px 80px rgba(5, 113, 220, 0.22)",
        soft: "0 18px 60px rgba(7, 20, 51, 0.12)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "ui-sans-serif", "system-ui"],
      },
    },
  },
  plugins: [],
};

export default config;
