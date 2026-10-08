import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the build works from GitHub Pages (/leash/) or any static host.
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
