import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  logLevel: 'info',
  sourcemap: false,
  legalComments: 'none',
};

await build({
  ...common,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.js',
});

await build({
  ...common,
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.js',
});
