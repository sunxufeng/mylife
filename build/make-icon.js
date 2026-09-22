'use strict';
/**
 * 生成应用图标：build/icon.icns
 * 用法：node_modules/.bin/electron build/make-icon.js
 *
 * 做法：用一个透明的 1024×1024 无边框窗口渲染 build/icon.html，
 * 截图得到 1024 主图，再派生出 iconset 各尺寸，最后用 macOS 的 iconutil 打成 .icns。
 */

const { app, BrowserWindow, nativeImage } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, 'icon.html');
const OUT = path.join(__dirname, 'icon.iconset');
const MASTER = path.join(__dirname, 'icon-1024.png');

const SIZES = [
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

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false },
  });
  await win.loadFile(SRC);
  await new Promise((r) => setTimeout(r, 700));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const master = img.toPNG();
  fs.writeFileSync(MASTER, master);
  console.log('已生成主图 ' + MASTER + ` (${master.length} 字节, ${img.getSize().width}×${img.getSize().height})`);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const base = nativeImage.createFromBuffer(master);
  const seen = new Map();
  for (const [size, name] of SIZES) {
    const resized = seen.get(size) || base.resize({ width: size, height: size, quality: 'best' });
    seen.set(size, resized);
    fs.writeFileSync(path.join(OUT, name), resized.toPNG());
  }
  console.log('已生成 iconset：' + SIZES.length + ' 个尺寸');

  try {
    execFileSync('iconutil', ['-c', 'icns', OUT, '-o', path.join(__dirname, 'icon.icns')]);
    const st = fs.statSync(path.join(__dirname, 'icon.icns'));
    console.log('✅ 已生成 build/icon.icns (' + st.size + ' 字节)');
  } catch (err) {
    console.error('iconutil 失败：' + err.message);
    process.exitCode = 1;
  }
  app.quit();
});
