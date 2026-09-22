'use strict';
/**
 * My Life —— 数据层
 * 全部数据存放在「资料库目录」下的单个 JSON 文件 archive.json 中，
 * 资料库目录独立于安装目录，重装/移动应用不影响数据。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ARCHIVE_VERSION = 1;
const ARCHIVE_FILE = 'archive.json';
const ATTACH_DIR = 'attachments';
const BACKUP_DIR = 'backups';

const DEFAULT_CATEGORIES = ['经历', '工作资料', '阅读笔记', '灵感'];
const VALID_TYPES = ['text', 'link', 'image', 'file'];

function uid(prefix = '') {
  return prefix + crypto.randomBytes(9).toString('hex');
}

/** 本地日期 YYYY-MM-DD */
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function nowIso() {
  return new Date().toISOString();
}

/** 去掉文件名里对文件系统不友好的字符 */
function safeName(name) {
  const base = String(name || 'file')
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return (base || 'file').slice(0, 120);
}

class ArchiveStore {
  /** @param {string} libraryPath 资料库根目录 */
  constructor(libraryPath) {
    this.libraryPath = libraryPath;
    this.data = null;
    this._writing = Promise.resolve();
  }

  get archivePath() {
    return path.join(this.libraryPath, ARCHIVE_FILE);
  }
  get attachmentsPath() {
    return path.join(this.libraryPath, ATTACH_DIR);
  }
  get backupsPath() {
    return path.join(this.libraryPath, BACKUP_DIR);
  }

  emptyData() {
    return {
      version: ARCHIVE_VERSION,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      categories: [...DEFAULT_CATEGORIES],
      entries: [],
    };
  }

  /** 确保资料库目录结构存在 */
  async ensureDirs() {
    await fsp.mkdir(this.libraryPath, { recursive: true });
    await fsp.mkdir(this.attachmentsPath, { recursive: true });
    await fsp.mkdir(this.backupsPath, { recursive: true });
  }

  async load() {
    await this.ensureDirs();
    // 清掉上次写到一半留下的临时文件（它从来不是权威数据）
    await fsp.rm(this.archivePath + '.tmp', { force: true }).catch(() => {});
    if (!fs.existsSync(this.archivePath)) {
      this.data = this.emptyData();
      this.seedWelcome();
      await this.flush();
      return this.data;
    }
    let raw;
    try {
      raw = await fsp.readFile(this.archivePath, 'utf8');
    } catch (err) {
      throw new Error('读取 archive.json 失败：' + err.message);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // 尝试从 .bak 恢复
      const bak = this.archivePath + '.bak';
      if (fs.existsSync(bak)) {
        parsed = JSON.parse(await fsp.readFile(bak, 'utf8'));
        await fsp.copyFile(this.archivePath, this.archivePath + '.corrupt.' + Date.now());
      } else {
        throw new Error('archive.json 内容损坏且没有可用的 .bak 备份：' + err.message);
      }
    }
    this.data = this.normalize(parsed);
    // 从旧版「人生档案馆」迁移过来时，把遗留的使用说明也更新成当前版本
    if (this.upgradeLegacyWelcome()) await this.flush();
    return this.data;
  }

  normalize(data) {
    const base = this.emptyData();
    const out = { ...base, ...(data || {}) };
    out.version = ARCHIVE_VERSION;
    if (!Array.isArray(out.categories) || !out.categories.length) {
      out.categories = [...DEFAULT_CATEGORIES];
    }
    out.categories = out.categories.map((c) => String(c).trim()).filter(Boolean);
    if (!Array.isArray(out.entries)) out.entries = [];
    out.entries = out.entries.map((e) => this.normalizeEntry(e)).filter(Boolean);
    return out;
  }

  normalizeEntry(e) {
    if (!e || typeof e !== 'object') return null;
    const type = VALID_TYPES.includes(e.type) ? e.type : 'text';
    const attachments = Array.isArray(e.attachments)
      ? e.attachments
          .filter((a) => a && a.relPath)
          .map((a) => ({
            id: a.id || uid('a'),
            name: String(a.name || path.basename(a.relPath)),
            relPath: String(a.relPath),
            size: Number(a.size) || 0,
            ext: String(a.ext || path.extname(a.relPath).replace('.', '')).toLowerCase(),
            isImage: !!a.isImage,
            addedAt: a.addedAt || nowIso(),
          }))
      : [];
    return {
      id: String(e.id || uid('e')),
      type,
      title: String(e.title || '').trim() || '未命名资料',
      content: typeof e.content === 'string' ? e.content : '',
      format: e.format === 'markdown' ? 'markdown' : 'plain',
      url: typeof e.url === 'string' ? e.url : '',
      source: typeof e.source === 'string' ? e.source : '',
      date: /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? e.date : today(),
      category: typeof e.category === 'string' ? e.category : '',
      tags: Array.isArray(e.tags)
        ? [...new Set(e.tags.map((t) => String(t).trim()).filter(Boolean))]
        : [],
      attachments,
      createdAt: e.createdAt || nowIso(),
      updatedAt: e.updatedAt || e.createdAt || nowIso(),
      deleted: !!e.deleted,
      deletedAt: e.deleted ? e.deletedAt || nowIso() : null,
    };
  }

