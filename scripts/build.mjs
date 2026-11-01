import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

rmSync('dist', { recursive: true, force: true });

const mainBuild = spawnSync(process.execPath, ['scripts/build-main.mjs'], {
  stdio: 'inherit',
  env: process.env,
});
if (mainBuild.status !== 0) {
  console.error('主进程构建失败');
  process.exit(mainBuild.status ?? 1);
}

const viteBin = path.join('node_modules', 'vite', 'bin', 'vite.js');
const rendererBuild = spawnSync(process.execPath, [viteBin, 'build'], {
  stdio: 'inherit',
  env: process.env,
});
if (rendererBuild.status !== 0) {
  console.error('渲染进程构建失败');
  process.exit(rendererBuild.status ?? 1);
}

console.log('构建完成：dist/main、dist/preload、dist/renderer');
