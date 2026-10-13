import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr:
        process.env.DISABLE_HMR === 'true'
          ? false
          : {
              clientPort: process.env.HMR_CLIENT_PORT
                ? Number(process.env.HMR_CLIENT_PORT)
                : undefined,
            },
      // Support filesystem polling in containerized bind mounts if CHOKIDAR_USEPOLLING / WATCH_POLL is set
      watch:
        process.env.DISABLE_HMR === 'true'
          ? null
          : {
              usePolling: process.env.WATCH_POLL === 'true',
            },
    },
  };
});
