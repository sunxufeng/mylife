'use strict';
/**
 * 打包后应用的启动与持久化验证。
 * 用法（连着跑两次，第二次能读到第一次写的资料，就说明重启后数据仍在）：
 *
 *   LA_LIBRARY_PATH=/tmp/la-pkg LA_RUN_LABEL=A LA_TEST_SCRIPT=<abs>/scripts/ui-verify.js \
 *     <abs>/dist/人生档案馆-darwin-arm64/人生档案馆.app/Contents/MacOS/人生档案馆
 */

const log = (...a) => console.log('[verify]', ...a);

module.exports = async function ({ win, shot, errors }) {
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const label = process.env.LA_RUN_LABEL || 'X';

  const info = await run(`({
    资料库: state.libraryPath,
    应用版本: state.appInfo.version,
    Electron: state.appInfo.electron,
    Node: state.appInfo.node,
    在库条数: state.stats.total,
    回收站: state.stats.trashed,
    分类: state.stats.categories,
  })`);
  log('启动快照：' + JSON.stringify(info));

  const titles = await run(`state.entries.filter(e=>!e.deleted).map(e=>e.title).sort()`);
  log('本次读到的资料：' + JSON.stringify(titles));

  const written = await run(`(async () => {
    const r = await api.createEntry({
      type: 'text',
      title: '打包后写入测试 ${label}',
      content: '由打包好的 .app 写入，用来验证重启后仍能读到。',
      category: '经历',
      tags: ['验证', '${label}'],
    });
    if (!r.ok) return r;
    const s = await api.snapshot();
    applySnapshot(s);
    renderAll();
    return { 条数: state.stats.total };
  })()`);
  log('写入一条后：' + JSON.stringify(written));

  await shot('打包应用-列表');

  const roundTrip = await run(`(async () => {
    const s = await api.snapshot();
    applySnapshot(s);
    return state.entries.filter(e => e.title.startsWith('打包后写入测试')).map(e => e.title);
  })()`);
  log('库里累计的写入测试条目：' + JSON.stringify(roundTrip));

  // 再打开一次附件目录，确认打包后仍然指向独立目录
  const libPath = await run('state.libraryPath');
  log('资料库目录 = ' + libPath);

  if (errors.length) log('⚠ 渲染进程错误 ' + errors.length + ' 条');
  else log('渲染进程无错误');
};
