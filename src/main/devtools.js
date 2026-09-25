'use strict';
/**
 * 开发 / 自测辅助：仅在设置了环境变量时才生效，正式使用时不加载任何东西。
 *
 *   LA_LIBRARY_PATH  指定资料库目录（避免日常测试写进真实的「文稿/My Workbench」）
 *   LA_SHOT_DIR      把界面截图写到这个目录
 *   LA_TEST_SCRIPT   指向一个模块，导出 async ({ win, app, shot }) => {} 由它驱动界面
 *   LA_TEST_EXIT=0   测试结束后不自动退出（默认退出）
 */

const fs = require('node:fs');
const path = require('node:path');

function attach(win, app) {
  const shotDir = process.env.LA_SHOT_DIR;
  const testScript = process.env.LA_TEST_SCRIPT;
  if (!shotDir && !testScript) return;

  const errors = [];
  win.webContents.on('console-message', (...args) => {
    // Electron 35+ 传 (event, details)，更早的传 (event, level, message, line, sourceId)
    const d = args[1] && typeof args[1] === 'object' ? args[1] : null;
    const level = d ? d.level : args[1];
    const message = d ? d.message : args[2];
    const source = d ? `${d.sourceId || ''}:${d.lineNumber || ''}` : `${args[4] || ''}:${args[3] || ''}`;
    const text = `[renderer:${level}] ${message}  (${source})`;
    if (String(level) === 'error' || level === 3) errors.push(text);
    console.log(text);
  });
  win.webContents.on('render-process-gone', (_e, det) => {
    console.error('[renderer] 进程异常退出：', JSON.stringify(det));
    errors.push('render-process-gone ' + JSON.stringify(det));
  });

  let n = 0;
  const shot = async (name) => {
    if (!shotDir) return;
    fs.mkdirSync(shotDir, { recursive: true });
    await new Promise((r) => setTimeout(r, 450));
    const img = await win.webContents.capturePage();
    const file = path.join(shotDir, `${String(++n).padStart(2, '0')}-${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    console.log('[shot] ' + file);
  };

  win.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 900));
    try {
      if (testScript) {
        const mod = require(path.resolve(testScript));
        await mod({ win, app, shot, errors });
      } else {
        await shot('初始界面');
      }
      console.log(errors.length ? `\n[renderer] 共 ${errors.length} 条错误` : '\n[renderer] 无错误');
    } catch (err) {
      console.error('[test] 执行失败：', err);
      process.exitCode = 1;
    } finally {
      if (process.env.LA_TEST_EXIT !== '0') {
        setTimeout(() => app.quit(), 300);
      }
    }
  });
}

module.exports = { attach };
