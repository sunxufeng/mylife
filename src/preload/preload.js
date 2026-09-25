'use strict';
/**
 * My Workbench —— 预加载脚本
 * 只通过 contextBridge 暴露一组明确的、参数受控的能力，渲染进程拿不到 Node。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  // 基础信息
  snapshot: () => invoke('app:snapshot'),

  // 资料库位置
  openLibrary: () => invoke('library:open'),
  openPath: (p) => invoke('library:open-path', p),
  revealPath: (p) => invoke('library:reveal', p),
  changeLibrary: () => invoke('library:change'),

  // 界面偏好
  getPrefs: () => invoke('prefs:get'),
  setPrefs: (patch) => invoke('prefs:set', patch),

  // 资料
  createEntry: (payload) => invoke('entry:create', payload),
  updateEntry: (id, patch) => invoke('entry:update', id, patch),
  trashEntries: (ids) => invoke('entry:trash', ids),
  restoreEntries: (ids) => invoke('entry:restore', ids),
  deleteForever: (ids) => invoke('entry:delete-forever', ids),
  emptyTrash: () => invoke('entry:empty-trash'),

  // 日程
  createSchedule: (payload) => invoke('schedule:create', payload),
  updateSchedule: (id, patch) => invoke('schedule:update', id, patch),
  trashSchedules: (ids) => invoke('schedule:trash', ids),
  restoreSchedules: (ids) => invoke('schedule:restore', ids),
  deleteSchedulesForever: (ids) => invoke('schedule:delete-forever', ids),
  splitSchedule: (id, date) => invoke('schedule:split', id, date),
  exportIcs: (options) => invoke('schedule:export-ics', options),

  // 草稿
  newDraftId: () => invoke('draft:new-id'),
  discardDraft: (id) => invoke('draft:discard', id),

  // 分类
  addCategory: (name) => invoke('category:add', name),
  renameCategory: (from, to) => invoke('category:rename', from, to),
  removeCategory: (name) => invoke('category:remove', name),

  // 附件
  addAttachmentPaths: (entryId, paths) => invoke('attachment:add-paths', entryId, paths),
  addAttachmentBuffer: (entryId, buffer, filename) => invoke('attachment:add-buffer', entryId, buffer, filename),
  cleanupAttachments: (relPaths) => invoke('attachment:cleanup', relPaths),
  openAttachment: (relPath) => invoke('attachment:open', relPath),
  revealAttachment: (relPath) => invoke('attachment:reveal', relPath),
  saveAttachmentAs: (relPath, name) => invoke('attachment:save-as', relPath, name),

  // 选择文件 / 剪贴板
  pickFiles: (kind) => invoke('dialog:pick', kind),
  readClipboardImage: () => invoke('clipboard:image'),
  copyText: (text) => invoke('clipboard:write-text', text),

  // 导出
  exportMarkdown: (ids, options) => invoke('export:markdown', ids, options),
  exportPreview: (ids, options) => invoke('export:preview', ids, options),

  // 备份 / 恢复
  createBackup: (path) => invoke('backup:create', path),
  backupToLibrary: () => invoke('backup:create-in-library'),
  inspectBackup: () => invoke('backup:inspect'),
  inspectPath: (path) => invoke('backup:inspect-path', path),
  restoreBackup: (path) => invoke('backup:restore', path),
  listBackups: () => invoke('backup:list'),

  // 打开外部链接
  openExternal: (url) => invoke('shell:open-external', url),

  // 拖拽进来的 File 对象 → 真实磁盘路径（Electron 32+ 不再有 File.path）
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  // 主进程菜单事件
  onMenu: (handler) => {
    const channels = [
      'menu:new',
      'menu:new-schedule',
      'menu:save',
      'menu:search',
      'menu:settings',
      'menu:backup',
      'menu:backup-as',
      'menu:restore',
      'menu:export-ics',
      'menu:calendar',
      'menu:all',
      'menu:help',
      'menu:toggle-side',
      'menu:toggle-list',
    ];
    for (const ch of channels) {
      ipcRenderer.on(ch, () => handler(ch));
    }
  },

  // 日程提醒（应用运行期间才会有）
  onReminder: (handler) => {
    ipcRenderer.on('reminder:fire', (_e, payload) => handler({ type: 'fire', ...payload }));
    ipcRenderer.on('reminder:summary', (_e, payload) => handler({ type: 'summary', ...payload }));
  },
  onReminderFocus: (handler) => {
    ipcRenderer.on('reminder:focus', (_e, payload) => handler(payload));
  },

  // 飞书日历同步
  feishu: {
    getConfig: () => invoke('feishu:config'),
    saveConfig: (patch) => invoke('feishu:save-config', patch),
    login: () => invoke('feishu:login'),
    logout: () => invoke('feishu:logout'),
    pull: () => invoke('feishu:pull'),
    push: () => invoke('feishu:push'),
    status: () => invoke('feishu:status'),
    onResult: (handler) => {
      ipcRenderer.on('feishu:sync-result', (_e, payload) => handler(payload));
    },
  },
});
