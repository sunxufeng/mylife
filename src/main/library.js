'use strict';
/**
 * My Workbench —— 资料库配置、备份 / 恢复 / Markdown 导出
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');

const { ARCHIVE_FILE, ATTACH_DIR, BACKUP_DIR } = require('./store');
const { fmtTime, fmtSlashDate, repeatDesc, buildIcs, todayStr, addDays } = require('../renderer/schedule');

const TYPE_LABEL = { text: '文字', link: '链接', image: '图片', file: '文件' };

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 默认资料库位置：~/Documents/My Workbench 资料库 */
function defaultLibraryPath() {
  return path.join(os.homedir(), 'Documents', 'My Workbench 资料库');
}

/** 旧版默认目录，改名后自动迁移（优先级：最近的 My Workbench 前身 → 最早的人生档案馆） */
function legacyLibraryPaths() {
  return [
    path.join(os.homedir(), 'Documents', 'My Life 资料库'),
    path.join(os.homedir(), 'Documents', '人生档案馆'),
  ];
}

/** 递归列出目录下所有文件（相对路径，posix 分隔符），跳过 exclude 目录名 */
async function walk(dir, root = dir, exclude = []) {
  const out = [];
  let items;
  try {
    items = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    if (exclude.includes(it.name)) continue;
    const abs = path.join(dir, it.name);
    if (it.isDirectory()) {
      out.push(...(await walk(abs, root, exclude)));
    } else if (it.isFile()) {
      out.push({
        abs,
        rel: path.relative(root, abs).split(path.sep).join('/'),
      });
    }
  }
  return out;
}

/** 一行日程摘要，导出 Markdown 时挂在对应资料下面 */
function scheduleMarkdownLine(s) {
  const bits = [`- \`${s.date}\` ${fmtTime(s)}　${s.title || '未命名日程'}`];
  if (s.location) bits.push(`@ ${s.location}`);
  const extra = [];
  if (s.done) extra.push('已完成');
  const rep = repeatDesc(s.repeat);
  if (rep) extra.push(rep);
  if (extra.length) bits.push(`（${extra.join('，')}）`);
  return bits.join(' ');
}

/** 用 Markdown 组装若干条资料 */
function buildMarkdown(
  entries,
  { title = 'My Workbench 导出', includeAttachmentList = true, schedules = [], includeSchedules = false } = {}
) {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`> 导出时间：${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}　·　共 ${entries.length} 条`);
  lines.push('');
  lines.push('---');

  entries.forEach((e, i) => {
    lines.push('');
    lines.push(`## ${i + 1}. ${e.title || '未命名资料'}`);
    lines.push('');
    const meta = [];
    meta.push(`- **类型**：${TYPE_LABEL[e.type] || e.type}`);
    if (e.date) meta.push(`- **日期**：${e.date}`);
    if (e.source) meta.push(`- **来源**：${e.source}`);
    if (e.category) meta.push(`- **分类**：${e.category}`);
    if (e.tags && e.tags.length) meta.push(`- **标签**：${e.tags.map((t) => `#${t}`).join(' ')}`);
    if (e.url) meta.push(`- **链接**：${e.url}`);
    lines.push(meta.join('\n'));
    lines.push('');
    if (e.content && e.content.trim()) {
      lines.push('### 内容');
      lines.push('');
      lines.push(e.content.trim());
      lines.push('');
    }
    if (includeAttachmentList && e.attachments && e.attachments.length) {
      lines.push('### 附件');
      lines.push('');
      for (const a of e.attachments) {
        lines.push(`- [${a.name}](${a.relPath})　（${humanSize(a.size)}）`);
      }
      lines.push('');
    }
    if (includeSchedules) {
      const related = (schedules || []).filter((s) => !s.deleted && (s.links || []).includes(e.id));
      if (related.length) {
        const sorted = related
          .slice()
          .sort((a, b) => String(a.date).localeCompare(String(b.date)));
        lines.push(`### 相关日程 · ${sorted.length}`);
        lines.push('');
        for (const s of sorted) lines.push(scheduleMarkdownLine(s));
        lines.push('');
      }
    }
    lines.push('---');
  });

  lines.push('');
  return lines.join('\n');
}

