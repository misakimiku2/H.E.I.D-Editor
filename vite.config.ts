import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import webviewCssFallback from './scripts/webview-css-fallback.mjs';

export default defineConfig({
  plugins: [react(), tailwindcss(), webviewCssFallback()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});