  /** 使用说明的内容（首次启动插入；旧版遗留的说明条目也会更新成这一份） */
  welcomePayload() {
    return {
      type: 'text',
      title: '欢迎使用 My Life',
      format: 'markdown',
      content: [
        '这里是你的私人资料库，所有内容都保存在本机，**完全离线**，不联网、不需要账号。',
        '',
        '## 怎么开始',
        '',
        '1. 点左上角「＋ 新建资料」，可以存文字、链接、图片或任意文件',
        '2. 图片和文件会**复制一份**进资料库的 attachments 目录，你原来的文件保持不动',
        '3. 在列表上方的搜索框里输入关键词，标题、正文、来源、标签、附件名都能搜到',
        '4. 勾选若干条后点「导出 Markdown」，就能一次性交给 AI 阅读',
        '5. 删掉的资料会先进回收站，随时可以还原',
        '',
        '## 这条是怎么写出来的',
        '',
        '在编辑区把右上角的「纯文本 / Markdown」切到 Markdown，就会出现工具栏和实时预览。',
        '',
        '> 支持标题、**粗体**、*斜体*、`行内代码`、引用、列表、分割线和表格。',
        '',
        '| 想做的事 | 怎么做 |',
        '| --- | --- |',
        '| 换配色 | 左下角「设置」里选配色主题 |',
        '| 屏幕不够宽 | 点左栏和列表栏顶部的「«」把它们收起来 |',
        '| 专心写字 | 编辑器工具栏上的「专注」按钮 |',
        '| 备份与恢复 | 「设置」里的备份与恢复 |',
        '',
        '## 数据存在哪',
        '',
        '默认在「文稿 / My Life 资料库」：',
        '',
        '- archive.json —— 全部文字资料',
        '- attachments/ —— 附件的副本',
        '- backups/ —— 备份与保险副本',
        '',
        '这个目录**独立于应用安装位置**，重装或移动 app 都不影响数据。换电脑时把备份 zip 拷过去恢复即可。',
        '',
        '---',
        '',
        '这一条只是使用说明，不需要了可以直接删掉。',
      ].join('\n'),
      url: '',
      source: 'My Life',
      date: today(),
      category: '',
      tags: ['使用说明'],
      attachments: [],
    };
  }

