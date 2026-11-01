import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = process.cwd();

function cspPlugin(): Plugin {
  return {
    name: 'tokenledger-csp',
    transformIndexHtml(html, ctx) {
      const isDev = !!ctx.server;
      const csp = isDev
        ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none';"
        : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';";
      const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`;
      return html.replace('</head>', `  ${meta}\n  </head>`);
    },
  };
}

export default defineConfig({
  root: path.join(root, 'src/renderer'),
  base: './',
  plugins: [react(), tailwindcss(), cspPlugin()],
  resolve: {
    alias: {
      '@shared': path.join(root, 'src/shared'),
    },
  },
  build: {
    outDir: path.join(root, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome140',
    sourcemap: false,
    reportCompressedSize: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
