import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  plugins: [reactRouter()],
  // The image ships only the packages below in node_modules. The build bundles everything
  // else. Development keeps the default: Vite cannot run some CommonJS packages inline.
  ssr:
    command === 'build'
      ? {
          noExternal: true,
          external: ['react', 'react-dom', 'react-router', '@react-router/node', 'postgres', 'sharp'],
        }
      : undefined,
}));
