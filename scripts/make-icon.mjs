import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

app.commandLine.appendSwitch('no-sandbox');

const root = process.cwd();
const assets = path.join(root, 'assets');
const iconset = path.join(assets, 'icon.iconset');
fs.mkdirSync(iconset, { recursive: true });

const html = `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  html, body { margin: 0; width: 1024px; height: 1024px; background: transparent; overflow: hidden; }
  .icon {
    position: absolute; left: 100px; top: 100px; width: 824px; height: 824px; border-radius: 186px;
    background: linear-gradient(158deg, #63b8ff 0%, #0a84ff 36%, #0457d8 72%, #033aa6 100%);
    box-shadow: 0 34px 70px rgba(3, 35, 100, 0.38), inset 0 3px 0 rgba(255, 255, 255, 0.32),
      inset 0 -4px 0 rgba(0, 0, 0, 0.16);
    display: flex; align-items: center; justify-content: center;
  }
  .mark {
    font-family: -apple-system, "SF Pro Display", "Helvetica Neue", sans-serif;
    font-weight: 700; font-size: 470px; line-height: 1; color: #fff;
    letter-spacing: -26px; margin-top: -70px; margin-left: -14px;
    text-shadow: 0 8px 28px rgba(0, 28, 90, 0.28);
  }
  .ledger {
    position: absolute; bottom: 138px; left: 50%; transform: translateX(-50%);
    display: flex; flex-direction: column; gap: 22px; align-items: center;
  }
  .ledger span { display: block; height: 18px; border-radius: 9px; background: rgba(255, 255, 255, 0.82); }
  .ledger span:nth-child(1) { width: 300px; }
  .ledger span:nth-child(2) { width: 216px; opacity: 0.72; }
  .ledger span:nth-child(3) { width: 128px; opacity: 0.5; }
</style></head>
<body>
  <div class="icon">
    <div class="mark">T</div>
    <div class="ledger"><span></span><span></span><span></span></div>
  </div>
</body></html>`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: false },
  });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await window.webContents.capturePage();
  const png = image.resize({ width: 1024, height: 1024 }).toPNG();
  fs.writeFileSync(path.join(assets, 'icon-1024.png'), png);
  console.log('icon-1024.png written');

  const sizes = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of sizes) {
    execFileSync('sips', ['-z', String(size), String(size), path.join(assets, 'icon-1024.png'), '--out', path.join(iconset, name)], {
      stdio: 'ignore',
    });
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(assets, 'icon.icns')], {
    stdio: 'inherit',
  });
  console.log('icon.icns written');
  app.quit();
});