  /** 首次使用时放入一条使用说明，方便上手（可随时删除） */
  seedWelcome() {
    this.data.entries.unshift({
      id: uid('e'),
      ...this.welcomePayload(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deleted: false,
      deletedAt: null,
    });
  }

  /**
   * 跟着改名一起，把旧版遗留的使用说明更新成当前文案。
   * 只在标题仍然一字不差是「欢迎使用人生档案馆」、且带「使用说明」标签时替换，
   * 你自己改过标题或删过标签的条目不会被碰。
   */
  upgradeLegacyWelcome() {
    const hit = this.data.entries.find(
      (e) => !e.deleted && e.title === '欢迎使用人生档案馆' && (e.tags || []).includes('使用说明')
    );
    if (!hit) return false;
    Object.assign(hit, this.welcomePayload(), { updatedAt: nowIso() });
    return true;
  }

  /** 原子写入：先写临时文件再 rename，同时留一份 .bak */
  async flush() {
    const run = async () => {
      this.data.updatedAt = nowIso();
      const tmp = this.archivePath + '.tmp';
      const json = JSON.stringify(this.data, null, 2);
      await fsp.writeFile(tmp, json, 'utf8');
      if (fs.existsSync(this.archivePath)) {
        try {
          await fsp.copyFile(this.archivePath, this.archivePath + '.bak');
        } catch {
          /* .bak 失败不阻断主流程 */
        }
      }
      try {
        await fsp.rename(tmp, this.archivePath);
      } catch (err) {
        // 极少数环境（同步网盘、安全软件、受限沙箱）不允许 rename 覆盖已有文件，
        // 退化成直接覆盖写，别把这次修改丢掉。
        try {
          await fsp.writeFile(this.archivePath, json, 'utf8');
          await fsp.rm(tmp, { force: true }).catch(() => {});
        } catch (err2) {
          throw new Error(`写入 archive.json 失败：${err2.message}（rename 也失败：${err.message}）`);
        }
      }
    };
    // 串行化写操作，避免并发覆盖
    this._writing = this._writing.then(run, run);
    return this._writing;
  }

  // ---------- 查询 ----------

  list({ includeDeleted = false } = {}) {
    return this.data.entries.filter((e) => includeDeleted || !e.deleted);
  }

  get(id) {
    return this.data.entries.find((e) => e.id === id) || null;
  }

  stats() {
    const active = this.data.entries.filter((e) => !e.deleted);
    const byCategory = {};
    const byType = {};
    const tagMap = {};
    for (const e of active) {
      const c = e.category || '未分类';
      byCategory[c] = (byCategory[c] || 0) + 1;
      byType[e.type] = (byType[e.type] || 0) + 1;
      for (const t of e.tags) tagMap[t] = (tagMap[t] || 0) + 1;
    }
    return {
      total: active.length,
      trashed: this.data.entries.filter((e) => e.deleted).length,
      attachments: active.reduce((n, e) => n + e.attachments.length, 0),
      bytes: active.reduce((n, e) => n + e.attachments.reduce((m, a) => m + (a.size || 0), 0), 0),
      byCategory,
      byType,
      tags: Object.entries(tagMap)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh')),
      categories: [...this.data.categories],
    };
  }

  // ---------- 写入 ----------

  async create(payload = {}) {
    // 允许调用方指定 id（新建资料时先用草稿 id 收附件，保存后沿用同一个 id，
    // 这样 attachments/<id>/ 目录与资料 id 始终对得上，彻底删除时不会留下孤儿文件）
    const wantedId =
      payload.id && typeof payload.id === 'string' && !this.get(payload.id) ? payload.id : uid('e');
    const entry = this.normalizeEntry({
      ...payload,
      id: wantedId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deleted: false,
      deletedAt: null,
    });
    this.data.entries.unshift(entry);
    if (entry.category && !this.data.categories.includes(entry.category)) {
      this.data.categories.push(entry.category);
    }
    await this.flush();
    return entry;
  }

  async update(id, patch = {}) {
    const entry = this.get(id);
    if (!entry) throw new Error('资料不存在：' + id);
    const allowed = ['title', 'content', 'format', 'url', 'source', 'date', 'category', 'tags', 'type', 'attachments'];
    for (const key of allowed) {
      if (patch[key] !== undefined) entry[key] = patch[key];
    }
    // 重新规整（标签去重、字符串裁剪等）
    const fixed = this.normalizeEntry({ ...entry, id: entry.id, createdAt: entry.createdAt });
    Object.assign(entry, fixed, { updatedAt: nowIso() });
    if (entry.category && !this.data.categories.includes(entry.category)) {
      this.data.categories.push(entry.category);
    }
    await this.flush();
    return entry;
  }

  async trash(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    let n = 0;
    for (const id of list) {
      const e = this.get(id);
      if (e && !e.deleted) {
        e.deleted = true;
        e.deletedAt = nowIso();
        n++;
      }
    }
    await this.flush();
    return n;
  }

  async restore(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    let n = 0;
    for (const id of list) {
      const e = this.get(id);
      if (e && e.deleted) {
        e.deleted = false;
        e.deletedAt = null;
        n++;
      }
    }
    await this.flush();
    return n;
  }

  /** 彻底删除，连带删除该资料的附件目录 */
  async removeForever(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    let n = 0;
    for (const id of list) {
      const idx = this.data.entries.findIndex((e) => e.id === id);
      if (idx === -1) continue;
      const entry = this.data.entries[idx];
      this.data.entries.splice(idx, 1);
      n++;
      const dir = path.join(this.attachmentsPath, entry.id);
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    await this.flush();
    return n;
  }

  async emptyTrash() {
    const ids = this.data.entries.filter((e) => e.deleted).map((e) => e.id);
    return this.removeForever(ids);
  }

  async addCategory(name) {
    const c = String(name || '').trim();
    if (!c) throw new Error('分类名不能为空');
    if (!this.data.categories.includes(c)) {
      this.data.categories.push(c);
      await this.flush();
    }
    return this.data.categories;
  }

  async renameCategory(oldName, newName) {
    const from = String(oldName || '').trim();
    const to = String(newName || '').trim();
    if (!to) throw new Error('分类名不能为空');
    const idx = this.data.categories.indexOf(from);
    if (idx === -1) throw new Error('分类不存在：' + from);
    if (this.data.categories.includes(to) && to !== from) {
      throw new Error('已存在同名分类：' + to);
    }
    this.data.categories[idx] = to;
    for (const e of this.data.entries) {
      if (e.category === from) e.category = to;
    }
    await this.flush();
    return this.data.categories;
  }

  async removeCategory(name) {
    const c = String(name || '').trim();
    this.data.categories = this.data.categories.filter((x) => x !== c);
    for (const e of this.data.entries) {
      if (e.category === c) e.category = '';
    }
    await this.flush();
    return this.data.categories;
  }

  // ---------- 附件 ----------

  /** 把外部文件复制进资料库，返回附件描述 */
  async addAttachmentFromPath(entryId, srcPath) {
    const stat = await fsp.stat(srcPath);
    if (!stat.isFile()) throw new Error('不是文件：' + srcPath);
    const original = path.basename(srcPath);
    const ext = path.extname(original).replace('.', '').toLowerCase();
    const dir = path.join(this.attachmentsPath, entryId);
    await fsp.mkdir(dir, { recursive: true });

    // 同名文件加序号，不覆盖
    let name = safeName(original);
    let target = path.join(dir, name);
    let i = 1;
    while (fs.existsSync(target)) {
      const base = path.basename(safeName(original), path.extname(safeName(original)));
      name = `${base}_${i}${path.extname(safeName(original))}`;
      target = path.join(dir, name);
      i++;
    }
    await fsp.copyFile(srcPath, target);
    const relPath = path.posix.join(ATTACH_DIR, entryId, name);
    return {
      id: uid('a'),
      name,
      relPath,
      size: stat.size,
      ext,
      isImage: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'heic'].includes(ext),
      addedAt: nowIso(),
    };
  }

  /** 保存一段二进制（剪贴板图片等）为附件 */
  async addAttachmentFromBuffer(entryId, buffer, filename) {
    const dir = path.join(this.attachmentsPath, entryId);
    await fsp.mkdir(dir, { recursive: true });
    const name = safeName(filename);
    const target = path.join(dir, name);
    await fsp.writeFile(target, buffer);
    const ext = path.extname(name).replace('.', '').toLowerCase();
    return {
      id: uid('a'),
      name,
      relPath: path.posix.join(ATTACH_DIR, entryId, name),
      size: buffer.length,
      ext,
      isImage: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext),
      addedAt: nowIso(),
    };
  }

