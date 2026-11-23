import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server/index.ts',
    admin: 'src/admin/index.ts',
    render: 'src/render/index.ts',
    client: 'src/client/index.ts',
    preview: 'src/preview/index.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  fixedExtension: true,
  dts: true,
  sourcemap: false,
  clean: true,
});
