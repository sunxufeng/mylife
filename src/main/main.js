'use strict';
/**
 * My Workbench —— Electron 主进程
 * 负责：窗口、数据读写、附件复制、导出、备份恢复、自定义 archive:// 协议
 */

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
  protocol,
  net,
  clipboard,
  nativeImage,
  Notification,
} = require('electron');

const { ArchiveStore, uid } = require('./store');
const { LibraryService, defaultLibraryPath } = require('./library');
const { FeishuClient } = require('./feishu');
const { pullFromFeishu, pushToFeishu } = require('./sync');
const {
  occurrencesOn,
  occurrencesInRange,
  remindAt,
  fmtTime,
  todayStr,
  addDays,
  parseDate,
} = require('../renderer/schedule');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'archive',
    privileges: { secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

app.setName('My Workbench');

/** @type {BrowserWindow|null} */
let win = null;
/** @type {ArchiveStore|null} */
let store = null;
/** @type {LibraryService|null} */
let lib = null;
/** @type {FeishuClient|null} */
let feishu = null;
/** 这次启动是否把旧版「人生档案馆」目录改名迁移过来了 */
let migratedFrom = null;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

/**
 * 改名迁移：把旧配置目录 ~/Library/Application Support/My Life 迁到 My Workbench。
 * 必须在 app.setName 之后、首次读取 config 之前调用，保证偏好与飞书凭证不丢。
 */
function migrateConfigDir() {
  const oldDir = path.join(app.getPath('home'), 'Library', 'Application Support', 'My Life');
  const newDir = app.getPath('userData');
  if (oldDir === newDir) return;
  try {
    if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
      fs.mkdirSync(path.dirname(newDir), { recursive: true });
      fs.renameSync(oldDir, newDir);
    } else if (fs.existsSync(oldDir) && fs.existsSync(newDir)) {
      // 新目录可能已被 Electron 自动建为空目录，仅把旧 config.json 合并过来
      const oldCfg = path.join(oldDir, 'config.json');
      const newCfg = path.join(newDir, 'config.json');
      if (fs.existsSync(oldCfg) && !fs.existsSync(newCfg)) {
        fs.copyFileSync(oldCfg, newCfg);
      }
    }
  } catch (e) {
    console.error('配置目录迁移失败（可忽略，下次启动会重试）：', e && e.message);
  }
}

async function initStore() {
  const resolved = await lib.resolveLibraryPath();
  migratedFrom = resolved.migratedFrom || null;
  store = new ArchiveStore(resolved.libraryPath);
  await store.load();
  return store;
}

