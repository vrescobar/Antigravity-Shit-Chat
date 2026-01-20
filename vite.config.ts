import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true, // Expose to network and print IP
    port: 3000,
    proxy: {
      '/cascades': 'http://localhost:3001',
      '/snapshot': 'http://localhost:3001',
      '/styles': 'http://localhost:3001',
      '/send': 'http://localhost:3001',
      '/action': 'http://localhost:3001',
    },
  },
});
