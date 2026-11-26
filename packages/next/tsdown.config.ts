import path from 'node:path';
import { defineConfig } from 'tsdown';

const clientEntry = path.resolve('src/client/index.ts');
const clientDir = path.dirname(clientEntry);

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client/index.ts',
  },
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  fixedExtension: true,
  dts: true,
  sourcemap: false,
  clean: true,
  plugins: [
    {
      // WARNING: server modules must import the client entry as its own file. Bundled into a
      // shared chunk, the client components lose `'use client'` and run on the server.
      name: 'genga-client-boundary',
      resolveId(source, importer) {
        if (!importer || `${path.dirname(importer)}${path.sep}`.startsWith(`${clientDir}${path.sep}`)) return null;
        const resolved = path.resolve(path.dirname(importer), source);
        if (resolved === clientDir || resolved === clientEntry.replace(/\.ts$/, '')) {
          return { id: './client.mjs', external: true };
        }
        return null;
      },
    },
  ],
});