function snapshot() {
  return {
    ok: true,
    libraryPath: store.libraryPath,
    entries: store.data.entries,
    schedules: store.data.schedules || [],
    stats: store.stats(),
    prefs: lib.getPrefs(),
    migratedFrom,
    today: todayStr(),
    appInfo: {
      version: app.getVersion(),
      name: app.getName(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      defaultLibraryPath: defaultLibraryPath(),
      userData: app.getPath('userData'),
    },
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: '#F6F2EA',
    title: 'My Workbench',
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // 外链一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => {
    win = null;
  });

  require('./devtools').attach(win, app);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (channel, payload) => () => win && win.webContents.send(channel, payload);
  const template = [
    ...(isMac
      ? [
          {
            label: 'My Workbench',
            submenu: [
              { role: 'about', label: '关于 My Workbench' },
              { type: 'separator' },
              { label: '设置…', accelerator: 'CmdOrCtrl+,', click: send('menu:settings') },
              { type: 'separator' },
              { role: 'hide', label: '隐藏 My Workbench' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              { role: 'quit', label: '退出 My Workbench' },
            ],
          },
        ]
      : []),
    {
      label: '文件',
      submenu: [
        { label: '新建资料', accelerator: 'CmdOrCtrl+N', click: send('menu:new') },
        { label: '新建日程', accelerator: 'CmdOrCtrl+Shift+N', click: send('menu:new-schedule') },
        { label: '保存当前编辑', accelerator: 'CmdOrCtrl+S', click: send('menu:save') },
        { type: 'separator' },
        { label: '立即备份到资料库', accelerator: 'CmdOrCtrl+B', click: send('menu:backup') },
        { label: '备份到其他位置…', click: send('menu:backup-as') },
        { label: '从备份恢复…', click: send('menu:restore') },
        { type: 'separator' },
        { label: '导出日程（.ics）…', click: send('menu:export-ics') },
        { type: 'separator' },
        { label: '打开资料库目录', accelerator: 'CmdOrCtrl+Shift+O', click: () => shell.openPath(store.libraryPath) },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '搜索', accelerator: 'CmdOrCtrl+F', click: send('menu:search') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { label: '日历', accelerator: 'CmdOrCtrl+3', click: send('menu:calendar') },
        { label: '全部资料', accelerator: 'CmdOrCtrl+4', click: send('menu:all') },
        { type: 'separator' },
        { label: '收起 / 展开分类栏', accelerator: 'CmdOrCtrl+1', click: send('menu:toggle-side') },
        { label: '收起 / 展开列表栏', accelerator: 'CmdOrCtrl+2', click: send('menu:toggle-list') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '使用说明',
          click: () => win && win.webContents.send('menu:help'),
        },
        {
          label: '关于数据存放位置',
          click: () =>
            dialog.showMessageBox(win, {
              type: 'info',
              title: '数据存放位置',
              message: '你的资料全部保存在本机，不联网。',
              detail:
                `资料库目录：\n${store.libraryPath}\n\n` +
                `· archive.json —— 全部文字资料与日程\n` +
                `· attachments/ —— 附件副本\n` +
                `· backups/ —— 备份与恢复保险副本\n\n` +
                `配置与偏好：\n${app.getPath('userData')}`,
              buttons: ['好'],
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/** 统一包裹：把异常转成 { ok:false, error } 交给渲染进程展示 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_evt, ...args) => {
    try {
      const result = await fn(...args);
      return result && typeof result === 'object' ? { ok: true, ...result } : { ok: true, result };
    } catch (err) {
      console.error(`[IPC ${channel}]`, err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

function registerIpc() {
  handle('app:snapshot', async () => snapshot());

  // ---- 资料库位置 ----
  handle('library:open', async () => {
    await shell.openPath(store.libraryPath);
    return {};
  });
  handle('library:open-path', async (p) => {
    await shell.openPath(p);
    return {};
  });
  handle('library:reveal', async (p) => {
    shell.showItemInFolder(p);
    return {};
  });
  handle('library:change', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择资料库目录',
      message: '选择一个目录作为新的资料库（会在其中创建 archive.json 与 attachments）',
      defaultPath: store.libraryPath,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '使用这个目录',
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const target = res.filePaths[0];
    lib.setLibraryPath(target);
    await initStore();
    return { ...snapshot(), changed: true };
  });

  // ---- 界面偏好（主题、各栏收起状态…）----
  handle('prefs:get', async () => ({ prefs: lib.getPrefs() }));
  handle('prefs:set', async (patch) => ({ prefs: lib.setPrefs(patch) }));

  // ---- 资料 CRUD ----
  handle('entry:create', async (payload) => {
    const entry = await store.create(payload || {});
    if (payload && payload.id && payload.id !== entry.id) {
      // 理论上不会发生，保险处理
    }
    return { entry, stats: store.stats(), ...snapshotEntries() };
  });
  handle('entry:update', async (id, patch) => {
    const entry = await store.update(id, patch || {});
    return { entry, stats: store.stats(), ...snapshotEntries() };
  });
  handle('entry:trash', async (ids) => {
    const n = await store.trash(ids);
    return { count: n, stats: store.stats(), ...snapshotEntries() };
  });
  handle('entry:restore', async (ids) => {
    const n = await store.restore(ids);
    return { count: n, stats: store.stats(), ...snapshotEntries() };
  });
  handle('entry:delete-forever', async (ids) => {
    const n = await store.removeForever(ids);
    return { count: n, stats: store.stats(), ...snapshotEntries() };
  });
  handle('entry:empty-trash', async () => {
    const n = await store.emptyTrash();
    return { count: n, stats: store.stats(), ...snapshotEntries() };
  });

  // ---- 草稿（新建但还没保存时的附件暂存目录） ----
  handle('draft:new-id', async () => ({ id: uid('e') }));
  handle('draft:discard', async (id) => {
    const exists = store.get(id);
    if (!exists) {
      await fsp.rm(path.join(store.attachmentsPath, id), { recursive: true, force: true }).catch(() => {});
    }
    return {};
  });

  // ---- 分类 ----
  handle('category:add', async (name) => {
    const categories = await store.addCategory(name);
    return { categories, stats: store.stats() };
  });
  handle('category:rename', async (from, to) => {
    const categories = await store.renameCategory(from, to);
    return { categories, stats: store.stats(), ...snapshotEntries() };
  });
  handle('category:remove', async (name) => {
    const categories = await store.removeCategory(name);
    return { categories, stats: store.stats(), ...snapshotEntries() };
  });

  // ---- 日程 CRUD ----
  handle('schedule:create', async (payload) => {
    const schedule = await store.createSchedule(payload || {});
    return { schedule, stats: store.stats(), ...snapshotEntries() };
  });
  handle('schedule:update', async (id, patch) => {
    const schedule = await store.updateSchedule(id, patch || {});
    return { schedule, stats: store.stats(), ...snapshotEntries() };
  });
  handle('schedule:trash', async (ids) => {
    const count = await store.trashSchedules(ids);
    return { count, stats: store.stats(), ...snapshotEntries() };
  });
  handle('schedule:restore', async (ids) => {
    const count = await store.restoreSchedules(ids);
    return { count, stats: store.stats(), ...snapshotEntries() };
  });
  handle('schedule:delete-forever', async (ids) => {
    const count = await store.removeSchedulesForever(ids);
    return { count, stats: store.stats(), ...snapshotEntries() };
  });

  /**
   * 「只改这一次」：把重复日程的某一次拆成独立日程，
   * 并在原日程的 repeat.skip 里把那天排除掉，避免出现两次。
   */
  handle('schedule:split', async (id, dateStr) => {
    const src = store.getSchedule(id);
    if (!src) throw new Error('日程不存在：' + id);
    const { splitPayload, repeatWithout } = require('../renderer/schedule');
    const created = await store.createSchedule(splitPayload(src, dateStr));
    await store.updateSchedule(id, { repeat: repeatWithout(src.repeat, dateStr) });
    return { schedule: created, stats: store.stats(), ...snapshotEntries() };
  });

  handle('schedule:export-ics', async (options = {}) => {
    const range = ['month', 'next30', 'all'].includes(options.range) ? options.range : 'month';
    const label = { month: '当前月', next30: '未来 30 天', all: '全部' }[range];
    const tag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const res = await dialog.showSaveDialog(win, {
      title: `导出日程（${label}）`,
      defaultPath: path.join(app.getPath('documents'), `My Workbench 日程_${tag}.ics`),
      filters: [{ name: 'iCalendar', extensions: ['ics'] }],
      buttonLabel: '导出',
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    const out = await lib.exportIcs(store.data.schedules || [], res.filePath, {
      range,
      anchor: options.anchor,
    });
    return { ...out, range };
  });

  // ---- 飞书日历同步 ----
  handle('feishu:config', async () => ({ config: feishu.status() }));

  handle('feishu:save-config', async (patch) => {
    const cur = feishu.config();
    const merged = { ...(patch || {}) };
    // 密钥输入框留空时不覆盖已保存的 secret；端口给默认值
    if (merged.appSecret === '' || merged.appSecret == null) merged.appSecret = cur.appSecret;
    if (!merged.redirectPort) merged.redirectPort = cur.redirectPort || 18925;
    feishu.saveConfig(merged);
    return { config: feishu.status() };
  });

  handle('feishu:login', async () => {
    const r = await feishu.login();
    return { ...r, config: feishu.status() };
  });

  handle('feishu:logout', async () => {
    await feishu.logout();
    return { config: feishu.status() };
  });

  handle('feishu:pull', async () => {
    const r = await pullFromFeishu(store, feishu);
    sendFeishuResult(r, 'pull', false);
    return { ...r, config: feishu.status(), stats: store.stats(), ...snapshotEntries() };
  });

  handle('feishu:push', async () => {
    const r = await pushToFeishu(store, feishu);
    sendFeishuResult(r, 'push', false);
    return { ...r, config: feishu.status(), stats: store.stats(), ...snapshotEntries() };
  });

  handle('feishu:status', async () => ({ config: feishu.status() }));

  // ---- 附件 ----
  handle('attachment:add-paths', async (entryId, paths) => {
    const added = [];
    for (const p of paths || []) {
      try {
        added.push(await store.addAttachmentFromPath(entryId, p));
      } catch (err) {
        console.error('附件复制失败', p, err.message);
      }
    }
    return { added };
  });
  handle('attachment:add-buffer', async (entryId, arrayBuffer, filename) => {
    const buf = Buffer.from(arrayBuffer);
    const a = await store.addAttachmentFromBuffer(entryId, buf, filename || `粘贴图片_${Date.now()}.png`);
    return { added: [a] };
  });
  handle('attachment:cleanup', async (relPaths) => {
    for (const rel of relPaths || []) {
      await store.removeAttachmentFile(rel);
    }
    return {};
  });
  handle('attachment:open', async (relPath) => {
    const abs = store.absOfAttachment(relPath);
    if (!fs.existsSync(abs)) throw new Error('附件文件已不存在：' + relPath);
    const err = await shell.openPath(abs);
    if (err) throw new Error(err);
    return {};
  });
  handle('attachment:reveal', async (relPath) => {
    const abs = store.absOfAttachment(relPath);
    if (!fs.existsSync(abs)) throw new Error('附件文件已不存在：' + relPath);
    shell.showItemInFolder(abs);
    return {};
  });
  handle('attachment:save-as', async (relPath, suggestedName) => {
    const abs = store.absOfAttachment(relPath);
    if (!fs.existsSync(abs)) throw new Error('附件文件已不存在');
    const res = await dialog.showSaveDialog(win, {
      title: '另存附件',
      defaultPath: path.join(app.getPath('downloads'), suggestedName || path.basename(abs)),
      buttonLabel: '保存',
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    await fsp.copyFile(abs, res.filePath);
    return { path: res.filePath };
  });

  // ---- 文件选择 ----
  handle('dialog:pick', async (kind) => {
    const filters =
      kind === 'image'
        ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'svg'] }]
        : [{ name: '所有文件', extensions: ['*'] }];
    const res = await dialog.showOpenDialog(win, {
      title: kind === 'image' ? '选择图片' : '选择文件',
      properties: ['openFile', 'multiSelections'],
      filters,
      buttonLabel: '添加到资料库',
    });
    if (res.canceled) return { canceled: true, paths: [] };
    return { paths: res.filePaths };
  });

  handle('clipboard:image', async () => {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return { empty: true };
    return { empty: false, png: img.toPNG().buffer };
  });

  handle('clipboard:write-text', async (text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return {};
  });

  handle('shell:open-external', async (url) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http / https 链接');
    await shell.openExternal(url);
    return {};
  });

  // ---- 导出 Markdown ----
  handle('export:markdown', async (ids, options = {}) => {
    const entries = (ids || []).map((id) => store.get(id)).filter(Boolean);
    if (!entries.length) throw new Error('请先勾选要导出的资料');
    const mode = options.mode === 'perEntry' ? 'perEntry' : 'combined';
    const copyAttachments = !!options.copyAttachments;
    const includeSchedules = !!options.includeSchedules;
    const schedules = includeSchedules ? store.data.schedules || [] : [];
    const tag = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    if (mode === 'combined') {
      const res = await dialog.showSaveDialog(win, {
        title: '导出为 Markdown',
        defaultPath: path.join(app.getPath('documents'), `My Workbench 导出_${tag}.md`),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        buttonLabel: '导出',
      });
      if (res.canceled || !res.filePath) return { canceled: true };
      const out = await lib.exportCombined(entries, res.filePath, store, {
        copyAttachments,
        includeSchedules,
        schedules,
      });
      return { ...out, mode };
    }

    const res = await dialog.showOpenDialog(win, {
      title: '选择导出目录（每条资料一个 .md）',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '导出到这里',
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const dir = path.join(res.filePaths[0], `My Workbench 导出_${tag}`);
    const out = await lib.exportPerEntry(entries, dir, store, {
      copyAttachments,
      includeSchedules,
      schedules,
    });
    return { ...out, mode };
  });

  /** 预览：把选中资料的 Markdown 文本返回，供界面里"预览"用 */
  handle('export:preview', async (ids, options = {}) => {
    const { buildMarkdown } = require('./library');
    const entries = (ids || []).map((id) => store.get(id)).filter(Boolean);
    return {
      markdown: buildMarkdown(entries, {
        includeSchedules: !!options.includeSchedules,
        schedules: options.includeSchedules ? store.data.schedules || [] : [],
      }),
    };
  });

  // ---- 备份 / 恢复 ----
  const backupFileName = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `My Workbench 备份_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.zip`;
  };

  /** 一键备份：直接写进资料库的 backups/ 目录，不弹框 */
  handle('backup:create-in-library', async () => {
    const target = path.join(store.backupsPath, backupFileName());
    const info = await lib.createBackup(target, store);
    return { ...info, relative: path.relative(store.libraryPath, info.path), stats: store.stats() };
  });

  handle('backup:create', async (targetPath) => {
    let out = targetPath;
    if (!out) {
      const res = await dialog.showSaveDialog(win, {
        title: '备份到其他位置',
        defaultPath: path.join(app.getPath('documents'), backupFileName()),
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
        buttonLabel: '开始备份',
      });
      if (res.canceled || !res.filePath) return { canceled: true };
      out = res.filePath;
    }
    const info = await lib.createBackup(out, store);
    return { ...info, stats: store.stats() };
  });

  handle('backup:inspect', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择备份文件（.zip）',
      defaultPath: app.getPath('documents'),
      properties: ['openFile'],
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      buttonLabel: '查看',
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const p = res.filePaths[0];
    const { data, files } = await lib.inspectBackup(p);
    return {
      path: p,
      files,
      entries: data.entries.length,
      active: data.entries.filter((e) => !e.deleted).length,
      schedules: (data.schedules || []).length,
      createdAt: data.createdAt,
      categories: data.categories || [],
    };
  });

  /** 直接检查某个备份文件（不再弹选择框），供设置面板里「用这个恢复」使用 */
  handle('backup:inspect-path', async (zipPath) => {
    const { data, files } = await lib.inspectBackup(zipPath);
    return {
      path: zipPath,
      files,
      entries: data.entries.length,
      active: data.entries.filter((e) => !e.deleted).length,
      schedules: (data.schedules || []).length,
      createdAt: data.createdAt,
      categories: data.categories || [],
    };
  });

  handle('backup:restore', async (zipPath) => {
    let p = zipPath;
    if (!p) {
      const res = await dialog.showOpenDialog(win, {
        title: '选择要恢复的备份文件（.zip）',
        defaultPath: app.getPath('documents'),
        properties: ['openFile'],
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
        buttonLabel: '下一步',
      });
      if (res.canceled || !res.filePaths.length) return { canceled: true };
      p = res.filePaths[0];
    }
    // 二次确认由界面里的恢复弹窗负责（会展示备份内容与将被替换的现状）
    const info = await lib.restoreBackup(p, store);
    return { ...info, ...snapshotEntries(), stats: store.stats() };
  });

  handle('backup:list', async () => {
    const dir = store.backupsPath;
    let items = [];
    try {
      const names = await fsp.readdir(dir);
      for (const n of names) {
        const abs = path.join(dir, n);
        const st = await fsp.stat(abs);
        items.push({ name: n, path: abs, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs });
      }
    } catch {
      items = [];
    }
    items.sort((a, b) => b.mtime - a.mtime);
    return { items: items.slice(0, 20), dir };
  });
}

/** 只回传轻量数据，避免每次操作都发全量（附件本体从来不走 IPC） */
function snapshotEntries() {
  return { entries: store.data.entries, schedules: store.data.schedules || [] };
}

// ---------------------------------------------------------------------------
// 日程提醒
// 说清楚能做到什么程度：只在应用运行期间检查。应用没开就不会提醒，
// 这是本地离线应用的物理限制，不做后台常驻、不装 LaunchAgent。
// ---------------------------------------------------------------------------

/** 已经提醒过的 key（scheduleId@日期），只活在这次运行里 */
const notifiedKeys = new Set();

function collectDue(now) {
  if (!store) return [];
  const today = todayStr(now);
  // 只看今天与明天，覆盖「提前 1 天提醒」的场景
  const occs = occurrencesInRange(store.data.schedules || [], today, addDays(today, 1));
  const due = [];
  for (const o of occs) {
    if (o.schedule.done) continue;
    const at = remindAt(o.schedule, o.startDate);
    if (!at) continue;
    const key = `${o.key}#${o.schedule.remind}`;
    if (notifiedKeys.has(key)) continue;
    const late = (now.getTime() - at.getTime()) / 60000;
    if (late < 0) continue; // 还没到点
    if (late > 720) continue; // 睡了太久（比如合盖一夜），不补弹一屏
    notifiedKeys.add(key);
    due.push({
      key: o.key,
      id: o.schedule.id,
      title: o.schedule.title,
      date: o.startDate,
      time: fmtTime(o.schedule),
      location: o.schedule.location || '',
      allDay: !!o.schedule.allDay,
      remind: o.schedule.remind,
      late: Math.round(late),
    });
  }
  return due.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

function checkReminders() {
  if (!win || win.isDestroyed()) return;
  const due = collectDue(new Date());
  if (!due.length) return;
  win.webContents.send('reminder:fire', { items: due });
  if (lib.getPrefs().notify && Notification.isSupported()) {
    for (const item of due.slice(0, 3)) {
      const n = new Notification({
        title: item.title,
        body: `${item.date} ${item.time}${item.location ? '　·　' + item.location : ''}`,
        silent: false,
      });
      n.on('click', () => {
        if (!win || win.isDestroyed()) return;
        win.show();
        win.webContents.send('reminder:focus', { id: item.id, date: item.date });
      });
      n.show();
    }
  }
}

/** 刚打开应用时，把今天还没提醒过的日程汇总提示一次（不占用正式提醒名额） */
function sendTodaySummary() {
  if (!win || win.isDestroyed() || !store) return;
  const now = new Date();
  const today = todayStr(now);
  const occs = occurrencesInRange(store.data.schedules || [], today, today);
  const items = [];
  const seen = new Set();
  for (const o of occs) {
    if (o.schedule.done) continue;
    if (o.schedule.remind == null) continue;
    if (seen.has(o.key)) continue;
    const at = remindAt(o.schedule, o.startDate);
    if (!at) continue;
    // 只提示「还没过太久」的（结束时间之后 2 小时内还值得看一眼）
    if (now.getTime() - at.getTime() < -24 * 3600 * 1000) continue;
    seen.add(o.key);
    items.push({
      key: o.key,
      id: o.schedule.id,
      title: o.schedule.title,
      date: o.startDate,
      time: fmtTime(o.schedule),
      location: o.schedule.location || '',
      allDay: !!o.schedule.allDay,
      remind: o.schedule.remind,
    });
  }
  if (!items.length) return;
  win.webContents.send('reminder:summary', { items });
}

let reminderTimer = null;

function startReminderLoop() {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = setInterval(checkReminders, 30000);
  setTimeout(checkReminders, 2500);
  setTimeout(sendTodaySummary, 3500);
}

// ---------------------------------------------------------------------------
// 飞书日历同步
// ---------------------------------------------------------------------------

/** 把同步结果推给渲染进程（用于 toast / 状态刷新） */
function sendFeishuResult(result, kind, silent) {
  if (!win || win.isDestroyed()) return;
  // 同时把最新数据快照带过去，渲染端无论走 IPC 返回值还是事件都能刷新界面
  win.webContents.send('feishu:sync-result', {
    kind,
    silent,
    stats: store.stats(),
    ...snapshotEntries(),
    ...result,
  });
}

let feishuAutoTimer = null;

/** 开启/重启自动同步：启动后先拉一次，之后每 30 分钟拉一次（仅当已开启且已登录） */
function startFeishuAutoSync() {
  if (feishuAutoTimer) clearInterval(feishuAutoTimer);
  const tick = async () => {
    try {
      const st = feishu.status();
      if (!st.autoSync || !st.loggedIn) return;
      const r = await pullFromFeishu(store, feishu);
      sendFeishuResult(r, 'pull', true);
    } catch (e) {
      feishu.saveConfig({ lastError: e.message });
    }
  };
  feishuAutoTimer = setInterval(tick, 30 * 60 * 1000);
  setTimeout(tick, 8000);
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  migrateConfigDir();
  lib = new LibraryService(configPath());
  try {
    await initStore();
  } catch (err) {
    dialog.showErrorBox('资料库初始化失败', String(err && err.message ? err.message : err));
    app.quit();
    return;
  }
  feishu = new FeishuClient(lib);

  // archive:// 只读服务资料库目录内的文件
  protocol.handle('archive', async (request) => {
    try {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      if (!rel) return new Response('Not found', { status: 404 });
      const abs = path.resolve(store.libraryPath, ...rel.split('/'));
      if (!store.isInsideLibrary(abs)) return new Response('Forbidden', { status: 403 });
      if (!fs.existsSync(abs)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(abs).toString());
    } catch (err) {
      return new Response('Error: ' + err.message, { status: 500 });
    }
  });

  buildMenu();
  registerIpc();
  createWindow();
  startReminderLoop();
  startFeishuAutoSync();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (reminderTimer) clearInterval(reminderTimer);
  if (store) {
    try {
      fs.writeFileSync(store.archivePath, JSON.stringify(store.data, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
  }
});