  /** 把附件目录搬到新 entryId（新建资料时用临时 id 收集附件后迁移） */
  async moveAttachmentDir(fromId, toId) {
    if (fromId === toId) return;
    const from = path.join(this.attachmentsPath, fromId);
    const to = path.join(this.attachmentsPath, toId);
    if (!fs.existsSync(from)) return;
    await fsp.mkdir(path.dirname(to), { recursive: true });
    if (fs.existsSync(to)) {
      for (const f of await fsp.readdir(from)) {
        await fsp.rename(path.join(from, f), path.join(to, f));
      }
      await fsp.rm(from, { recursive: true, force: true }).catch(() => {});
    } else {
      await fsp.rename(from, to);
    }
  }

  async removeAttachmentFile(relPath) {
    const abs = path.join(this.libraryPath, relPath);
    if (!this.isInsideLibrary(abs)) return;
    await fsp.rm(abs, { force: true }).catch(() => {});
    // 若目录空了就删掉
    const dir = path.dirname(abs);
    try {
      const rest = await fsp.readdir(dir);
      if (!rest.length) await fsp.rmdir(dir);
    } catch {
      /* ignore */
    }
  }

  isInsideLibrary(abs) {
    const rel = path.relative(this.libraryPath, abs);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  /** 附件绝对路径（做越界校验） */
  absOfAttachment(relPath) {
    const abs = path.resolve(this.libraryPath, relPath);
    if (!this.isInsideLibrary(abs)) throw new Error('附件路径越界');
    return abs;
  }
}

module.exports = { ArchiveStore, uid, today, nowIso, safeName, ARCHIVE_FILE, ATTACH_DIR, BACKUP_DIR, DEFAULT_CATEGORIES };
