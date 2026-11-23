import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [reactRouter()],
  ssr: {
    // The image ships only the packages below in node_modules. Vite bundles everything else.
    noExternal: true,
    external: ['react', 'react-dom', 'react-router', '@react-router/node', 'postgres', 'sharp'],
  },
});