class LibraryService {
  constructor(configPath) {
    this.configPath = configPath;
  }

  readConfig() {
    try {
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch {
      return {};
    }
  }

  writeConfig(cfg) {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2), 'utf8');
  }

  /** 当前资料库路径（环境变量 > 配置 > 默认） */
  getLibraryPath() {
    if (process.env.LA_LIBRARY_PATH) return process.env.LA_LIBRARY_PATH;
    const cfg = this.readConfig();
    return cfg.libraryPath || defaultLibraryPath();
  }

  /**
   * 决定这次用哪个资料库目录。
   * 默认位置是 ~/Documents/My Workbench 资料库；如果它还不存在、而旧版「人生档案馆」目录里有数据，
   * 就把旧目录整个改名搬过来（rename 是原子操作，数据不会丢）。
   */
  async resolveLibraryPath() {
    if (process.env.LA_LIBRARY_PATH) {
      return { libraryPath: process.env.LA_LIBRARY_PATH, migratedFrom: null };
    }
    const cfg = this.readConfig();
    if (cfg.libraryPath) {
      return { libraryPath: cfg.libraryPath, migratedFrom: null };
    }
    const target = defaultLibraryPath();
    if (fs.existsSync(target)) {
      return { libraryPath: target, migratedFrom: null };
    }
    for (const legacy of legacyLibraryPaths()) {
      if (!fs.existsSync(path.join(legacy, ARCHIVE_FILE))) continue;
      try {
        await fsp.rename(legacy, target);
        return { libraryPath: target, migratedFrom: legacy };
      } catch {
        try {
          await fsp.cp(legacy, target, { recursive: true });
          return { libraryPath: target, migratedFrom: legacy + '（原目录已留一份）' };
        } catch {
          return { libraryPath: legacy, migratedFrom: null };
        }
      }
    }
    return { libraryPath: target, migratedFrom: null };
  }

  setLibraryPath(p) {
    const cfg = this.readConfig();
    cfg.libraryPath = p;
    this.writeConfig(cfg);
  }

  /** 界面偏好（主题、各栏是否收起…），和资料库位置一起放在 config.json */
  static DEFAULT_PREFS = {
    theme: 'sage',
    sidebarCollapsed: false,
    listCollapsed: false,
    mdPreview: true,
    /** 日程提醒是否同时走 macOS 通知中心 */
    notify: true,
    /** 日历视图：月视图 / 议程 */
    calView: 'month',
    /** 议程视图看多少天 */
    calRange: 30,
  };

  getPrefs() {
    const cfg = this.readConfig();
    return { ...LibraryService.DEFAULT_PREFS, ...(cfg.prefs || {}) };
  }

  setPrefs(patch) {
    const cfg = this.readConfig();
    cfg.prefs = { ...LibraryService.DEFAULT_PREFS, ...(cfg.prefs || {}), ...(patch || {}) };
    this.writeConfig(cfg);
    return cfg.prefs;
  }

  /** 飞书日历同步配置。appId/appSecret 明文存于本机 config.json（本地个人工具，未上云）；
   *  令牌（access/refresh token）由 feishu.js 加密后放在 tokens 字段。 */
  static DEFAULT_FEISHU = {
    appId: '',
    appSecret: '',
    redirectPort: 18925,
    autoSync: false,
    /** 已登录并拿到的主日历 id，缓存避免每次拉取都查一次 */
    primaryCalendarId: '',
    lastPullAt: null,
    lastPushAt: null,
    lastError: null,
    /** 加密后的令牌串（AES-256-GCM），无则未登录 */
    tokens: null,
  };

  getFeishuConfig() {
    const cfg = this.readConfig();
    return { ...LibraryService.DEFAULT_FEISHU, ...(cfg.feishu || {}) };
  }

  setFeishuConfig(patch) {
    const cfg = this.readConfig();
    const merged = { ...this.getFeishuConfig(), ...(patch || {}) };
    // 不要把已加密的 tokens 字段被部分 patch 误清空
    if (patch && 'tokens' in patch && (patch.tokens === undefined || patch.tokens === null)) {
      // 显式传 null 表示登出，允许清空；其余情况保留
    }
    cfg.feishu = merged;
    this.writeConfig(cfg);
    return merged;
  }

  // ---------- 备份 ----------

  async createBackup(zipPath, store) {
    await store.flush();
    const zip = new JSZip();
    zip.file('archive.json', JSON.stringify(store.data, null, 2));
    zip.file(
      'BACKUP-INFO.json',
      JSON.stringify(
        {
          app: 'My Workbench',
          version: 2,
          exportedAt: new Date().toISOString(),
          libraryPath: store.libraryPath,
          entries: store.data.entries.length,
          schedules: (store.data.schedules || []).length,
        },
        null,
        2
      )
    );
    // 附件（跳过 backups 目录，避免把历史备份也打包进去导致体积爆炸）
    const files = await walk(store.attachmentsPath, store.libraryPath, [BACKUP_DIR]);
    for (const f of files) {
      zip.file(f.rel, await fsp.readFile(f.abs));
    }
    const buf = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    await fsp.mkdir(path.dirname(zipPath), { recursive: true });
    await fsp.writeFile(zipPath, buf);
    return { path: zipPath, bytes: buf.length, files: files.length + 1 };
  }

  /** 校验 zip 并返回其中的 archive.json 内容 */
  async inspectBackup(zipPath) {
    const buf = await fsp.readFile(zipPath);
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files);
    if (names.some((n) => n.split('/').includes('..'))) {
      throw new Error('备份文件包含非法路径，已拒绝导入');
    }
    const entry = zip.file('archive.json');
    if (!entry) throw new Error('不是有效的备份文件：缺少 archive.json');
    const text = await entry.async('string');
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('备份里的 archive.json 无法解析：' + err.message);
    }
    if (!data || !Array.isArray(data.entries)) {
      throw new Error('备份里的 archive.json 结构不正确');
    }
    return { zip, data, files: names.length };
  }

  /**
   * 从备份恢复。会先把当前资料库内容搬到 backups/ 下的保险副本，
   * 再整体替换 archive.json 与 attachments/。
   */
  async restoreBackup(zipPath, store) {
    const { zip, data, files } = await this.inspectBackup(zipPath);
    await store.ensureDirs();

    const safetyDir = path.join(store.backupsPath, `恢复前_${stamp()}`);
    await fsp.mkdir(safetyDir, { recursive: true });
    if (fs.existsSync(store.archivePath)) {
      await fsp.copyFile(store.archivePath, path.join(safetyDir, 'archive.json'));
    }
    if (fs.existsSync(store.attachmentsPath)) {
      await fsp.cp(store.attachmentsPath, path.join(safetyDir, ATTACH_DIR), { recursive: true });
    }

    // 清空并写入新的 attachments
    await fsp.rm(store.attachmentsPath, { recursive: true, force: true });
    await fsp.mkdir(store.attachmentsPath, { recursive: true });

    let restored = 0;
    for (const name of Object.keys(zip.files)) {
      const f = zip.files[name];
      if (f.dir) continue;
      if (name === 'archive.json' || name === 'BACKUP-INFO.json') continue;
      if (!name.startsWith(ATTACH_DIR + '/')) continue;
      const target = path.join(store.libraryPath, ...name.split('/'));
      if (!store.isInsideLibrary(target)) continue;
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, await f.async('nodebuffer'));
      restored++;
    }

    await fsp.writeFile(store.archivePath, JSON.stringify(data, null, 2), 'utf8');
    await store.load();
    return {
      entries: store.data.entries.length,
      schedules: (store.data.schedules || []).length,
      attachments: restored,
      files,
      safetyDir,
    };
  }

  // ---------- Markdown 导出 ----------

  /** 导出为单个合并的 .md 文件，可选把附件也复制到 md 同级目录 */
  async exportCombined(entries, mdPath, store, { copyAttachments = false, includeSchedules = false, schedules = [] } = {}) {
    const md = buildMarkdown(entries, { includeSchedules, schedules });
    await fsp.mkdir(path.dirname(mdPath), { recursive: true });
    await fsp.writeFile(mdPath, md, 'utf8');
    let copied = 0;
    if (copyAttachments) {
      const baseDir = path.dirname(mdPath);
      for (const e of entries) {
        for (const a of e.attachments || []) {
          const src = store.absOfAttachment(a.relPath);
          if (!fs.existsSync(src)) continue;
          const dest = path.join(baseDir, ...a.relPath.split('/'));
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.copyFile(src, dest);
          copied++;
        }
      }
      // 让 md 里的相对路径成立，把 attachments 目录直接放在 md 同级
    }
    return { path: mdPath, bytes: Buffer.byteLength(md, 'utf8'), entries: entries.length, copied };
  }

  /** 每条资料单独一个 .md 文件，输出到指定目录 */
  async exportPerEntry(entries, dir, store, { copyAttachments = true, includeSchedules = false, schedules = [] } = {}) {
    await fsp.mkdir(dir, { recursive: true });
    let copied = 0;
    const used = new Set();
    for (const e of entries) {
      let base = (e.title || '未命名资料').replace(/[/\\:*?"<>|]/g, '_').slice(0, 60);
      let name = `${e.date || ''}${e.date ? '_' : ''}${base}.md`.replace(/^_/, '');
      let n = 1;
      while (used.has(name)) name = `${e.date || ''}_${base}_${++n}.md`.replace(/^_/, '');
      used.add(name);
      const md = buildMarkdown([e], {
        title: e.title || '未命名资料',
        includeSchedules,
        schedules,
      });
      await fsp.writeFile(path.join(dir, name), md, 'utf8');
      if (copyAttachments) {
        for (const a of e.attachments || []) {
          const src = store.absOfAttachment(a.relPath);
          if (!fs.existsSync(src)) continue;
          const dest = path.join(dir, ...a.relPath.split('/'));
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.copyFile(src, dest);
          copied++;
        }
      }
    }
    return { path: dir, entries: entries.length, copied };
  }

  // ---------- .ics 导出 ----------

  /**
   * 导出标准 iCalendar 文件。
   * range：'month'（当前月）/ 'next30'（今天起 30 天）/ 'all'（全部，前后各留一年）
   */
  async exportIcs(schedules, icsPath, { range = 'month', anchor } = {}) {
    const list = (schedules || []).filter((s) => !s.deleted);
    if (!list.length) throw new Error('还没有日程可以导出');
    const today = todayStr();
    const base = /^\d{4}-\d{2}-\d{2}$/.test(anchor || '') ? anchor : today;
    let from = today;
    let to = addDays(today, 365);
    if (range === 'month') {
      const d = new Date(base + 'T00:00:00');
      const first = new Date(d.getFullYear(), d.getMonth(), 1);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      const p = (n) => String(n).padStart(2, '0');
      from = `${first.getFullYear()}-${p(first.getMonth() + 1)}-01`;
      to = `${last.getFullYear()}-${p(last.getMonth() + 1)}-${p(last.getDate())}`;
    } else if (range === 'next30') {
      from = today;
      to = addDays(today, 30);
    } else {
      // 全部：以数据里最早 / 最晚的日期为界，各留一年余量
      const dates = list.map((s) => s.date).filter(Boolean).sort();
      from = dates.length ? addDays(dates[0], -365) : addDays(today, -365);
      const tails = list.map((s) => s.endDate || s.date).filter(Boolean).sort();
      to = tails.length ? addDays(tails[tails.length - 1], 365) : addDays(today, 365);
    }
    const text = buildIcs(list, { from, to });
    await fsp.mkdir(path.dirname(icsPath), { recursive: true });
    await fsp.writeFile(icsPath, text, 'utf8');
    const events = (text.match(/BEGIN:VEVENT/g) || []).length;
    return { path: icsPath, bytes: Buffer.byteLength(text, 'utf8'), events, from, to, schedules: list.length };
  }
}

module.exports = { LibraryService, buildMarkdown, defaultLibraryPath, humanSize, stamp, walk, TYPE_LABEL };
