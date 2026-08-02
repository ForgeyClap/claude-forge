/// <reference types="node" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: the pathname is percent-encoded, so a project
// folder containing a space resolved to ".../Forge%20dashboard" and every "@/"
// import failed to resolve. This handles Windows drive letters and escaping.
const here = path.dirname(fileURLToPath(import.meta.url));

// Relative base so a built prototype can be opened from any sub-path.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(here, 'src'),
      '@brand': path.resolve(here, 'brand'),
    },
  },
  build: {
    // Vendor code changes on an npm install; app code changes every commit.
    // Splitting them means a view tweak no longer invalidates the React and
    // lucide bytes in everyone's cache.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          const path = id.replace(/\\/g, '/');

          // Icons are a leaf dependency nothing else pulls in, and they are the
          // single biggest vendor after React. Their own chunk keeps the
          // budget in scripts/analyze-bundle.cjs pointed at something legible:
          // if this chunk grows, someone reintroduced a namespace import.
          if (path.includes('/node_modules/lucide-react/')) return 'icons';

          // Checked before the React rule below. "react-router-dom" would not
          // match /react\// anyway, but ordering makes that non-accidental.
          //
          // cookie and set-cookie-parser are react-router's own transitive
          // deps. They are named here rather than left to the catch-all
          // because this app uses HashRouter, so both tree-shake to nothing —
          // and a catch-all chunk whose every module vanishes still emits a
          // stray 0-byte file into dist/assets.
          if (
            /\/node_modules\/(react-router|react-router-dom|@remix-run|cookie|set-cookie-parser)\//.test(
              path,
            )
          ) {
            return 'router';
          }

          // react, react-dom and scheduler ship as one chunk on purpose.
          // react-dom imports react at module scope, and splitting a pair like
          // that across chunks is how you get a "cannot access before
          // initialization" crash at runtime.
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(path)) return 'react';

          return 'vendor';
        },
      },
    },
  },
  // Bind IPv4 explicitly. Left to default, Vite binds "localhost" which resolves
  // to ::1 only on Windows, and Playwright's 127.0.0.1 health check times out.
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  test: {
    globals: true,
    restoreMocks: true,
    css: false,
    // Two environments: the browser-facing unit tests need jsdom; the node suites
    // drive real fs / real temp dirs. The path-guard suite keeps its own config.
    //
    // HONEST PROJECT NAMES (system-checkup finding, 2026-07-30): `chaos`,
    // `idempotency` and `negative` exercise ONLY `src/bridge/**` — the 39-op
    // WebSocket bridge this product never runs (the live path is REST+SSE to the
    // gateway on :4100; `bridge-client.ts` is `import type` only and
    // `PrototypeProvider` mounts the GATEWAY controller). Verified: every test
    // file in those three directories imports `@/bridge`. Their green result is
    // therefore evidence about DEAD code, and a project called `bridge` sitting
    // in a passing run read as if the shipped product had been verified by it.
    // Nothing is removed — the owner's "niks verwijderen" rule holds and full
    // coverage keeps running on every `npm run verify`, so a future revival of
    // the bridge is still protected — but the label now says what it proves.
    // `tests/property/**` is deliberately NOT in there: it tests `@/shared/**`
    // (protocol + state machines), which the live path really does import.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          setupFiles: ['./tests/setup.ts'],
          include: ['tests/unit/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'shared',
          environment: 'node',
          include: ['tests/property/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'legacy-bridge',
          environment: 'node',
          include: [
            'tests/chaos/**/*.test.ts',
            'tests/idempotency/**/*.test.ts',
            'tests/negative/**/*.test.ts',
          ],
        },
      },
      {
        // The fuzz suite drives the same bridge modules under Node, plus the
        // markdown renderer via renderToStaticMarkup (no DOM needed). css:false
        // is inherited from the top-level config, so the primitive-layer CSS
        // import that markdown.tsx pulls in transitively is a no-op here.
        extends: true,
        test: {
          name: 'fuzz',
          environment: 'node',
          include: ['tests/fuzz/**/*.test.ts'],
        },
      },
    ],
  },
});
