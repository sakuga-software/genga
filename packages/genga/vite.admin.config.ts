import { defineConfig } from 'vite';

// Builds the admin app into static files that `genga.handle` serves under `<adminPath>/_app/`.
// The relative base lets the dynamic imports resolve from the URL of the entry script, so the
// admin path stays a runtime option. The stylesheet comes from the Tailwind build (`build:css`).
export default defineConfig({
  base: './',
  publicDir: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  oxc: { jsx: { runtime: 'automatic' } },
  build: {
    outDir: 'dist/admin-app',
    emptyOutDir: true,
    assetsDir: '',
    // An inlined asset would need `data:` in more CSP directives.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    target: 'es2022',
    sourcemap: false,
    rolldownOptions: {
      // React libraries mark their client modules with "use client", which means nothing in this bundle.
      onwarn(warning, warn) {
        if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
      },
      input: { main: 'src/admin/app/main.tsx' },
      output: { entryFileNames: '[name]-[hash].js', chunkFileNames: '[name]-[hash].js' },
    },
  },
});
