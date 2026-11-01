import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);

process.env.NODE_ENV = 'development';

// 先构建主进程与 preload（修改主进程代码后需重新运行 npm run dev）。
const mainBuild = spawn(process.execPath, ['scripts/build-main.mjs'], { stdio: 'inherit' });
await new Promise((resolve, reject) => {
  mainBuild.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('主进程构建失败'))));
});

const server = await createServer({ configFile: 'vite.config.ts', mode: 'development' });
await server.listen();
server.printUrls();
const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5173/';

const electronPath = require('electron');
const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: url,
    ELECTRON_ENABLE_LOGGING: '1',
  },
});

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.close();
  process.exit(code);
}

child.on('exit', (code) => void shutdown(code ?? 0));
process.on('SIGINT', () => {
  child.kill('SIGINT');
  void shutdown(0);
});
process.on('SIGTERM', () => {
  child.kill('SIGTERM');
  void shutdown(0);
});
