'use strict';
/* ==========================================================================
   My Workbench —— 渲染进程
   ========================================================================== */

// 注意：顶层不能声明名为 api 的绑定，会与预加载暴露的 window.api 冲突导致整份脚本解析失败
const API = window.api;

const TYPE_LABEL = { text: '文字', link: '链接', image: '图片', file: '文件' };
const TYPE_ICON = { text: '文', link: '链', image: '图', file: '件' };
const DATE_FILTERS = [
  { v: '', l: '全部时间' },
  { v: 'today', l: '今天' },
  { v: '7', l: '近 7 天' },
  { v: '30', l: '近 30 天' },
  { v: '365', l: '近一年' },
  { v: 'older', l: '一年以前' },
];
const SORTS = [
  { v: 'updated_desc', l: '最近修改' },
  { v: 'created_desc', l: '最近添加' },
  { v: 'date_desc', l: '日期新→旧' },
  { v: 'date_asc', l: '日期旧→新' },
  { v: 'title', l: '标题' },
];

const state = {
  entries: [],
  schedules: [],
  stats: {
    total: 0,
    trashed: 0,
    byCategory: {},
    byType: {},
    tags: [],
    categories: [],
    attachments: 0,
    bytes: 0,
    schedules: { total: 0, trashed: 0, done: 0, repeating: 0 },
  },
  appInfo: null,
  libraryPath: '',
  prefs: {
    theme: 'sage',
    sidebarCollapsed: false,
    listCollapsed: false,
    mdPreview: true,
    lastFormat: '',
    notify: true,
    calView: 'month',
    calRange: 30,
  },
  migratedFrom: null,
  focusMode: false,
  view: 'all', // all | trash | calendar | cat:<name> | tag:<name>
  q: '',
  filterType: '',
  filterTag: '',
  filterDate: '',
  sort: 'updated_desc',
  selectedId: null,
  checked: new Set(),
  editing: null,
  lastVisible: [],
  // ---- 日历 ----
  calCursor: '', // 当前显示的月份（用该月里任意一天表示）
  calSelectedDate: '', // 右栏正在看的那一天
  calView: 'month', // month | agenda
  calRange: 30, // 议程视图看多少天
  selectedScheduleId: null,
  scheduleEditing: null,
  expandedAgendaDays: new Set(), // 议程视图里展开「明天以后」的分组
  reminders: [], // 提醒条上的日程
  pendingSplitDate: '', // 「只改这一次」时记住原来那次是哪天
};

/* ---------------------------------------------------------------- 小工具 */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function mediaUrl(relPath) {
  return 'archive://local/' + String(relPath).split('/').map(encodeURIComponent).join('/');
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

/** 今天的日期（YYYY-MM-DD）。注意：schedule.js 里也有同名函数，脚本先加载它、
 *  这里再声明会覆盖掉；两者在「不传参」时结果一致，日历那边只按无参调用，所以无碍。 */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' 天前';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function hl(text, q) {
  const raw = String(text == null ? '' : text);
  if (!q) return esc(raw);
  const idx = raw.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return esc(raw);
  return (
    esc(raw.slice(0, idx)) +
    '<mark>' +
    esc(raw.slice(idx, idx + q.length)) +
    '</mark>' +
    esc(raw.slice(idx + q.length))
  );
}

/** 截取命中关键词附近的片段 */
function snippetOf(entry, q) {
  const raw = entry.format === 'markdown' ? mdToPlain(entry.content) : entry.content || '';
  const text = raw.replace(/\s+/g, ' ').trim();
  const url = entry.url || '';
  const src = entry.source || '';
  if (!q) return text.slice(0, 150) || (entry.type === 'link' ? url : '');
  const pool = [text, url, src].filter(Boolean);
  for (const p of pool) {
    const i = p.toLowerCase().indexOf(q.toLowerCase());
    if (i !== -1) {
      const start = Math.max(0, i - 40);
      return (start > 0 ? '…' : '') + p.slice(start, start + 150);
    }
  }
  return text.slice(0, 150);
}

function toast(msg, kind = '') {
  const root = $('#toastRoot');
  const t = el('div', 'toast ' + kind, msg);
  root.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 240);
  }, kind === 'err' ? 3600 : 2200);
}

/** 统一包裹 IPC：失败时弹提示并返回 null */
async function act(promise, okMsg) {
  try {
    const r = await promise;
    if (!r || r.ok === false) throw new Error((r && r.error) || '操作失败');
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (err) {
    toast(err && err.message ? err.message : String(err), 'err');
    return null;
  }
}

/* ---------------------------------------------------------------- 弹层 */

let modalCloser = null;

function closeModal() {
  if (modalCloser) {
    modalCloser();
    modalCloser = null;
  }
}

function openModal({ title, subtitle, body, footer, wide, dismissable = true }) {
  closeModal();
  const root = $('#modalRoot');
  root.innerHTML = '';
  const overlay = el('div', 'overlay');
  const modal = el('div', 'modal' + (wide ? ' wide' : ''));
  const head = el('div', 'modal-head');
  head.appendChild(el('h2', null, title));
  if (subtitle) head.appendChild(el('p', null, subtitle));
  const bodyEl = el('div', 'modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  modal.appendChild(head);
  modal.appendChild(bodyEl);
  if (footer) {
    const foot = el('div', 'modal-foot');
    if (typeof footer === 'string') foot.innerHTML = footer;
    else foot.appendChild(footer);
    modal.appendChild(foot);
  }
  overlay.appendChild(modal);

  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable) {
      e.stopPropagation();
      closeModal();
    }
  };
  document.addEventListener('keydown', onKey, true);
  if (dismissable) {
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) closeModal();
    });
  }
  root.appendChild(overlay);
  modalCloser = () => {
    document.removeEventListener('keydown', onKey, true);
    root.innerHTML = '';
  };
  return { modal, body: bodyEl, close: closeModal };
}

function confirmDialog({ title, message, detail, okLabel = '确定', danger = false }) {
  return new Promise((resolve) => {
    const body = el('div');
    if (detail) {
      body.appendChild(el('p', null, detail));
      body.style.fontSize = '12.5px';
      body.style.color = 'var(--ink-2)';
      body.style.lineHeight = '1.8';
      body.style.whiteSpace = 'pre-wrap';
    }
    const foot = el('div');
    foot.style.display = 'flex';
    foot.style.gap = '8px';
    const sp = el('span', 'spacer');
    sp.style.flex = '1';
    const cancel = el('button', 'tb', '取消');
    const ok = el('button', 'tb ' + (danger ? 'danger' : 'primary'), okLabel);
    foot.append(sp, cancel, ok);
    const { close } = openModal({
      title,
      subtitle: detail ? undefined : message,
      body: detail ? body : undefined,
      footer: foot,
      dismissable: true,
    });
    cancel.onclick = () => {
      close();
      resolve(false);
    };
    ok.onclick = () => {
      close();
      resolve(true);
    };
  });
}

/* ---------------------------------------------------------------- 数据同步 */

function applySnapshot(res) {
  if (res.entries) state.entries = res.entries;
  if (res.schedules) state.schedules = res.schedules;
  if (res.stats) state.stats = { ...state.stats, ...res.stats };
  if (res.libraryPath) state.libraryPath = res.libraryPath;
  if (res.appInfo) state.appInfo = res.appInfo;
  if (res.prefs) state.prefs = { ...state.prefs, ...res.prefs };
  if (res.migratedFrom) state.migratedFrom = res.migratedFrom;
}

/* ---------------------------------------------------------------- 偏好设置 */

/** 把偏好落到界面上：主题变量 + 各栏收缩状态 */
function applyPrefs() {
  applyTheme(state.prefs.theme);
  const app = $('#app');
  if (!app) return;
  const focus = !!state.focusMode;
  app.classList.toggle('side-collapsed', focus || !!state.prefs.sidebarCollapsed);
  app.classList.toggle('list-collapsed', focus || !!state.prefs.listCollapsed);
}

async function setPrefs(patch, { silent = true } = {}) {
  state.prefs = { ...state.prefs, ...patch };
  applyPrefs();
  const r = await API.setPrefs(patch);
  if (!silent && (!r || r.ok === false)) {
    toast((r && r.error) || '偏好没能保存', 'err');
  }
  return r;
}

function toggleSidebar() {
  if (state.focusMode) state.focusMode = false;
  setPrefs({ sidebarCollapsed: !state.prefs.sidebarCollapsed });
}

function toggleList() {
  if (state.focusMode) state.focusMode = false;
  setPrefs({ listCollapsed: !state.prefs.listCollapsed });
}

/* ---------------------------------------------------------------- 筛选 */

function dateInRange(dateStr, key) {
  if (!key) return true;
  const d = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return true;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = (start - d) / 86400000;
  if (key === 'today') return d >= start;
  if (key === 'older') return days > 365;
  return days >= 0 && days <= Number(key);
}

function matchQuery(e, q) {
  if (!q) return true;
  const t = q.toLowerCase();
  return (
    (e.title || '').toLowerCase().includes(t) ||
    (e.content || '').toLowerCase().includes(t) ||
    (e.source || '').toLowerCase().includes(t) ||
    (e.url || '').toLowerCase().includes(t) ||
    (e.category || '').toLowerCase().includes(t) ||
    e.tags.some((tag) => tag.toLowerCase().includes(t)) ||
    e.attachments.some((a) => a.name.toLowerCase().includes(t))
  );
}

function currentList() {
  const inTrash = state.view === 'trash';
  let list = state.entries.filter((e) => (inTrash ? e.deleted : !e.deleted));

  if (state.view.startsWith('cat:')) {
    const c = state.view.slice(4);
    list = c === '__none__' ? list.filter((e) => !e.category) : list.filter((e) => e.category === c);
  } else if (state.view.startsWith('tag:')) {
    const t = state.view.slice(4);
    list = list.filter((e) => e.tags.includes(t));
  }

  if (state.filterType) list = list.filter((e) => e.type === state.filterType);
  if (state.filterTag) list = list.filter((e) => e.tags.includes(state.filterTag));
  if (state.filterDate) list = list.filter((e) => dateInRange(e.date, state.filterDate));
  if (state.q) list = list.filter((e) => matchQuery(e, state.q));

  const s = state.sort;
  const cmp = {
    updated_desc: (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''),
    created_desc: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
    date_desc: (a, b) => (b.date || '').localeCompare(a.date || ''),
    date_asc: (a, b) => (a.date || '').localeCompare(b.date || ''),
    title: (a, b) => (a.title || '').localeCompare(b.title || '', 'zh'),
  }[s];
  return list.sort(cmp);
}

/* ---------------------------------------------------------------- 渲染：左栏 */

function renderSidebar() {
  const st = state.stats;

  const nav = $('#navMain');
  nav.innerHTML = '';
  const mk = (view, icon, label, count, extra) => {
    const b = el('button', 'nav-item' + (state.view === view ? ' active' : ''));
    b.innerHTML =
      `<span class="ico">${icon}</span><span>${esc(label)}</span>` +
      (extra ? `<span class="pin">${extra}</span>` : '') +
      `<span class="count">${count}</span>`;
    b.onclick = () => {
      if (view === 'calendar') gotoCalendar();
      else {
        abandonEditing();
        state.view = view;
        state.checked.clear();
        state.selectedId = null;
        state.editing = null;
        state.selectedScheduleId = null;
        state.scheduleEditing = null;
        renderAll();
      }
    };
    nav.appendChild(b);
  };

  const todayN = todayOccurrences().length;
  mk('calendar', '▦', '日历', todayN ? `${todayN} 今日` : '', '');
  mk('all', '▤', '全部资料', st.total);
  mk('trash', '🗑', '回收站', st.trashed + (st.schedules ? st.schedules.trashed : 0));

  // 分类：全部列出来（空分类也保留，否则刚建完分类会「消失」让人困惑）
  const cl = $('#categoryList');
  cl.innerHTML = '';
  const cats = st.categories || [];
  const uncategorized = st.byCategory && st.byCategory['未分类'] ? st.byCategory['未分类'] : 0;

  cats.forEach((c) => {
    cl.appendChild(catRow(c, st.byCategory[c] || 0));
  });
  if (uncategorized) cl.appendChild(catRow('__none__', uncategorized, '未分类'));
  if (!cats.length && !uncategorized) {
    const p = el('div', null, '还没有分类');
    p.style.cssText = 'font-size:11px;color:var(--ink-4);padding:4px 10px';
    cl.appendChild(p);
  }

  // 标签
  const tc = $('#tagCloud');
  tc.innerHTML = '';
  const tags = (st.tags || []).slice(0, 24);
  if (!tags.length) {
    const p = el('div', null, '还没有标签');
    p.style.cssText = 'font-size:11px;color:var(--ink-4);padding:2px 2px';
    tc.appendChild(p);
  }
  tags.forEach((t) => {
    const b = el('button', 'tag-chip' + (state.view === 'tag:' + t.name ? ' active' : ''));
    b.innerHTML = esc(t.name) + `<span class="n">${t.count}</span>`;
    b.onclick = () => {
      abandonEditing();
      state.view = state.view === 'tag:' + t.name ? 'all' : 'tag:' + t.name;
      state.filterTag = '';
      state.selectedId = null;
      state.editing = null;
      state.selectedScheduleId = null;
      state.scheduleEditing = null;
      renderAll();
    };
    tc.appendChild(b);
  });

  $('#libPath').textContent = state.libraryPath || '…';
}

function catRow(name, count, label) {
  const isNone = name === '__none__';
  const viewId = isNone ? 'cat:__none__' : 'cat:' + name;
  const row = el('div', 'cat-item' + (state.view === viewId ? ' active' : ''));
  const dot = el('span', 'dot');
  const nm = el('span', 'name', label || name);
  nm.title = label || name;
  const cnt = el('span', 'count', count);
  row.append(dot, nm, cnt);
  if (!isNone) {
    const edit = el('button', 'cat-edit', '···');
    edit.title = '重命名 / 删除分类';
    edit.onclick = (ev) => {
      ev.stopPropagation();
      openCategoryMenu(name);
    };
    row.appendChild(edit);
  }
  row.onclick = () => {
    abandonEditing();
    state.view = state.view === viewId ? 'all' : viewId;
    state.checked.clear();
    state.selectedId = null;
    state.editing = null;
    state.selectedScheduleId = null;
    state.scheduleEditing = null;
    renderAll();
  };
  return row;
}

function openCategoryMenu(name) {
  const body = el('div');
  body.innerHTML = `
    <div class="field" style="margin-bottom:12px">
      <label>分类名称</label>
      <input type="text" id="catNameInput" value="${esc(name)}" />
      <div class="hint">改名后，归在这个分类下的资料会一起更新。</div>
    </div>`;
  const foot = el('div');
  foot.style.cssText = 'display:flex;gap:8px;width:100%';
  const del = el('button', 'tb danger', '删除分类');
  const sp = el('span');
  sp.style.flex = '1';
  const cancel = el('button', 'tb', '取消');
  const save = el('button', 'tb primary', '保存');
  foot.append(del, sp, cancel, save);

  const { close } = openModal({
    title: '编辑分类',
    body,
    footer: foot,
    wide: false,
  });
  const input = body.querySelector('#catNameInput');
  input.focus();
  input.select();
  save.onclick = async () => {
    const v = input.value.trim();
    if (!v) return toast('分类名不能为空', 'err');
    if (v === name) return close();
    const r = await act(API.renameCategory(name, v), '分类已改名');
    if (r) {
      applySnapshot(r);
      if (state.view === 'cat:' + name) state.view = 'cat:' + v;
      close();
      renderAll();
    }
  };
  cancel.onclick = close;
  del.onclick = async () => {
    close();
    const ok = await confirmDialog({
      title: '删除分类「' + name + '」？',
      message: '分类下的资料不会被删除，只会变成「未分类」。',
      okLabel: '删除分类',
      danger: true,
    });
    if (!ok) return;
    const r = await act(API.removeCategory(name), '分类已删除');
    if (r) {
      applySnapshot(r);
      if (state.view === 'cat:' + name) state.view = 'all';
      renderAll();
    }
  };
}

/* ---------------------------------------------------------------- 渲染：中栏 */

function renderListControls() {
  // 类型
  const ft = $('#filterType');
  ft.innerHTML = '';
  ft.appendChild(new Option('全部类型', ''));
  Object.entries(TYPE_LABEL).forEach(([v, l]) => ft.appendChild(new Option(l, v)));
  ft.value = state.filterType;

  // 标签
  const tg = $('#filterTag');
  tg.innerHTML = '';
  tg.appendChild(new Option('全部标签', ''));
  (state.stats.tags || []).forEach((t) => tg.appendChild(new Option(`${t.name} (${t.count})`, t.name)));
  tg.value = state.filterTag;

  // 日期
  const fd = $('#filterDate');
  fd.innerHTML = '';
  DATE_FILTERS.forEach((d) => fd.appendChild(new Option(d.l, d.v)));
  fd.value = state.filterDate;

  // 排序
  const sb = $('#sortBy');
  sb.innerHTML = '';
  SORTS.forEach((s) => sb.appendChild(new Option(s.l, s.v)));
  sb.value = state.sort;

  const hasFilter = !!(state.q || state.filterType || state.filterTag || state.filterDate);
  $('#btnClearFilters').classList.toggle('hidden', !hasFilter);
  $('#searchWrap').classList.toggle('has-text', !!state.q);
  if ($('#searchInput').value !== state.q) $('#searchInput').value = state.q;
}

/** 中栏在「列表模式 / 日历模式」之间切换外观 */
function setPaneMode() {
  const cal = state.view === 'calendar';
  const app = $('#app');
  if (app) app.classList.toggle('cal-mode', cal);
  const head = $('#calHead');
  if (head) head.classList.toggle('hidden', !cal);
  const lh = $('#listHead');
  if (lh) lh.classList.toggle('cal-mode', cal);
  const sb = $('#listScroll');
  if (sb) sb.classList.toggle('cal-scroll', cal);
  const si = $('#searchInput');
  if (si) si.placeholder = cal ? '搜索日程：标题、地点、备注、标签…' : '搜索标题、正文、来源、标签…';
}

function renderList() {
  setPaneMode();
  if (state.view === 'calendar') return renderCalendar();

  const list = currentList();
  state.lastVisible = list;
  const scroll = $('#listScroll');
  scroll.innerHTML = '';

  const inTrash = state.view === 'trash';
  const extra = state.view.startsWith('cat:') || state.view.startsWith('tag:') ? schedulesInCurrentScope() : [];
  const trashedSchedules = inTrash ? state.schedules.filter((s) => s.deleted) : [];

  $('#listCount').textContent =
    `${list.length} 条` +
    (extra.length ? ` · 日程 ${extra.length} 条` : '') +
    (state.view === 'trash' ? '（回收站）' : '');
  $('#btnBulkRestore').classList.toggle('hidden', !inTrash);
  $('#btnBulkDelete').classList.toggle('hidden', !inTrash);
  $('#btnBulkTrash').classList.toggle('hidden', inTrash);
  $('#btnEmptyTrash').classList.toggle('hidden', !inTrash || !(state.stats.trashed + state.stats.schedules.trashed));

  if (!list.length && !extra.length && !trashedSchedules.length) {
    let tip = '这里还空着。';
    if (inTrash) tip = '回收站是空的。';
    else if (state.q) tip = '没有匹配的资料，换个关键词试试。';
    else if (state.view.startsWith('cat:') || state.view.startsWith('tag:')) tip = '这个分类下还没有资料。';
    const box = el('div', 'empty');
    box.innerHTML = `<div class="big">${inTrash ? '空' : '静'}</div><p>${esc(tip)}</p>`;
    if (!inTrash && !state.q) {
      const b = el('button', 'tb primary', '＋ 新建第一条资料');
      b.style.marginTop = '14px';
      b.onclick = startNewFlow;
      box.appendChild(b);
    }
    scroll.appendChild(box);
    renderBulk();
    return;
  }

  if (inTrash) {
    // 回收站分两组：资料 / 日程
    if (list.length) {
      scroll.appendChild(el('div', 'group-head', `资料 · ${list.length}`));
      for (const e of list) scroll.appendChild(renderCard(e, true));
    }
    if (trashedSchedules.length) {
      scroll.appendChild(el('div', 'group-head', `日程 · ${trashedSchedules.length}`));
      for (const s of trashedSchedules) {
        scroll.appendChild(
          scheduleRow(
            {
              schedule: s,
              key: s.id,
              date: s.date,
              startDate: s.date,
              endDate: s.endDate || s.date,
              days: s.endDate && s.endDate > s.date ? 2 : 1,
            },
            { inTrash: true }
          )
        );
      }
    }
    renderBulk();
    return;
  }

  // 按时间分组（仅当按时间排序时）
  const grouped = ['updated_desc', 'created_desc', 'date_desc'].includes(state.sort);
  let lastKey = null;
  for (const e of list) {
    if (grouped) {
      const d = new Date(e.date + 'T00:00:00');
      const key = Number.isNaN(d.getTime())
        ? '未知日期'
        : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
      if (key !== lastKey) {
        scroll.appendChild(el('div', 'group-head', key));
        lastKey = key;
      }
    }
    scroll.appendChild(renderCard(e, inTrash));
  }

  // 分类 / 标签视图里，把日程接在后面，形成「同一主题下的资料与安排」
  if (extra.length) {
    scroll.appendChild(el('div', 'group-head', `日程 · ${extra.length}`));
    const seen = new Set();
    for (const s of extra) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      scroll.appendChild(renderScheduleCard({ schedule: s, key: s.id, date: s.date }));
    }
  }
  renderBulk();
}

/** 当前分类 / 标签范围内命中的日程 */
function schedulesInCurrentScope() {
  let list = state.schedules.filter((s) => !s.deleted);
  if (state.view.startsWith('cat:')) {
    const c = state.view.slice(4);
    list = c === '__none__' ? list.filter((s) => !s.category) : list.filter((s) => s.category === c);
  } else if (state.view.startsWith('tag:')) {
    const t = state.view.slice(4);
    list = list.filter((s) => s.tags.includes(t));
  }
  if (state.q && state.view.startsWith('tag:')) {
    list = list.filter((s) => matchScheduleQuery(s, state.q));
  }
  return list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function renderCard(e, inTrash) {
  const card = el('div', 'card' + (state.selectedId === e.id ? ' active' : '') + (state.checked.has(e.id) ? ' checked' : ''));

  const pick = el('input', 'pick');
  pick.type = 'checkbox';
  pick.checked = state.checked.has(e.id);
  pick.onclick = (ev) => {
    ev.stopPropagation();
    if (pick.checked) state.checked.add(e.id);
    else state.checked.delete(e.id);
    card.classList.toggle('checked', pick.checked);
    renderBulk();
    $('#checkAll').checked = state.checked.size > 0 && state.checked.size === state.lastVisible.length;
  };
  card.appendChild(pick);

  const firstImg = e.attachments.find((a) => a.isImage);
  const top = el('div', 'card-top');
  const badge = el('span', 'type-badge ' + e.type + (inTrash ? ' trashed' : ''), inTrash ? '回收站' : TYPE_LABEL[e.type]);
  top.appendChild(badge);
  top.appendChild(el('span', 'date', e.date || ''));
  card.appendChild(top);

  if (firstImg) {
    const img = el('img', 'thumb');
    img.src = mediaUrl(firstImg.relPath);
    img.loading = 'lazy';
    img.alt = '';
    card.appendChild(img);
  }

  const h3 = el('h3');
  h3.innerHTML = hl(e.title, state.q);
  card.appendChild(h3);

  const sn = snippetOf(e, state.q);
  if (sn) {
    const p = el('div', 'snippet');
    p.innerHTML = hl(sn, state.q);
    card.appendChild(p);
  }

  if (e.tags.length) {
    const tg = el('div', 'card-tags');
    e.tags.slice(0, 4).forEach((t) => tg.appendChild(el('span', 'mini-tag', t)));
    if (e.tags.length > 4) tg.appendChild(el('span', 'mini-tag', '+' + (e.tags.length - 4)));
    card.appendChild(tg);
  }

  const foot = el('div', 'card-foot');
  if (e.attachments.length) {
    foot.appendChild(el('span', 'clip', `📎 ${e.attachments.length}`));
  }
  if (e.source) foot.appendChild(el('span', null, e.source.slice(0, 24)));
  if (e.category) foot.appendChild(el('span', null, e.category));
  if (inTrash && e.deletedAt) {
    foot.appendChild(el('span', null, '删除于 ' + relTime(e.deletedAt)));
  } else {
    foot.appendChild(el('span', null, relTime(e.updatedAt)));
  }
  card.appendChild(foot);

  card.onclick = () => {
    state.selectedId = e.id;
    state.editing = null;
    state.selectedScheduleId = null;
    state.scheduleEditing = null;
    renderList();
    renderDetail();
  };
  return card;
}

/** 中栏列表里的日程卡片（分类 / 标签视图、回收站里用） */
function renderScheduleCard(o, { inTrash = false } = {}) {
  const s = o.schedule;
  const card = el('div', 'card sched-card c-' + colorOf(s) +
    (state.selectedScheduleId === s.id ? ' active' : '') + (s.done ? ' done' : ''));

  const top = el('div', 'card-top');
  top.appendChild(el('span', 'type-badge sched', inTrash ? '回收站' : '日程'));
  if (s.source === 'feishu') top.appendChild(el('span', 'type-badge feishu', '飞书'));
  top.appendChild(el('span', 'date', s.endDate ? `${s.date} → ${s.endDate}` : s.date || ''));
  card.appendChild(top);

  const h3 = el('h3');
  h3.innerHTML = hl(s.title, state.q);
  card.appendChild(h3);

  const meta = el('div', 'sched-line');
  meta.appendChild(el('span', 'sched-time', fmtTime(s)));
  if (s.location) meta.appendChild(el('span', null, s.location));
  const rep = repeatDesc(s.repeat);
  if (rep) meta.appendChild(el('span', null, rep));
  card.appendChild(meta);

  if (s.tags && s.tags.length) {
    const tg = el('div', 'card-tags');
    s.tags.slice(0, 4).forEach((t) => tg.appendChild(el('span', 'mini-tag', t)));
    card.appendChild(tg);
  }

  const foot = el('div', 'card-foot');
  if (s.links && s.links.length) foot.appendChild(el('span', 'clip', `关联 ${s.links.length}`));
  foot.appendChild(el('span', null, inTrash && s.deletedAt ? '删除于 ' + relTime(s.deletedAt) : relTime(s.updatedAt)));
  card.appendChild(foot);

  if (!inTrash) {
    const circle = el('button', 'done-circle small' + (s.done ? ' on' : ''), s.done ? '✓' : '');
    circle.title = s.done ? '标记为未完成' : '标记为完成';
    circle.onclick = (ev) => {
      ev.stopPropagation();
      toggleScheduleDone(s, o);
    };
    card.appendChild(circle);
    card.onclick = () => {
      state.view = 'calendar';
      state.calCursor = s.date;
      state.calSelectedDate = s.date;
      state.selectedScheduleId = s.id;
      state.selectedOccurrenceDate = o.date || s.date;
      state.selectedId = null;
      state.scheduleEditing = null;
      renderAll();
    };
  } else {
    const acts = el('div', 'sr-acts');
    const back = el('button', null, '还原');
    back.onclick = async (ev) => {
      ev.stopPropagation();
      const r = await act(API.restoreSchedules([s.id]), '日程已还原');
      if (r) {
        applySnapshot(r);
        renderAll();
      }
    };
    const gone = el('button', null, '彻底删除');
    gone.onclick = async (ev) => {
      ev.stopPropagation();
      const ok = await confirmDialog({
        title: '彻底删除这条日程？',
        message: '删除后无法恢复。',
        okLabel: '彻底删除',
        danger: true,
      });
      if (!ok) return;
      const r = await act(API.deleteSchedulesForever([s.id]));
      if (r) {
        applySnapshot(r);
        if (state.selectedScheduleId === s.id) state.selectedScheduleId = null;
        renderAll();
      }
    };
    acts.append(back, gone);
    card.appendChild(acts);
  }
  return card;
}

function renderBulk() {
  const n = state.checked.size;
  $('#bulkBar').classList.toggle('hidden', n === 0);
  $('#bulkCount').textContent = `已选 ${n} 条`;
  const vis = state.lastVisible.length;
  const all = $('#checkAll');
  all.checked = vis > 0 && n === vis;
  all.indeterminate = n > 0 && n < vis;
}

/* ==========================================================================
   日历与日程
   ==========================================================================
   说明：日期计算、重复规则展开、冲突检测、.ics 生成都在 schedule.js 里，
   那边是纯函数、可单测；这里只负责把它们画出来和接上交互。
   ========================================================================== */

/** 正在被拖动的日程实例（HTML5 拖拽全程共用） */
let draggingSchedule = null;

function matchScheduleQuery(s, q) {
  if (!q) return true;
  const t = q.toLowerCase();
  return (
    (s.title || '').toLowerCase().includes(t) ||
    (s.location || '').toLowerCase().includes(t) ||
    (s.note || '').toLowerCase().includes(t) ||
    (s.category || '').toLowerCase().includes(t) ||
    (s.tags || []).some((x) => x.toLowerCase().includes(t))
  );
}

/** 日历视图下，标签筛选与搜索都作用在日程上 */
function matchesCalFilter(s) {
  if (state.filterTag && !s.tags.includes(state.filterTag)) return false;
  if (state.q && !matchScheduleQuery(s, state.q)) return false;
  return true;
}

function todayOccurrences() {
  return occurrencesOn(state.schedules, todayStr());
}

/** 「今天」「明天」这类相对词，只在这几天用 */
const REL_WORDS = new Set(['今天', '明天', '后天', '昨天']);

/**
 * 列表里的一天该显示成什么：
 * 今天 → 「今天 · 9 月 24 日 · 周四」；别的日子 → 「9 月 30 日 · 周三」
 */
function dayLabel(dateStr) {
  const rel = fmtRelDay(dateStr);
  return REL_WORDS.has(rel)
    ? `${rel} · ${fmtDayTitle(dateStr)}`
    : fmtDayTitle(dateStr);
}

/**
 * 跨天日程在月视图里每天都画一条（连成一条色带），
 * 但列成清单时只该出现一次 —— 按「日程 + 起始日」去重。
 */
function dedupeOccurrences(list) {
  const seen = new Set();
  return list.filter((o) => {
    if (seen.has(o.key)) return false;
    seen.add(o.key);
    return true;
  });
}

function gotoCalendar(opts = {}) {
  abandonEditing();
  state.view = 'calendar';
  state.checked.clear();
  state.editing = null;
  if (!state.calCursor) state.calCursor = todayStr();
  if (!state.calSelectedDate) state.calSelectedDate = todayStr();
  if (opts.date) {
    state.calCursor = opts.date;
    state.calSelectedDate = opts.date;
  }
  state.selectedScheduleId = opts.scheduleId || null;
  state.selectedOccurrenceDate = opts.date || '';
  state.scheduleEditing = null;
  state.reminders = [];
  renderReminders();
  renderAll();
}

/** 从中栏的任何位置跳到某条日程（关联资料、提醒条都用它） */
function jumpToSchedule(id, date) {
  const s = state.schedules.find((x) => x.id === id);
  if (!s) return toast('这条日程已经不在资料库里了', 'err');
  const day = date || s.date;
  state.view = 'calendar';
  state.calCursor = day;
  state.calSelectedDate = day;
  state.selectedScheduleId = id;
  state.selectedOccurrenceDate = day;
  state.scheduleEditing = null;
  renderAll();
}

/* ---------------------------------------------------------------- 中栏 */

function renderCalendar() {
  const cal = state.calView || 'month';

  // 周标题行（只在月视图有意义）
  const week = $('#calWeek');
  week.innerHTML = '';
  week.classList.toggle('hidden', cal !== 'month');
  ['一', '二', '三', '四', '五', '六', '日'].forEach((w) => week.appendChild(el('span', 'cal-wd', w)));

  const start = state.calCursor || todayStr();
  $('#calTitle').textContent =
    cal === 'month'
      ? fmtMonthTitle(state.calCursor)
      : `${start === todayStr() ? '今天' : fmtMonthDay(start)}起 ${state.calRange} 天`;

  const seg = $('#calViewSeg');
  seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === cal));
  const rs = $('#calRangeSeg');
  rs.classList.toggle('hidden', cal !== 'agenda');
  rs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.r) === state.calRange));

  const scroll = $('#listScroll');
  scroll.innerHTML = '';
  if (cal === 'month') renderMonthGrid(scroll);
  else renderAgenda(scroll);
}

function renderMonthGrid(container) {
  const grid = monthGrid(state.calCursor);
  const anchor = parseDate(state.calCursor) || new Date();
  const monthIdx = anchor.getMonth();
  const occs = occurrencesInRange(state.schedules, grid.start, grid.end).filter((o) =>
    matchesCalFilter(o.schedule)
  );
  const byDay = new Map();
  for (const o of occs) {
    if (!byDay.has(o.date)) byDay.set(o.date, []);
    byDay.get(o.date).push(o);
  }

  const today = todayStr();
  const gridEl = el('div', 'cal-grid');
  for (const day of grid.days) {
    const d = parseDate(day);
    const cell = el('div', 'cal-cell');
    cell.dataset.date = day;
    if (d.getMonth() !== monthIdx) cell.classList.add('out');
    if (day === today) cell.classList.add('today');
    if (day === state.calSelectedDate) cell.classList.add('sel');
    if (d.getDay() === 0 || d.getDay() === 6) cell.classList.add('weekend');

    const num = el('div', 'cal-daynum', String(d.getDate()));
    cell.appendChild(num);

    const items = byDay.get(day) || [];
    const box = el('div', 'cal-chips');
    const MAX = 2;
    items.slice(0, MAX).forEach((o) => box.appendChild(calChip(o)));
    if (items.length > MAX) {
      const more = el('button', 'cal-more', `+${items.length - MAX}`);
      more.title = items
        .slice(MAX)
        .map((o) => o.schedule.title)
        .join('、');
      more.onclick = (ev) => {
        ev.stopPropagation();
        state.calSelectedDate = day;
        state.selectedScheduleId = null;
        renderAll();
      };
      box.appendChild(more);
    }
    cell.appendChild(box);

    cell.onclick = () => {
      // 注意：这里刻意不整块重绘 —— 重绘会把格子换成新节点，
      // 双击的第二下就落到别的节点上，dblclick 永远触发不了。
      if (day === state.calSelectedDate && !state.selectedScheduleId) return;
      selectDayInGrid(day);
    };
    cell.ondblclick = () => startNewSchedule(day);
    cell.addEventListener('dragover', (e) => {
      if (!draggingSchedule) return;
      e.preventDefault();
      cell.classList.add('drop-target');
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('drop-target'));
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      cell.classList.remove('drop-target');
      onDropSchedule(day);
    });
    gridEl.appendChild(cell);
  }
  container.appendChild(gridEl);

  const tip = el('div', 'cal-tip', '点一下选某天，双击空白格直接新建；把色条拖到别的日子就能改期。');
  container.appendChild(tip);
}

function calChip(o) {
  const s = o.schedule;
  const chip = el('div', 'cal-chip c-' + colorOf(s) + (s.done ? ' done' : ''));
  const st = hmToMin(s.start);
  chip.title = `${s.allDay || st == null ? '全天' : minToHm(st)} ${s.title}${s.location ? ' · ' + s.location : ''}`;
  chip.appendChild(el('span', 'chip-dot'));
  if (!s.allDay && st != null && o.spanStart) chip.appendChild(el('span', 'chip-time', minToHm(st)));
  chip.appendChild(el('span', 'chip-title', s.title));
  if (o.days > 1) chip.classList.add(o.spanStart ? 'span-start' : 'span-mid');
  chip.draggable = true;
  chip.onclick = (ev) => {
    ev.stopPropagation();
    selectOccurrence(o);
  };
  chip.addEventListener('dragstart', (e) => {
    draggingSchedule = o;
    chip.classList.add('dragging');
    try {
      e.dataTransfer.setData('text/plain', o.key);
    } catch {
      /* 某些环境下不允许写 dataTransfer，忽略即可 */
    }
    e.dataTransfer.effectAllowed = 'move';
  });
  chip.addEventListener('dragend', () => {
    draggingSchedule = null;
    chip.classList.remove('dragging');
    document.querySelectorAll('.cal-cell.drop-target').forEach((c) => c.classList.remove('drop-target'));
  });
  return chip;
}

function renderAgenda(container) {
  const start = state.calCursor || todayStr();
  const end = addDays(start, state.calRange - 1);
  const occs = dedupeOccurrences(
    occurrencesInRange(state.schedules, start, end).filter((o) => matchesCalFilter(o.schedule))
  );
  const byDay = new Map();
  for (const o of occs) {
    if (!byDay.has(o.date)) byDay.set(o.date, []);
    byDay.get(o.date).push(o);
  }

  const wrap = el('div', 'cal-agenda');
  let shown = 0;
  for (let i = 0; i < state.calRange; i++) {
    const day = addDays(start, i);
    const items = byDay.get(day) || [];
    if (!items.length) continue;
    shown++;
    const rel = fmtRelDay(day);
    const group = el('div', 'ag-day' + (day === todayStr() ? ' is-today' : ''));
    const head = el('div', 'ag-head');
    head.innerHTML =
      `<span class="ag-rel">${esc(REL_WORDS.has(rel) ? rel : fmtMonthDay(day))}</span>` +
      `<span class="ag-full">${esc(REL_WORDS.has(rel) ? fmtDayTitle(day) : '周' + WEEK_CN[weekdayOf(day)])}</span>` +
      `<span class="ag-n">${items.length} 项</span>`;
    head.onclick = () => {
      state.calSelectedDate = day;
      state.selectedScheduleId = null;
      renderAll();
    };
    group.appendChild(head);
    const list = el('div', 'ag-list');
    const conflicts = conflictsIn(items);
    for (const o of items) list.appendChild(scheduleRow(o, { conflicts }));
    group.appendChild(list);
    wrap.appendChild(group);
  }

  if (!shown) {
    const box = el('div', 'empty');
    box.innerHTML = `<div class="big">静</div><p>接下来 ${state.calRange} 天没有安排。</p>`;
    const b = el('button', 'tb primary', '＋ 新建日程');
    b.style.marginTop = '14px';
    b.onclick = () => startNewSchedule(todayStr());
    box.appendChild(b);
    wrap.appendChild(box);
  }
  container.appendChild(wrap);
}

/** 一条日程的「列表行」，议程视图与右栏某天面板共用 */
function scheduleRow(o, opts = {}) {
  const s = o.schedule;
  const row = el('div', 'sched-row c-' + colorOf(s) + (s.done ? ' done' : '') +
    (state.selectedScheduleId === s.id ? ' active' : ''));

  const circle = el('button', 'done-circle' + (s.done ? ' on' : ''), s.done ? '✓' : '');
  circle.title = s.done ? '标记为未完成' : '标记为完成';
  circle.onclick = (ev) => {
    ev.stopPropagation();
    toggleScheduleDone(s, o);
  };
  row.appendChild(circle);

  const main = el('div', 'sr-main');
  const line1 = el('div', 'sr-line1');
  const t = hmToMin(s.start);
  line1.appendChild(el('span', 'sr-time', s.allDay || t == null ? '全天' : minToHm(t)));
  line1.appendChild(el('span', 'sr-title', s.title));
  main.appendChild(line1);

  const bits = [];
  if (o.days > 1) bits.push(`${fmtMonthDay(o.startDate)} – ${fmtMonthDay(o.endDate)}`);
  if (s.location) bits.push(s.location);
  const rep = repeatDesc(s.repeat);
  if (rep) bits.push(rep);
  if (s.links && s.links.length) bits.push(`关联资料 ${s.links.length} 条`);
  if (opts.inTrash && s.deletedAt) bits.push('删除于 ' + relTime(s.deletedAt));
  if (bits.length) main.appendChild(el('div', 'sr-sub', bits.join('　·　')));
  row.appendChild(main);

  const cf = (opts.conflicts || {})[o.key];
  if (cf && cf.length) {
    const warn = el('div', 'sr-conflict', '与「' + cf.join('」「') + '」时间重叠');
    main.appendChild(warn);
  }
  if (opts.inTrash) {
    const acts = el('div', 'sr-acts');
    const back = el('button', null, '还原');
    back.onclick = async (ev) => {
      ev.stopPropagation();
      const r = await act(API.restoreSchedules([s.id]), '日程已还原');
      if (r) {
        applySnapshot(r);
        renderAll();
      }
    };
    const gone = el('button', null, '彻底删除');
    gone.onclick = async (ev) => {
      ev.stopPropagation();
      const ok = await confirmDialog({
        title: '彻底删除这条日程？',
        message: '删除后无法恢复。',
        okLabel: '彻底删除',
        danger: true,
      });
      if (!ok) return;
      const r = await act(API.deleteSchedulesForever([s.id]));
      if (r) {
        applySnapshot(r);
        if (state.selectedScheduleId === s.id) state.selectedScheduleId = null;
        renderAll();
      }
    };
    acts.append(back, gone);
    row.appendChild(acts);
  } else {
    row.onclick = () => selectOccurrence(o);
  }
  return row;
}

function selectOccurrence(o) {
  state.selectedScheduleId = o.schedule.id;
  state.selectedOccurrenceDate = o.startDate;
  state.calSelectedDate = o.date;
  state.scheduleEditing = null;
  renderAll();
}

/** 在月视图里换一天：只改选中样式 + 重绘右栏，不动网格本身（否则双击会失效） */
function selectDayInGrid(day) {
  state.calSelectedDate = day;
  state.selectedScheduleId = null;
  state.scheduleEditing = null;
  const grid = document.querySelector('.cal-grid');
  if (grid) {
    grid.querySelectorAll('.cal-cell.sel').forEach((c) => c.classList.remove('sel'));
    const hit = grid.querySelector(`.cal-cell[data-date="${day}"]`);
    if (hit) hit.classList.add('sel');
  }
  renderDetail();
}

async function toggleScheduleDone(s, o) {
  if (s.repeat && s.repeat.freq !== 'none') {
    const ok = await confirmDialog({
      title: '这是重复日程',
      message: `完成状态会作用在整个重复日程上（${repeatDesc(s.repeat)}）。\n只想勾掉这一次的话，可以用「只改这一次」把它拆出来。`,
      okLabel: s.done ? '整条标记未完成' : '整条标记完成',
    });
    if (!ok) return;
  }
  const r = await act(API.updateSchedule(s.id, { done: !s.done }));
  if (r) {
    applySnapshot(r);
    renderAll();
    toast(!s.done ? '已标记完成' : '已恢复未完成', 'ok');
  }
}

async function onDropSchedule(targetDay) {
  const o = draggingSchedule;
  draggingSchedule = null;
  if (!o) return;
  const s = o.schedule;
  const delta = diffDays(o.date, targetDay);
  if (!delta) return;
  if (s.repeat && s.repeat.freq !== 'none') {
    const ok = await confirmDialog({
      title: '这是重复日程',
      message: `拖动会改动整个重复规则（${repeatDesc(s.repeat)}）。\n只想挪这一次的话，点开日程用「只改这一次」。`,
      okLabel: '整体改期',
    });
    if (!ok) return;
  }
  const patch = { date: addDays(s.date, delta) };
  if (s.endDate) patch.endDate = addDays(s.endDate, delta);
  const r = await act(API.updateSchedule(s.id, patch), `已改到 ${fmtMonthDay(patch.date)}`);
  if (r) {
    applySnapshot(r);
    state.calSelectedDate = targetDay;
    state.selectedScheduleId = s.id;
    renderAll();
  }
}

/* ---------------------------------------------------------------- 右栏 */

function renderCalendarDetail() {
  if (state.scheduleEditing) return renderScheduleEditor();
  if (state.selectedScheduleId) {
    const s = state.schedules.find((x) => x.id === state.selectedScheduleId);
    if (s) return renderScheduleDetail(s);
    state.selectedScheduleId = null;
  }
  return renderDayPanel(state.calSelectedDate || todayStr());
}

function calBarBase() {
  const bar = [];
  bar.push(mkTb('＋ 新建日程', 'primary', () => startNewSchedule(state.calSelectedDate || todayStr()), '⌘⇧N'));
  bar.push(mkTb('导出 .ics', null, exportIcsFlow, '导进 macOS 日历 / Google 日历'));
  const sp = el('span', 'spacer');
  bar.push(sp);
  return bar;
}

function renderDayPanel(day) {
  const bar = calBarBase();
  const isToday = day === todayStr();
  if (!isToday) bar.push(mkTb('回到今天', 'ghost', () => gotoCalendar({ date: todayStr() }), 'T'));
  renderDetailBar(bar);

  const occs = dedupeOccurrences(occurrencesOn(state.schedules, day));
  const conflicts = conflictsIn(occs);

  const scroll = $('#detailScroll');
  scroll.innerHTML = '';
  const inner = el('div', 'detail-inner cal-detail');

  inner.appendChild(el('div', 'd-title cal-day-title', fmtDayTitle(day)));
  const subBits = [isToday ? '今天' : fmtRelDay(day)];
  subBits.push(occs.length ? `${occs.length} 条日程` : '没有安排');
  const doneN = occs.filter((o) => o.schedule.done).length;
  if (doneN) subBits.push(`已完成 ${doneN}`);
  const sub = el('div', 'cal-sub', subBits.join('　·　'));
  inner.appendChild(sub);

  if (!occs.length) {
    const box = el('div', 'cal-empty');
    box.innerHTML = '<p>这一天还没有安排。</p>';
    const b = el('button', 'tb primary', '＋ 在这天新建日程');
    b.onclick = () => startNewSchedule(day);
    box.appendChild(b);
    inner.appendChild(box);
  } else {
    const list = el('div', 'sched-list');
    list.id = 'dayList';
    for (const o of occs) list.appendChild(scheduleRow(o, { conflicts }));
    inner.appendChild(list);
  }

  // 选的是今天：额外给出「接下来」与「本周」
  if (isToday) {
    const upcoming = dedupeOccurrences(
      occurrencesInRange(state.schedules, addDays(day, 1), addDays(day, 3))
    );
    if (upcoming.length) {
      const sec = el('div', 'd-section');
      sec.appendChild(el('h4', null, '接下来 3 天'));
      const list = el('div', 'sched-list compact');
      list.id = 'upcomingList';
      let lastDay = '';
      for (const o of upcoming) {
        if (o.date !== lastDay) {
          lastDay = o.date;
          sec.appendChild(el('div', 'sched-daysep', dayLabel(o.date)));
        }
        list.appendChild(scheduleRow(o));
      }
      sec.appendChild(list);
      inner.appendChild(sec);
    }

    const ws = weekStart(day);
    const we = addDays(ws, 6);
    const week = dedupeOccurrences(occurrencesInRange(state.schedules, ws, we));
    const sec2 = el('div', 'd-section');
    sec2.appendChild(el('h4', null, '本周'));
    const grid = el('div', 'kv-list');
    const doneWeek = week.filter((o) => o.schedule.done).length;
    const busy = [];
    const byDayWeek = new Map();
    for (const o of occurrencesInRange(state.schedules, ws, we)) {
      if (!byDayWeek.has(o.date)) byDayWeek.set(o.date, []);
      byDayWeek.get(o.date).push(o);
    }
    for (const [d, list] of byDayWeek) {
      if (Object.keys(conflictsIn(list)).length) busy.push(fmtMonthDay(d));
    }
    busy.sort();
    [
      ['本周日程', `${week.length} 条`],
      ['已完成', `${doneWeek} 条`],
      ['有安排的天数', `${byDayWeek.size} 天`],
      ['时间冲突的天', busy.length ? busy.join('、') : '没有'],
    ].forEach(([k, v]) => {
      const r = el('div', 'row');
      r.appendChild(el('span', 'k', k));
      r.appendChild(el('span', 'v', v));
      grid.appendChild(r);
    });
    sec2.appendChild(grid);
    inner.appendChild(sec2);
  }

  scroll.appendChild(inner);
}

function renderScheduleDetail(s) {
  const bar = [
    mkTb('编辑', 'primary', () => startEditSchedule(s)),
    mkTb(s.done ? '标记未完成' : '标记完成', null, () => toggleScheduleDone(s, { key: `${s.id}@${s.date}` })),
  ];
  if (s.repeat && s.repeat.freq !== 'none') {
    bar.push(
      mkTb('只改这一次', null, () => splitScheduleFlow(s, state.selectedOccurrenceDate || s.date), '把这一次拆成独立日程，其余各次不变')
    );
  }
  bar.push(
    mkTb('移到回收站', 'danger', async () => {
      const r = await act(API.trashSchedules([s.id]), '日程已移到回收站');
      if (r) {
        applySnapshot(r);
        state.selectedScheduleId = null;
        renderAll();
      }
    })
  );
  const sp = el('span', 'spacer');
  bar.push(sp);
  renderDetailBar(bar);

  const scroll = $('#detailScroll');
  scroll.innerHTML = '';
  const inner = el('div', 'detail-inner cal-detail');

  const h = el('div', 'd-title');
  h.textContent = s.title;
  inner.appendChild(h);

  const meta = el('div', 'd-meta');
  const kv = (k, v, mono) => {
    const w = el('div', 'kv');
    w.appendChild(el('span', 'k', k));
    w.appendChild(el('span', 'v' + (mono ? ' mono' : ''), v));
    return w;
  };
  meta.appendChild(kv('日期', s.endDate ? `${s.date} → ${s.endDate}` : s.date, true));
  meta.appendChild(kv('时间', fmtTime(s)));
  if (s.location) meta.appendChild(kv('地点', s.location));
  if (s.category) meta.appendChild(kv('分类', s.category));
  meta.appendChild(kv('提醒', s.remind == null ? '不提醒' : fmtRemind(s.remind)));
  meta.appendChild(kv('状态', s.done ? '已完成' : '待办'));
  if (s.source === 'feishu') meta.appendChild(kv('来源', '飞书日历'));
  const rep = repeatDesc(s.repeat);
  if (rep) meta.appendChild(kv('重复', rep));
  meta.appendChild(kv('创建于', relTime(s.createdAt)));
  inner.appendChild(meta);

  const colorRow = el('div', 'd-section');
  colorRow.style.marginTop = '0';
  colorRow.appendChild(el('h4', null, '色标'));
  const chip = el('span', 'color-badge c-' + colorOf(s), COLOR_NAMES[colorOf(s)] || colorOf(s));
  colorRow.appendChild(chip);
  inner.appendChild(colorRow);

  if (s.tags && s.tags.length) {
    const sec = el('div', 'd-section');
    sec.appendChild(el('h4', null, '标签'));
    const box = el('div', 'card-tags');
    box.style.marginTop = '0';
    s.tags.forEach((t) => {
      const c = el('span', 'mini-tag', t);
      c.style.cursor = 'pointer';
      c.onclick = () => {
        state.view = 'tag:' + t;
        state.filterTag = '';
        state.selectedId = null;
        state.selectedScheduleId = null;
        renderAll();
      };
      box.appendChild(c);
    });
    sec.appendChild(box);
    inner.appendChild(sec);
  }

  const secN = el('div', 'd-section');
  secN.appendChild(el('h4', null, '备注'));
  if (s.note && s.note.trim()) {
    const c = el('div', 'md-body');
    c.innerHTML = mdToHtml(s.note);
    secN.appendChild(c);
  } else {
    secN.appendChild(el('div', 'd-content empty-hint', '（还没有备注）'));
  }
  inner.appendChild(secN);

  // 关联资料
  const secL = el('div', 'd-section');
  const linked = (s.links || []).map((id) => state.entries.find((e) => e.id === id)).filter(Boolean);
  secL.appendChild(el('h4', null, `关联资料 · ${linked.length}`));
  if (!linked.length) {
    const hint = el('div');
    hint.style.cssText = 'font-size:12px;color:var(--ink-4);line-height:1.8';
    hint.textContent = '这条日程还没有关联资料。点「编辑」可以把相关的记录挂上来。';
    secL.appendChild(hint);
  } else {
    const box = el('div', 'link-cards');
    for (const e of linked) box.appendChild(linkCard(e));
    secL.appendChild(box);
  }
  inner.appendChild(secL);

  scroll.appendChild(inner);
}

/** 关联资料卡片（日程详情、提醒里都用） */
function linkCard(e) {
  const card = el('button', 'link-card');
  card.innerHTML = `
    <span class="lc-badge">${esc(TYPE_LABEL[e.type] || e.type)}</span>
    <span class="lc-main">
      <span class="lc-title">${esc(e.title)}</span>
      <span class="lc-sub">${esc(e.date || '')}${e.category ? '　·　' + esc(e.category) : ''}</span>
    </span>`;
  card.onclick = () => {
    state.view = 'all';
    state.q = '';
    state.selectedId = e.id;
    state.selectedScheduleId = null;
    state.editing = null;
    state.scheduleEditing = null;
    renderAll();
  };
  return card;
}

function fmtRemind(min) {
  const n = Number(min);
  if (!Number.isFinite(n)) return '不提醒';
  if (n === 0) return '准点';
  if (n % 1440 === 0) return `提前 ${n / 1440} 天`;
  if (n % 60 === 0) return `提前 ${n / 60} 小时`;
  return `提前 ${n} 分钟`;
}

/* ------------------------------------------------------------ 日程编辑器 */

function blankSchedule(dateStr) {
  const day = dateStr || todayStr();
  return {
    isNew: true,
    id: '',
    title: '',
    date: day,
    endDate: '',
    allDay: false,
    start: '',
    end: '',
    location: '',
    note: '',
    category: state.view.startsWith('cat:') && state.view !== 'cat:__none__' ? state.view.slice(4) : '',
    color: '',
    tags: [],
    links: [],
    repeat: { freq: 'none' },
    remind: null,
    source: 'local',
    feishu: { push: false },
  };
}

function draftFromSchedule(s) {
  return {
    isNew: false,
    id: s.id,
    title: s.title,
    date: s.date,
    endDate: s.endDate || '',
    allDay: !!s.allDay,
    start: s.start || '',
    end: s.end || '',
    location: s.location || '',
    note: s.note || '',
    category: s.category || '',
    color: s.color || '',
    tags: [...(s.tags || [])],
    links: [...(s.links || [])],
    repeat: s.repeat ? { ...s.repeat } : { freq: 'none' },
    remind: s.remind == null ? null : s.remind,
    done: !!s.done,
    source: s.source === 'feishu' ? 'feishu' : 'local',
    feishu: s.feishu && typeof s.feishu === 'object' ? { ...s.feishu } : { push: false },
  };
}

function startNewSchedule(dateStr) {
  state.scheduleEditing = blankSchedule(dateStr);
  state.selectedScheduleId = null;
  state.selectedId = null;
  state.editing = null;
  renderAll();
  const t = $('#sTitle');
  if (t) t.focus();
}

function startEditSchedule(s) {
  state.scheduleEditing = draftFromSchedule(s);
  renderAll();
  const t = $('#sTitle');
  if (t) t.focus();
}

function renderScheduleEditor() {
  const d = state.scheduleEditing;
  const isNew = d.isNew;

  const bar = [mkTb('保存', 'primary', saveScheduleEditing, '⌘S'), mkTb('取消', 'ghost', cancelScheduleEditing)];
  const sp = el('span', 'spacer');
  bar.push(sp);
  if (!isNew) {
    bar.push(
      mkTb('删除', 'danger', async () => {
        const ok = await confirmDialog({
          title: '把这条日程移到回收站？',
          message: '之后可以在回收站里还原。',
          okLabel: '移到回收站',
        });
        if (!ok) return;
        const r = await act(API.trashSchedules([d.id]), '日程已移到回收站');
        if (r) {
          applySnapshot(r);
          state.scheduleEditing = null;
          state.selectedScheduleId = null;
          renderAll();
        }
      })
    );
  }
  renderDetailBar(bar);

  const scroll = $('#detailScroll');
  scroll.innerHTML = '';
  const inner = el('div', 'detail-inner wide cal-detail');
  const form = el('div', 'form');

  const catOptions = ['<option value="">未分类</option>']
    .concat((state.stats.categories || []).map((c) => `<option value="${esc(c)}">${esc(c)}</option>`))
    .join('');

  form.innerHTML = `
    <div class="field field-title">
      <label>日程标题</label>
      <input type="text" id="sTitle" placeholder="要做什么" value="${esc(d.title)}" />
    </div>

    <div class="grid-3">
      <div class="field">
        <label>日期</label>
        <input type="date" id="sDate" value="${esc(d.date)}" />
      </div>
      <div class="field">
        <label>结束日期（跨天时填）</label>
        <input type="date" id="sEndDate" value="${esc(d.endDate || '')}" />
      </div>
      <div class="field">
        <label>时间</label>
        <div class="time-row">
          <input type="time" id="sStart" value="${esc(d.start || '')}" ${d.allDay ? 'disabled' : ''} />
          <span class="dash">–</span>
          <input type="time" id="sEnd" value="${esc(d.end || '')}" ${d.allDay ? 'disabled' : ''} />
        </div>
        <label class="switch" style="margin-top:6px">
          <input type="checkbox" id="sAllDay" ${d.allDay ? 'checked' : ''} /> 全天日程
        </label>
      </div>
    </div>

    <div class="grid-3">
      <div class="field">
        <label>地点</label>
        <input type="text" id="sLocation" placeholder="如：三楼会议室" value="${esc(d.location)}" />
      </div>
      <div class="field">
        <label>分类</label>
        <select id="sCategory">${catOptions}</select>
      </div>
      <div class="field">
        <label>提前提醒</label>
        <select id="sRemind">
          ${REMIND_OPTIONS.map(
            (o) => `<option value="${o.v}" ${String(d.remind == null ? '' : d.remind) === String(o.v) ? 'selected' : ''}>${esc(o.l)}</option>`
          ).join('')}
        </select>
      </div>
    </div>

    <div class="field">
      <label>色标</label>
      <div class="color-picker" id="sColors"></div>
    </div>

    <div class="grid-2">
      <div class="field">
        <label>重复</label>
        <div class="repeat-row">
          <select id="sRepeatFreq">
            ${REPEAT_FREQS.map(
              (f) => `<option value="${f}" ${(d.repeat.freq || 'none') === f ? 'selected' : ''}>${esc(REPEAT_NAMES[f])}</option>`
            ).join('')}
          </select>
          <input type="date" id="sRepeatUntil" value="${esc(d.repeat.until || '')}" title="重复到哪天（留空表示一直重复）" />
        </div>
        <div class="hint">重复日程只保存规则，改规则就改一条；只想改某一次，用详情里的「只改这一次」。</div>
      </div>
      <div class="field">
        <label>标签</label>
        <div class="tag-editor" id="sTagEditor">
          <input type="text" id="sTagInput" placeholder="输入后按回车或逗号添加" />
        </div>
      </div>
    </div>

    <div class="field">
      <label>备注</label>
      <textarea class="plain sched-note" id="sNote" placeholder="支持 Markdown：**粗体**、列表、表格…">${esc(d.note)}</textarea>
    </div>

    <div class="field">
      <label>关联资料</label>
      <div class="link-picker" id="sLinkPicker"></div>
      <div class="hint">关联之后，资料详情里也会反向显示「相关日程」。</div>
    </div>

    <div class="field" id="sFeishuField" style="${d.source === 'feishu' ? 'display:none' : ''}">
      <label>同步到飞书</label>
      <label class="switch" style="margin-top:2px">
        <input type="checkbox" id="sFeishuPush" ${d.feishu && d.feishu.push ? 'checked' : ''} /> 把这条日程（含改动）推送进我的飞书主日历
      </label>
      <div class="hint">勾选后，在设置里点「推送到飞书」会把它新建 / 更新到飞书。从飞书拉进来的日程会自动同步，这里不用勾。</div>
    </div>
  `;
  inner.appendChild(form);
  scroll.appendChild(inner);

  // 分类选中
  const sel = $('#sCategory');
  if (d.category && !(state.stats.categories || []).includes(d.category)) {
    sel.appendChild(new Option(d.category, d.category));
  }
  sel.value = d.category || '';

  // 事件
  $('#sTitle').oninput = (e) => (d.title = e.target.value);
  $('#sDate').onchange = (e) => (d.date = e.target.value || todayStr());
  $('#sEndDate').onchange = (e) => (d.endDate = e.target.value || '');
  $('#sStart').onchange = (e) => (d.start = e.target.value || '');
  $('#sEnd').onchange = (e) => (d.end = e.target.value || '');
  $('#sAllDay').onchange = (e) => {
    d.allDay = e.target.checked;
    renderScheduleEditor();
  };
  $('#sLocation').oninput = (e) => (d.location = e.target.value);
  sel.onchange = (e) => (d.category = e.target.value);
  $('#sNote').oninput = (e) => (d.note = e.target.value);
  $('#sRepeatFreq').onchange = (e) => {
    d.repeat = { ...d.repeat, freq: e.target.value };
    if (e.target.value === 'none') delete d.repeat.until;
  };
  $('#sRepeatUntil').onchange = (e) => {
    if (e.target.value) d.repeat = { ...d.repeat, until: e.target.value };
    else {
      const r = { ...d.repeat };
      delete r.until;
      d.repeat = r;
    }
  };
  $('#sRemind').onchange = (e) => (d.remind = e.target.value === '' ? null : Number(e.target.value));
  const fsPush = $('#sFeishuPush');
  if (fsPush) fsPush.onchange = (e) => {
    d.feishu = { ...(d.feishu || { push: false }), push: e.target.checked };
  };

  renderColorPicker();
  renderScheduleTagEditor();
  renderLinkPicker();

  ['#sTitle', '#sLocation', '#sNote'].forEach((sel2) => {
    const node = $(sel2);
    if (node) {
      node.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault();
          saveScheduleEditing();
        }
      });
    }
  });
}

function renderColorPicker() {
  const d = state.scheduleEditing;
  const box = $('#sColors');
  if (!box) return;
  box.innerHTML = '';
  const auto = el('button', 'color-dot auto' + (!d.color ? ' on' : ''), '自动');
  auto.title = '按分类自动分配';
  auto.onclick = () => {
    d.color = '';
    renderColorPicker();
  };
  box.appendChild(auto);
  SCHEDULE_COLORS.forEach((c) => {
    const b = el('button', 'color-dot c-' + c + (d.color === c ? ' on' : ''));
    b.title = COLOR_NAMES[c];
    b.onclick = () => {
      d.color = c;
      renderColorPicker();
    };
    box.appendChild(b);
  });
}

function renderScheduleTagEditor() {
  const d = state.scheduleEditing;
  const box = $('#sTagEditor');
  if (!box) return;
  box.querySelectorAll('.t').forEach((n) => n.remove());
  const input = $('#sTagInput');
  d.tags.forEach((t) => {
    const chip = el('span', 't');
    chip.appendChild(document.createTextNode(t));
    const x = el('button', null, '✕');
    x.onclick = () => {
      d.tags = d.tags.filter((v) => v !== t);
      renderScheduleTagEditor();
    };
    chip.appendChild(x);
    box.insertBefore(chip, input);
  });
  const commit = () => {
    const v = input.value.trim().replace(/^#/, '');
    if (v) {
      v.split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((p) => {
          if (!d.tags.includes(p)) d.tags.push(p);
        });
    }
    input.value = '';
    renderScheduleTagEditor();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && !input.value && d.tags.length) {
      d.tags.pop();
      renderScheduleTagEditor();
    }
  };
  input.onblur = commit;
}

function renderLinkPicker() {
  const d = state.scheduleEditing;
  const box = $('#sLinkPicker');
  if (!box) return;
  box.innerHTML = '';

  const chips = el('div', 'card-tags lp-chips');
  d.links.forEach((id) => {
    const e = state.entries.find((x) => x.id === id);
    const chip = el('span', 'mini-tag');
    chip.appendChild(document.createTextNode(e ? e.title : '（已删除的资料）'));
    const x = el('button', null, '✕');
    x.onclick = () => {
      d.links = d.links.filter((v) => v !== id);
      renderLinkPicker();
    };
    chip.appendChild(x);
    chips.appendChild(chip);
  });
  if (!d.links.length) chips.appendChild(el('span', 'lp-hint', '还没有关联资料'));
  box.appendChild(chips);

  const search = el('input', 'lp-search');
  search.type = 'text';
  search.placeholder = '搜索要关联的资料…';
  box.appendChild(search);

  const list = el('div', 'lp-list');
  box.appendChild(list);

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = '';
    const pool = state.entries
      .filter((e) => !e.deleted)
      .filter((e) => (q ? matchQuery(e, q) : true))
      .slice(0, 40);
    if (!pool.length) {
      list.appendChild(el('div', 'lp-hint', '没有匹配的资料'));
      return;
    }
    for (const e of pool) {
      const on = d.links.includes(e.id);
      const row = el('button', 'lp-row' + (on ? ' on' : ''));
      row.innerHTML = `<span class="lp-check">${on ? '✓' : ''}</span><span class="lp-title">${esc(e.title)}</span><span class="lp-meta">${esc(e.date || '')}</span>`;
      row.onclick = () => {
        if (on) d.links = d.links.filter((v) => v !== e.id);
        else d.links.push(e.id);
        renderLinkPicker();
      };
      list.appendChild(row);
    }
  };
  search.oninput = draw;
  draw();
}

async function saveScheduleEditing() {
  const d = state.scheduleEditing;
  if (!d) return;
  const title = (d.title || '').trim();
  if (!title) return toast('给日程起个名字再保存', 'err');
  const payload = {
    title,
    date: d.date || todayStr(),
    endDate: d.endDate || null,
    allDay: !!d.allDay,
    start: d.allDay ? '' : d.start || '',
    end: d.allDay ? '' : d.end || '',
    location: (d.location || '').trim(),
    note: d.note || '',
    category: d.category || '',
    color: d.color || '',
    tags: d.tags.slice(),
    links: d.links.slice(),
    repeat: d.repeat && d.repeat.freq !== 'none' ? d.repeat : { freq: 'none' },
    remind: d.remind == null ? null : Number(d.remind),
    source: d.source === 'feishu' ? 'feishu' : 'local',
    feishu: d.feishu && typeof d.feishu === 'object' ? d.feishu : { push: false },
  };
  const r = d.isNew
    ? await act(API.createSchedule(payload))
    : await act(API.updateSchedule(d.id, payload));
  if (!r) return;
  applySnapshot(r);
  const saved = r.schedule;
  state.scheduleEditing = null;
  state.selectedScheduleId = saved.id;
  state.calSelectedDate = saved.date;
  state.calCursor = saved.date;
  renderAll();
  toast(d.isNew ? '日程已创建' : '日程已保存', 'ok');
}

function cancelScheduleEditing() {
  state.scheduleEditing = null;
  renderAll();
}

async function splitScheduleFlow(s, dateStr) {
  const day = dateStr || s.date;
  const ok = await confirmDialog({
    title: '只改这一次？',
    message: `「${s.title}」是重复日程。\n这次操作会把 ${fmtCnDate(day)} 这一次拆成一条独立日程，其余各次保持不变。`,
    okLabel: '拆出这一次',
  });
  if (!ok) return;
  const r = await act(API.splitSchedule(s.id, day), '已拆出一条独立日程');
  if (!r) return;
  applySnapshot(r);
  state.selectedScheduleId = r.schedule.id;
  state.selectedOccurrenceDate = day;
  state.calSelectedDate = day;
  state.scheduleEditing = draftFromSchedule(r.schedule);
  renderAll();
}

/* -------------------------------------------------------------- 提醒条 */

function renderReminders() {
  const bar = $('#remindBar');
  if (!bar) return;
  if (!state.reminders.length) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  bar.innerHTML = '';
  const inner = el('div', 'rb-inner');
  const n = state.reminders.length;
  inner.appendChild(el('span', 'rb-ico', '⏰'));
  inner.appendChild(
    el(
      'span',
      'rb-text',
      n === 1 ? `日程提醒：${state.reminders[0].title}` : `有 ${n} 条日程该提醒了`
    )
  );
  state.reminders.slice(0, 3).forEach((it) => {
    const b = el('button', 'rb-item', `${it.time}　${it.title}`);
    b.onclick = () => jumpToSchedule(it.id, it.date);
    inner.appendChild(b);
  });
  if (n > 3) {
    const more = el('button', 'rb-item', `还有 ${n - 3} 条…`);
    more.onclick = () => gotoCalendar({ date: todayStr() });
    inner.appendChild(more);
  }
  const close = el('button', 'rb-close', '✕');
  close.title = '知道了';
  close.onclick = () => {
    state.reminders = [];
    renderReminders();
  };
  inner.appendChild(close);
  bar.appendChild(inner);
}

function pushReminders(type, items) {
  const list = (items || []).map((it) => ({
    key: it.key,
    id: it.id,
    title: it.title,
    date: it.date,
    time: it.time,
    location: it.location,
    allDay: it.allDay,
  }));
  if (!list.length) return;
  const seen = new Set(state.reminders.map((x) => x.key));
  for (const it of list) if (!seen.has(it.key)) state.reminders.push(it);
  renderReminders();
  if (type === 'fire') {
    toast(`⏰ ${list.length} 条日程到点了`, 'ok');
  }
}

/* ------------------------------------------------------------ .ics 导出 */

function exportIcsFlow() {
  const body = el('div');
  const total = state.schedules.filter((s) => !s.deleted).length;
  if (!total) {
    toast('还没有日程可以导出', 'err');
    return;
  }
  body.innerHTML = `
    <p style="font-size:12.5px;color:var(--ink-2);margin-bottom:14px;line-height:1.8">
      导出成标准 iCalendar（.ics）文件，可以直接导进 macOS 日历、Google 日历。
      重复日程会按规则展开成一次次具体时间，提醒设置也会一起带过去。
    </p>
    <label class="opt-row">
      <input type="radio" name="icsRange" value="month" checked />
      <span><span class="t">当前月</span><span class="d">${esc(fmtMonthTitle(state.calCursor || todayStr()))}的日程</span></span>
    </label>
    <label class="opt-row">
      <input type="radio" name="icsRange" value="next30" />
      <span><span class="t">未来 30 天</span><span class="d">从今天起一个月内要发生的事</span></span>
    </label>
    <label class="opt-row">
      <input type="radio" name="icsRange" value="all" />
      <span><span class="t">全部日程</span><span class="d">资料库里的 ${total} 条日程全导，跨年也会展开</span></span>
    </label>`;
  const foot = el('div');
  foot.style.cssText = 'display:flex;gap:8px;width:100%';
  const sp = el('span');
  sp.style.flex = '1';
  const cancel = el('button', 'tb', '取消');
  const ok = el('button', 'tb primary', '选择位置并导出');
  foot.append(sp, cancel, ok);
  const { close } = openModal({ title: '导出日程（.ics）', body, footer: foot });
  cancel.onclick = close;
  ok.onclick = async () => {
    const range = body.querySelector('input[name="icsRange"]:checked').value;
    close();
    const r = await act(API.exportIcs({ range, anchor: state.calCursor || todayStr() }));
    if (!r || r.canceled) return;
    const go = await confirmDialog({
      title: '导出完成',
      message: `文件：${r.path}\n共 ${r.events} 个日程事件（${r.from} ~ ${r.to}）。\n双击这个 .ics 就能导入系统日历。`,
      okLabel: '在访达中显示',
    });
    if (go) await act(API.revealPath(r.path));
  };
}

/* ---------------------------------------------------------------- 渲染：右栏 */

function renderDetailBar(buttons) {
  const bar = $('#detailBar');
  bar.innerHTML = '';
  if (!buttons || !buttons.length) return;
  buttons.forEach((b) => bar.appendChild(b));
}

function mkTb(label, cls, onclick, title) {
  const b = el('button', 'tb' + (cls ? ' ' + cls : ''), label);
  if (title) b.title = title;
  if (onclick) b.onclick = onclick;
  return b;
}

function renderDetail() {
  if (state.view === 'calendar') return renderCalendarDetail();
  if (state.editing) return renderEditor();
  const e = state.entries.find((x) => x.id === state.selectedId);

  if (!e) {
    renderDetailBar([]);
    renderOverview();
    return;
  }

  const inTrash = e.deleted;
  const bar = [];
  if (inTrash) {
    bar.push(
      mkTb('还原', 'primary', async () => {
        const r = await act(API.restoreEntries([e.id]), '已还原到资料库');
        if (r) {
          applySnapshot(r);
          state.selectedId = e.id;
          renderAll();
        }
      })
    );
    bar.push(
      mkTb('彻底删除', 'danger', async () => {
        const ok = await confirmDialog({
          title: '彻底删除这条资料？',
          message: '删除后无法恢复，它的附件副本也会一并清掉。',
          okLabel: '彻底删除',
          danger: true,
        });
        if (!ok) return;
        const r = await act(API.deleteForever([e.id]));
        if (r) {
          applySnapshot(r);
          state.selectedId = null;
          renderAll();
          toast('已彻底删除', 'ok');
        }
      })
    );
  } else {
    bar.push(mkTb('编辑', 'primary', () => startEdit(e), '编辑标题、正文、日期、来源、标签'));
    bar.push(
      mkTb('复制 Markdown', null, async () => {
        const r = await act(API.exportPreview([e.id]));
        if (!r) return;
        const c = await act(API.copyText(r.markdown));
        if (c) toast('Markdown 已复制到剪贴板', 'ok');
      })
    );
    if (e.type === 'link' && e.url) {
      bar.push(mkTb('打开链接', null, () => openUrl(e.url)));
    }
    bar.push(
      mkTb('移到回收站', 'danger', async () => {
        const r = await act(API.trashEntries([e.id]), '已移到回收站');
        if (r) {
          applySnapshot(r);
          state.selectedId = null;
          renderAll();
        }
      })
    );
  }
  const sp = el('span');
  sp.className = 'spacer';
  bar.push(sp);
  renderDetailBar(bar);

  const scroll = $('#detailScroll');
  scroll.innerHTML = '';
  const inner = el('div', 'detail-inner');

  const h = el('div', 'd-title');
  h.textContent = e.title;
  inner.appendChild(h);

  const meta = el('div', 'd-meta');
  const kv = (k, v, mono) => {
    const w = el('div', 'kv');
    w.appendChild(el('span', 'k', k));
    const vv = el('span', 'v' + (mono ? ' mono' : ''), v);
    w.appendChild(vv);
    return w;
  };
  meta.appendChild(kv('类型', TYPE_LABEL[e.type]));
  if (e.format === 'markdown') meta.appendChild(kv('格式', 'Markdown'));
  meta.appendChild(kv('日期', e.date || '未填', true));
  if (e.source) meta.appendChild(kv('来源', e.source));
  if (e.category) meta.appendChild(kv('分类', e.category));
  meta.appendChild(kv('添加于', relTime(e.createdAt)));
  meta.appendChild(kv('修改于', relTime(e.updatedAt)));
  if (inTrash) meta.appendChild(kv('状态', '在回收站'));
  inner.appendChild(meta);

  if (e.tags.length) {
    const sec = el('div', 'd-section');
    sec.style.marginTop = '0';
    sec.appendChild(el('h4', null, '标签'));
    const box = el('div', 'card-tags');
    box.style.marginTop = '0';
    e.tags.forEach((t) => {
      const c = el('span', 'mini-tag', t);
      c.style.cursor = 'pointer';
      c.onclick = () => {
        state.view = 'tag:' + t;
        state.filterTag = '';
        state.selectedId = null;
        renderAll();
      };
      box.appendChild(c);
    });
    sec.appendChild(box);
    inner.appendChild(sec);
  }

  if (e.type === 'link' && e.url) {
    const sec = el('div', 'd-section');
    sec.appendChild(el('h4', null, '链接'));
    const a = el('a', 'url-box', e.url);
    a.href = '#';
    a.onclick = (ev) => {
      ev.preventDefault();
      openUrl(e.url);
    };
    sec.appendChild(a);
    inner.appendChild(sec);
  }

  const secC = el('div', 'd-section');
  secC.appendChild(el('h4', null, e.format === 'markdown' ? '内容 · Markdown' : '内容'));
  if (e.content && e.content.trim()) {
    if (e.format === 'markdown') {
      const c = el('div', 'md-body');
      c.innerHTML = mdToHtml(e.content);
      secC.appendChild(c);
    } else {
      const c = el('div', 'd-content');
      c.textContent = e.content;
      secC.appendChild(c);
    }
  } else {
    const c = el('div', 'd-content empty-hint', '（还没有填写内容）');
    secC.appendChild(c);
  }
  inner.appendChild(secC);

  if (e.attachments.length) {
    const sec = el('div', 'd-section');
    sec.appendChild(el('h4', null, `附件 · ${e.attachments.length}`));
    const list = el('div', 'att-list');
    e.attachments.forEach((a) => list.appendChild(attRow(a, { onRemove: null })));
    sec.appendChild(list);
    inner.appendChild(sec);
  }

  // 反向关联：日程里挂过这条资料的，在这里列出来
  const related = state.schedules.filter((s) => !s.deleted && (s.links || []).includes(e.id));
  if (related.length) {
    const sec = el('div', 'd-section');
    sec.appendChild(el('h4', null, `相关日程 · ${related.length}`));
    const list = el('div', 'sched-list compact');
    related
      .slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .forEach((s) => list.appendChild(scheduleRow({ schedule: s, key: s.id, date: s.date, startDate: s.date, endDate: s.endDate || s.date, days: 1 })));
    sec.appendChild(list);
    inner.appendChild(sec);
  }

  scroll.appendChild(inner);
}

/** 详情里的图片预览 */
function appendImagePreviews(container, attachments) {
  const imgs = attachments.filter((a) => a.isImage);
  for (const a of imgs) {
    const box = el('div', 'img-preview');
    const img = el('img');
    img.src = mediaUrl(a.relPath);
    img.alt = a.name;
    box.appendChild(img);
    box.onclick = () => openLightbox(a);
    container.appendChild(box);
  }
}

function attRow(a, { onRemove, onOpen } = {}) {
  const row = el('div', 'att');
  const ico = el('div', 'att-ico');
  if (a.isImage) {
    const im = el('img');
    im.src = mediaUrl(a.relPath);
    im.alt = '';
    ico.appendChild(im);
  } else {
    ico.textContent = (a.ext || '档').slice(0, 3);
  }
  const info = el('div', 'att-info');
  const nm = el('div', 'att-name', a.name);
  nm.title = a.name;
  info.appendChild(nm);
  info.appendChild(el('div', 'att-sub', `${humanSize(a.size)}${a.ext ? ' · ' + a.ext : ''}`));

  const acts = el('div', 'att-acts');
  const open = el('button', null, '打开');
  open.onclick = async (ev) => {
    ev.stopPropagation();
    if (onOpen) return onOpen(a);
    await act(API.openAttachment(a.relPath));
  };
  const reveal = el('button', null, '在访达中显示');
  reveal.onclick = async (ev) => {
    ev.stopPropagation();
    await act(API.revealAttachment(a.relPath));
  };
  const saveas = el('button', null, '另存');
  saveas.onclick = async (ev) => {
    ev.stopPropagation();
    const r = await act(API.saveAttachmentAs(a.relPath, a.name));
    if (r && !r.canceled) toast('已另存到 ' + r.path, 'ok');
  };
  acts.append(open, saveas, reveal);
  if (onRemove) {
    const rm = el('button', null, '移除');
    rm.onclick = (ev) => {
      ev.stopPropagation();
      onRemove(a);
    };
    acts.appendChild(rm);
  }
  row.append(ico, info, acts);
  row.ondblclick = async () => {
    if (onOpen) return onOpen(a);
    await act(API.openAttachment(a.relPath));
  };
  return row;
}

function openLightbox(a) {
  const overlay = el('div', 'lightbox');
  const img = el('img');
  img.src = mediaUrl(a.relPath);
  overlay.appendChild(img);
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

async function openUrl(url) {
  if (!url) return;
  const r = await act(API.openExternal(url));
  if (!r) toast('链接格式不支持，只能打开 http/https', 'err');
}

/* ---------------------------------------------------------------- 概览空态 */

function renderOverview() {
  const st = state.stats;
  const scroll = $('#detailScroll');
  scroll.innerHTML = '';
  const inner = el('div', 'detail-inner');

  const h = el('div', 'd-title', 'My Workbench');
  h.style.marginBottom = '6px';
  inner.appendChild(h);
  const sub = el('div');
  sub.style.cssText = 'font-size:12.5px;color:var(--ink-3);line-height:1.9;margin-bottom:18px';
  sub.textContent =
    state.view === 'trash'
      ? '回收站里的资料还在本机，可以随时还原。'
      : '从左侧选一条资料查看详情，或者新建一条。所有内容都保存在本机。';
  inner.appendChild(sub);

  const actions = el('div');
  actions.style.cssText = 'display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap';
  const bNew = el('button', 'tb primary', '＋ 新建资料');
  bNew.onclick = startNewFlow;
  const bSet = el('button', 'tb', '⚙ 设置与配色');
  bSet.onclick = openSettings;
  actions.append(bNew, bSet);
  inner.appendChild(actions);

  const grid = el('div', 'kv-list');
  const rows = [
    ['资料总数', `${st.total} 条`],
    ['回收站', `${st.trashed} 条`],
    ['附件', `${st.attachments} 个`],
    ['附件占用', humanSize(st.bytes)],
  ];
  rows.forEach(([k, v]) => {
    const r = el('div', 'row');
    r.appendChild(el('span', 'k', k));
    r.appendChild(el('span', 'v', v));
    grid.appendChild(r);
  });
  inner.appendChild(grid);

  const sec = el('div', 'd-section');
  sec.appendChild(el('h4', null, '资料库位置'));
  const box = el('div', 'url-box', state.libraryPath);
  box.onclick = () => act(API.openLibrary());
  sec.appendChild(box);
  const hint = el('div');
  hint.style.cssText = 'font-size:11px;color:var(--ink-4);margin-top:8px;line-height:1.8';
  hint.textContent = '数据独立于应用安装目录，重装或移动应用都不会影响这里的资料。';
  sec.appendChild(hint);
  inner.appendChild(sec);

  if (state.appInfo) {
    const sec2 = el('div', 'd-section');
    sec2.appendChild(el('h4', null, '运行环境'));
    const g2 = el('div', 'kv-list');
    [
      ['应用版本', state.appInfo.version],
      ['系统', `${state.appInfo.platform} / ${state.appInfo.arch}`],
      ['Electron', state.appInfo.electron],
      ['Node', state.appInfo.node],
    ].forEach(([k, v]) => {
      const r = el('div', 'row');
      r.appendChild(el('span', 'k', k));
      r.appendChild(el('span', 'v', v));
      g2.appendChild(r);
    });
    sec2.appendChild(g2);
    inner.appendChild(sec2);
  }

  scroll.appendChild(inner);
}

/* ---------------------------------------------------------------- 编辑态 */

function blankDraft(type, draftId) {
  return {
    isNew: true,
    id: draftId,
    type,
    title: '',
    content: '',
    format: defaultFormat(type),
    url: '',
    source: '',
    date: todayStr(),
    category: state.view.startsWith('cat:') && state.view !== 'cat:__none__' ? state.view.slice(4) : '',
    tags: [],
    attachments: [],
    pendingRelPaths: [],
    _tags: [],
  };
}

function startNewFlow() {
  const body = el('div');
  body.innerHTML = `
    <div class="type-grid">
      <button class="type-card" data-t="text"><span class="tc-ico">✎</span><span><strong>文字</strong><span>随手记下的经历、想法、片段</span></span></button>
      <button class="type-card" data-t="link"><span class="tc-ico">↗</span><span><strong>链接</strong><span>网页地址，附上你的摘要与看法</span></span></button>
      <button class="type-card" data-t="image"><span class="tc-ico">▣</span><span><strong>图片</strong><span>照片、截图，可一次选多张</span></span></button>
      <button class="type-card" data-t="file"><span class="tc-ico">🗎</span><span><strong>文件</strong><span>文档、PDF 等任意文件</span></span></button>
    </div>
    <p style="font-size:11px;color:var(--ink-4);margin-top:14px;line-height:1.8">
      图片和文件会被复制一份到资料库的 attachments 目录，原始文件保持不动。
    </p>`;
  const { close } = openModal({
    title: '新建资料',
    subtitle: '先选一个类型，接下来在右侧填写内容。',
    body,
  });

  body.querySelectorAll('.type-card').forEach((btn) => {
    btn.onclick = async () => {
      const type = btn.dataset.t;
      close();
      if (type === 'image' || type === 'file') {
        await startNewWithAttachments(type);
      } else {
        await startNewDraft(type);
      }
    };
  });
}

async function startNewDraft(type, prefillAttachments = []) {
  const r = await act(API.newDraftId());
  if (!r) return;
  const draft = blankDraft(type, r.id);
  draft.attachments = prefillAttachments.slice();
  draft.pendingRelPaths = prefillAttachments.map((a) => a.relPath);
  state.editing = draft;
  state.selectedId = null;
  renderAll();
  const input = $('#fTitle');
  if (input) input.focus();
}

async function startNewWithAttachments(type) {
  const picked = await act(API.pickFiles(type === 'image' ? 'image' : 'any'));
  if (!picked || picked.canceled || !picked.paths.length) return;
  const r = await act(API.newDraftId());
  if (!r) return;
  const draft = blankDraft(type, r.id);
  state.editing = draft;
  renderAll();
  const added = await act(API.addAttachmentPaths(draft.id, picked.paths));
  if (added) {
    draft.attachments = added.added;
    draft.pendingRelPaths = added.added.map((a) => a.relPath);
    if (!draft.title && added.added.length) {
      draft.title = added.added[0].name.replace(/\.[^.]+$/, '');
    }
    draft.content = '';
  }
  renderAll();
}

function startEdit(entry) {
  state.editing = {
    isNew: false,
    id: entry.id,
    type: entry.type,
    title: entry.title,
    content: entry.content,
    format: entry.format || 'plain',
    url: entry.url,
    source: entry.source,
    date: entry.date,
    category: entry.category,
    tags: entry.tags.slice(),
    attachments: entry.attachments.slice(),
    pendingRelPaths: [],
  };
  renderEditor();
  const input = $('#fTitle');
  if (input) input.focus();
}

function renderEditor() {
  const d = state.editing;
  const isNew = d.isNew;
  if (!d.format) d.format = defaultFormat(d.type);
  const md = d.format === 'markdown';

  const bar = [];
  bar.push(
    mkTb('保存', 'primary', saveEditing, '⌘S'),
    mkTb('取消', 'ghost', cancelEditing)
  );
  const sp = el('span');
  sp.className = 'spacer';
  bar.push(sp);
  bar.push(mkTb(isNew ? '放弃这条' : '删除', 'danger', async () => {
    if (isNew) return cancelEditing();
    const e = state.entries.find((x) => x.id === d.id);
    state.editing = null;
    renderAll();
    if (e) {
      const r = await act(API.trashEntries([e.id]), '已移到回收站');
      if (r) {
        applySnapshot(r);
        state.selectedId = null;
        renderAll();
      }
    }
  }));
  renderDetailBar(bar);

  const scroll = $('#detailScroll');
  scroll.innerHTML = '';
  const inner = el('div', 'detail-inner wide' + (state.focusMode ? ' ultra' : ''));
  const form = el('div', 'form');

  const contentField = md
    ? `<div class="field">
         <div class="field-head">
           <label>${d.type === 'link' ? '摘要 / 我的看法' : '内容'}</label>
           <div class="r">
             ${formatSeg(d.format)}
             <button type="button" class="mini-btn" id="btnFocus" title="收起两侧栏，专心写">专注</button>
           </div>
         </div>
         <div class="md-editor">
           <div class="md-toolbar" id="mdToolbar">
             <button type="button" data-md="h1" title="一级标题">H1</button>
             <button type="button" data-md="h2" title="二级标题">H2</button>
             <button type="button" data-md="h3" title="三级标题">H3</button>
             <span class="sep"></span>
             <button type="button" data-md="bold" title="粗体（⌘B）"><b>B</b></button>
             <button type="button" data-md="italic" title="斜体（⌘I）"><i>I</i></button>
             <button type="button" data-md="strike" title="删除线"><s>S</s></button>
             <button type="button" data-md="code" title="行内代码">代码</button>
             <span class="sep"></span>
             <button type="button" data-md="ul" title="无序列表">列表</button>
             <button type="button" data-md="ol" title="有序列表">编号</button>
             <button type="button" data-md="task" title="待办事项">待办</button>
             <button type="button" data-md="quote" title="引用">引用</button>
             <span class="sep"></span>
             <button type="button" data-md="link" title="链接">链接</button>
             <button type="button" data-md="table" title="插入表格">表格</button>
             <button type="button" data-md="codeblock" title="代码块">代码块</button>
             <button type="button" data-md="hr" title="分割线">分割线</button>
             <span class="grow"></span>
             <button type="button" data-md="preview" id="mdPreviewBtn" title="显示 / 隐藏右侧预览">${
               state.prefs.mdPreview ? '隐藏预览' : '显示预览'
             }</button>
           </div>
           <div class="md-split${state.prefs.mdPreview ? '' : ' preview-off'}" id="mdSplit">
             <textarea class="md-input" id="fContent" spellcheck="false" placeholder="# 标题&#10;&#10;直接写 Markdown，右边实时预览。工具栏上面的按钮可以快速插入格式。">${esc(
               d.content
             )}</textarea>
             <div class="md-preview" id="mdPreview"></div>
           </div>
         </div>
         <div class="hint">支持直接粘贴图片（⌘V），粘贴进来的图片会成为这条资料的附件。导出时按原样保留 Markdown。</div>
       </div>`
    : `<div class="field">
         <div class="field-head">
           <label>${d.type === 'link' ? '摘要 / 我的看法' : '内容'}</label>
           <div class="r">
             ${formatSeg(d.format)}
             <button type="button" class="mini-btn" id="btnFocus" title="收起两侧栏，专心写">专注</button>
           </div>
         </div>
         <textarea class="plain" id="fContent" placeholder="${
           d.type === 'image' ? '记下这张图的背景、当时的情景…' : d.type === 'file' ? '记下这份文件的要点…' : '写点什么…'
         }">${esc(d.content)}</textarea>
         <div class="hint">支持直接粘贴图片（⌘V），粘贴进来的图片会成为这条资料的附件。</div>
       </div>`;

  form.innerHTML = `
    <div class="field field-title">
      <div class="field-head">
        <label>标题</label>
      </div>
      <input type="text" id="fTitle" placeholder="给这条资料起个名字" value="${esc(d.title)}" />
    </div>
    ${
      d.type === 'link'
        ? `<div class="field">
             <label>链接地址</label>
             <input type="text" id="fUrl" placeholder="https://…" value="${esc(d.url)}" />
           </div>`
        : ''
    }
    ${contentField}
    <div class="grid-3">
      <div class="field">
        <label>日期</label>
        <input type="date" id="fDate" value="${esc(d.date)}" />
      </div>
      <div class="field">
        <label>来源</label>
        <input type="text" id="fSource" placeholder="如：某本书、某次对话" value="${esc(d.source)}" />
      </div>
      <div class="field">
        <label>分类</label>
        <select id="fCategory"></select>
      </div>
    </div>
    <div class="field">
      <label>标签</label>
      <div class="tag-editor" id="tagEditor">
        <input type="text" id="tagInput" placeholder="输入后按回车或逗号添加" />
      </div>
    </div>
    <div class="field">
      <label>附件</label>
      <div class="drop-zone" id="dropZone">
        <div>把图片或文件拖到这里</div>
        <div class="drop-btns">
          <button class="tb" id="btnPickImage" type="button">选图片</button>
          <button class="tb" id="btnPickFile" type="button">选文件</button>
        </div>
      </div>
      <div class="att-list" id="editAttList" style="margin-top:10px"></div>
      <div class="img-preview-wrap" id="editImgWrap"></div>
    </div>
  `;
  inner.appendChild(form);
  scroll.appendChild(inner);

  // 分类下拉
  const sel = $('#fCategory');
  sel.appendChild(new Option('未分类', ''));
  (state.stats.categories || []).forEach((c) => sel.appendChild(new Option(c, c)));
  if (d.category && !(state.stats.categories || []).includes(d.category)) {
    sel.appendChild(new Option(d.category, d.category));
  }
  sel.value = d.category || '';

  renderTagEditor();
  renderEditAttachments();

  // ---- 事件绑定 ----
  $('#fTitle').oninput = (e) => (d.title = e.target.value);
  const fUrl = $('#fUrl');
  if (fUrl) fUrl.oninput = (e) => (d.url = e.target.value);
  $('#fDate').onchange = (e) => (d.date = e.target.value || todayStr());
  $('#fSource').oninput = (e) => (d.source = e.target.value);
  sel.onchange = (e) => (d.category = e.target.value);

  // 纯文本 / Markdown 切换
  document.querySelectorAll('#contentSeg button').forEach((b) => {
    b.onclick = () => setFormat(b.dataset.f);
  });
  const focusBtn = $('#btnFocus');
  if (focusBtn) {
    focusBtn.classList.toggle('on', !!state.focusMode);
    focusBtn.onclick = toggleFocus;
  }

  const ta = $('#fContent');
  let timer = 0;
  if (md) {
    syncMdPreview();
    ta.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(syncMdPreview, 90);
    });
    document.querySelectorAll('#mdToolbar button[data-md]').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.md === 'preview') return toggleMdPreview();
        insertMd(b.dataset.md);
      };
    });
    ta.addEventListener('keydown', (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        insertMd('bold');
      } else if (meta && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        insertMd('italic');
      } else if (e.key === 'Tab') {
        e.preventDefault();
        insertMd('tab');
      } else if (meta && e.key === 's') {
        e.preventDefault();
        saveEditing();
      }
    });
  } else {
    ta.oninput = (e) => (d.content = e.target.value);
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveEditing();
      }
    });
  }
  ta.addEventListener('paste', onPasteImage);

  $('#fTitle').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      saveEditing();
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      ta.focus();
    }
  });

  $('#btnPickImage').onclick = () => pickInto('image');
  $('#btnPickFile').onclick = () => pickInto('any');
  const dz = $('#dropZone');
  dz.onclick = (e) => {
    if (e.target.tagName === 'BUTTON') return;
    pickInto('any');
  };
  setupDrop(dz);
}

function defaultFormat(type) {
  return state.prefs.lastFormat || (type === 'text' ? 'markdown' : 'plain');
}

function formatSeg(current) {
  return `<div class="seg" id="contentSeg">
    <button type="button" data-f="plain" class="${current === 'plain' ? 'on' : ''}">纯文本</button>
    <button type="button" data-f="markdown" class="${current === 'markdown' ? 'on' : ''}">Markdown</button>
  </div>`;
}

/** 只切换格式，内容原样保留 */
function setFormat(f) {
  const d = state.editing;
  if (!d || d.format === f) return;
  const ta = $('#fContent');
  if (ta) d.content = ta.value;
  d.format = f;
  setPrefs({ lastFormat: f });
  renderEditor();
  const box = $('#fContent');
  if (box) box.focus();
}

function toggleMdPreview() {
  const on = !state.prefs.mdPreview;
  setPrefs({ mdPreview: on });
  const split = $('#mdSplit');
  const btn = $('#mdPreviewBtn');
  if (split) split.classList.toggle('preview-off', !on);
  if (btn) btn.textContent = on ? '隐藏预览' : '显示预览';
  if (on) syncMdPreview();
}

function syncMdPreview() {
  const d = state.editing;
  const ta = $('#fContent');
  if (!d || !ta) return;
  d.content = ta.value;
  const box = $('#mdPreview');
  if (!box || !state.prefs.mdPreview) return;
  const text = ta.value;
  box.innerHTML = text.trim()
    ? mdToHtml(text)
    : '<div class="md-empty">左边写点什么，这里会实时显示渲染效果。</div>';
}

/** Markdown 工具栏：按选区或当前行插入格式 */
function insertMd(kind) {
  const ta = $('#fContent');
  if (!ta) return;
  const val = ta.value;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const sel = val.slice(s, e);

  const apply = (from, to, text, selFrom, selTo) => {
    ta.value = val.slice(0, from) + text + val.slice(to);
    const a = from + (selFrom == null ? text.length : selFrom);
    const b = from + (selTo == null ? text.length : selTo);
    ta.setSelectionRange(a, b);
    ta.focus();
    syncMdPreview();
  };

  // 逐行加前缀（标题、列表、引用…）
  const prefixLines = (make) => {
    let from = s;
    let to = e;
    if (s === e) {
      from = val.lastIndexOf('\n', s - 1) + 1;
      const nl = val.indexOf('\n', s);
      to = nl === -1 ? val.length : nl;
    }
    const block = val.slice(from, to) || '';
    const lines = block.split('\n');
    const out = lines.map((l, i) => make(l, i)).join('\n');
    apply(from, to, out, 0, out.length);
  };

  switch (kind) {
    case 'h1':
    case 'h2':
    case 'h3': {
      const hashes = '#'.repeat(Number(kind[1]));
      prefixLines((l) => {
        const stripped = l.replace(/^#{1,6}\s+/, '');
        return `${hashes} ${stripped}`;
      });
      break;
    }
    case 'ul':
      prefixLines((l) => (l.startsWith('- ') ? l : `- ${l.replace(/^[-*+]\s+/, '')}`));
      break;
    case 'ol':
      prefixLines((l, i) => (l.match(/^\d+[.)]\s+/) ? l : `${i + 1}. ${l}`));
      break;
    case 'task':
      prefixLines((l) => (l.startsWith('- [') ? l : `- [ ] ${l.replace(/^[-*+]\s+/, '')}`));
      break;
    case 'quote':
      prefixLines((l) => (l.startsWith('> ') ? l : `> ${l}`));
      break;
    case 'bold':
      apply(s, e, `**${sel || '粗体'}**`, 2, 2 + (sel || '粗体').length);
      break;
    case 'italic':
      apply(s, e, `*${sel || '斜体'}*`, 1, 1 + (sel || '斜体').length);
      break;
    case 'strike':
      apply(s, e, `~~${sel || '删除线'}~~`, 2, 2 + (sel || '删除线').length);
      break;
    case 'code':
      apply(s, e, '`' + (sel || '代码') + '`', 1, 1 + (sel || '代码').length);
      break;
    case 'link':
      apply(s, e, `[${sel || '链接文字'}](https://)`, sel ? sel.length + 3 : 1, sel ? sel.length + 11 : 11);
      break;
    case 'codeblock': {
      const body = sel || '';
      const text = '```\n' + body + '\n```\n';
      apply(s, e, text, 4, 4 + body.length);
      break;
    }
    case 'table':
      apply(s, e, '\n| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n', null, null);
      break;
    case 'hr':
      apply(s, e, '\n---\n', null, null);
      break;
    case 'tab':
      apply(s, e, '  ', null, null);
      break;
    default:
      break;
  }
}

/** 专注：把左右两栏都收起来，只留编辑区 */
function toggleFocus() {
  state.focusMode = !state.focusMode;
  applyPrefs();
  const inner = document.querySelector('#detailScroll .detail-inner');
  if (inner) inner.classList.toggle('ultra', state.focusMode);
  const btn = $('#btnFocus');
  if (btn) btn.classList.toggle('on', state.focusMode);
  if (state.focusMode) toast('已进入专注编辑，再点一次「专注」退出');
}

function renderTagEditor() {
  const d = state.editing;
  const box = $('#tagEditor');
  if (!box) return;
  box.querySelectorAll('.t').forEach((n) => n.remove());
  const input = $('#tagInput');
  d.tags.forEach((t) => {
    const chip = el('span', 't');
    chip.appendChild(document.createTextNode(t));
    const x = el('button', null, '✕');
    x.onclick = () => {
      d.tags = d.tags.filter((v) => v !== t);
      renderTagEditor();
    };
    chip.appendChild(x);
    box.insertBefore(chip, input);
  });
  input.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      commitTag();
    } else if (e.key === 'Backspace' && !input.value && d.tags.length) {
      d.tags.pop();
      renderTagEditor();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      saveEditing();
    }
  };
  input.onblur = commitTag;
  function commitTag() {
    const v = input.value.trim().replace(/^#/, '');
    if (v) {
      const parts = v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      parts.forEach((p) => {
        if (!d.tags.includes(p)) d.tags.push(p);
      });
    }
    input.value = '';
    renderTagEditor();
  }
}

function renderEditAttachments() {
  const d = state.editing;
  const list = $('#editAttList');
  const wrap = $('#editImgWrap');
  if (!list) return;
  list.innerHTML = '';
  wrap.innerHTML = '';
  if (!d.attachments.length) return;
  d.attachments.forEach((a) => {
    list.appendChild(
      attRow(a, {
        onOpen: async () => {
          await act(API.openAttachment(a.relPath));
        },
        onRemove: async (att) => {
          d.attachments = d.attachments.filter((x) => x.id !== att.id);
          if (!d.pendingRelPaths.includes(att.relPath)) d.pendingRelPaths.push(att.relPath);
          renderEditAttachments();
        },
      })
    );
  });
  const imgs = d.attachments.filter((a) => a.isImage);
  if (imgs.length) {
    const sec = el('div', 'd-section');
    sec.style.marginTop = '12px';
    sec.appendChild(el('h4', null, '图片预览'));
    appendImagePreviews(sec, imgs);
    wrap.appendChild(sec);
  }
}

async function pickInto(kind) {
  const d = state.editing;
  if (!d) return;
  const picked = await act(API.pickFiles(kind));
  if (!picked || picked.canceled || !picked.paths.length) return;
  await addPathsToDraft(picked.paths);
}

async function addPathsToDraft(paths) {
  const d = state.editing;
  if (!d || !paths.length) return;
  const r = await act(API.addAttachmentPaths(d.id, paths));
  if (!r) return;
  const added = r.added || [];
  if (!added.length) {
    toast('这些文件没能加入（可能不是文件或没有权限）', 'err');
    return;
  }
  added.forEach((a) => {
    d.attachments.push(a);
    d.pendingRelPaths.push(a.relPath);
  });
  if (!d.title && d.isNew) d.title = added[0].name.replace(/\.[^.]+$/, '');
  if (d.type !== 'image' && d.type !== 'file' && d.isNew) {
    // 文字 / 链接类型加入附件时不改类型，仅作为附件
  }
  renderEditor();
  toast(`已加入 ${added.length} 个附件`, 'ok');
}

function setupDrop(zone) {
  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  ['dragenter', 'dragover'].forEach((t) =>
    zone.addEventListener(t, (e) => {
      stop(e);
      zone.classList.add('hot');
    })
  );
  ['dragleave', 'drop'].forEach((t) =>
    zone.addEventListener(t, (e) => {
      stop(e);
      zone.classList.remove('hot');
    })
  );
  zone.addEventListener('drop', async (e) => {
    const files = Array.from(e.dataTransfer.files || []);
    const paths = files.map((f) => API.pathForFile(f)).filter(Boolean);
    if (!paths.length) return toast('没能读取到文件路径', 'err');
    await addPathsToDraft(paths);
  });
}

async function onPasteImage(e) {
  const d = state.editing;
  if (!d) return;
  const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
  const imgItem = items.find((i) => i.type && i.type.startsWith('image/'));
  if (!imgItem) return; // 普通文本粘贴，交给浏览器默认行为
  e.preventDefault();
  const file = imgItem.getAsFile();
  if (!file) return;
  const buf = await file.arrayBuffer();
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const name = `粘贴图片_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.${ext}`;
  const r = await act(API.addAttachmentBuffer(d.id, buf, name));
  if (!r) return;
  const a = r.added[0];
  d.attachments.push(a);
  d.pendingRelPaths.push(a.relPath);
  renderEditor();
  toast('图片已作为附件加入', 'ok');
}

async function saveEditing() {
  const d = state.editing;
  if (!d) return;
  const title = (d.title || '').trim();
  if (!title && !d.content.trim() && !d.attachments.length && !d.url.trim()) {
    return toast('至少写点内容或加个附件再保存', 'err');
  }
  const payload = {
    type: d.type,
    title: title || autoTitle(d),
    content: d.content,
    format: d.format === 'markdown' ? 'markdown' : 'plain',
    url: d.url.trim(),
    source: d.source.trim(),
    date: d.date || todayStr(),
    category: d.category || '',
    tags: d.tags.slice(),
    attachments: d.attachments,
  };
  let r;
  if (d.isNew) {
    r = await act(API.createEntry({ ...payload, id: d.id }));
  } else {
    r = await act(API.updateEntry(d.id, payload));
  }
  if (!r) return;
  // 移除被用户删掉的附件文件
  const removed = (d.pendingRelPaths || []).filter(
    (p) => !d.attachments.some((a) => a.relPath === p)
  );
  if (removed.length) await act(API.cleanupAttachments(removed));

  applySnapshot(r);
  state.selectedId = d.id;
  state.editing = null;
  renderAll();
  toast(d.isNew ? '已存进档案馆' : '已保存', 'ok');
}

function autoTitle(d) {
  if (d.attachments.length) return d.attachments[0].name.replace(/\.[^.]+$/, '');
  if (d.url) {
    try {
      return new URL(d.url).hostname.replace(/^www\./, '');
    } catch {
      return d.url.slice(0, 40);
    }
  }
  const first = (d.content || '')
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s);
  return first ? first.slice(0, 40) : '未命名资料';
}

async function cancelEditing() {
  const d = state.editing;
  if (!d) return;
  state.editing = null;
  if (d.isNew) {
    await act(API.discardDraft(d.id));
  } else if (d.pendingRelPaths.length) {
    await act(API.cleanupAttachments(d.pendingRelPaths));
  }
  renderAll();
}

/**
 * 用户在编辑途中直接点了别的资料 / 分类 / 标签时调用：
 * 同步把编辑态丢掉，同时把这次会话新增的附件副本清掉，不留孤儿文件。
 */
function abandonEditing() {
  const d = state.editing;
  state.editing = null;
  if (!d) return;
  if (d.isNew) {
    API.discardDraft(d.id).catch(() => {});
  } else if (d.pendingRelPaths.length) {
    API.cleanupAttachments(d.pendingRelPaths).catch(() => {});
  }
}

/* ---------------------------------------------------------------- 导出 / 备份 */

function openExportDialog(ids) {
  if (!ids.length) return toast('先勾选要导出的资料', 'err');
  const body = el('div');
  body.innerHTML = `
    <p style="font-size:12.5px;color:var(--ink-2);margin-bottom:14px">
      将导出 <strong>${ids.length}</strong> 条资料。导出的 Markdown 会保留标题、类型、日期、来源、分类、标签、链接、正文与附件清单。
    </p>
    <label class="opt-row">
      <input type="radio" name="expMode" value="combined" checked />
      <span><span class="t">合并成一个 Markdown 文件</span><span class="d">适合一次性把多条资料交给 AI 阅读。</span></span>
    </label>
    <label class="opt-row">
      <input type="radio" name="expMode" value="perEntry" />
      <span><span class="t">每条资料一个 Markdown 文件</span><span class="d">导出到指定目录，便于分类存放。</span></span>
    </label>
    <label class="opt-row" style="margin-top:14px">
      <input type="checkbox" id="expAtt" checked />
      <span><span class="t">同时复制附件文件</span><span class="d">把附件副本一并复制到导出位置，Markdown 里的链接就能直接打开。</span></span>
    </label>
    <label class="opt-row">
      <input type="checkbox" id="expSched" />
      <span><span class="t">附带相关日程</span><span class="d">在有关联日程的资料下面多一段「相关日程」，交给 AI 时能同时看到记录和安排。</span></span>
    </label>`;
  const foot = el('div');
  foot.style.cssText = 'display:flex;gap:8px;width:100%';
  const prev = el('button', 'tb', '预览内容');
  const sp = el('span');
  sp.style.flex = '1';
  const cancel = el('button', 'tb', '取消');
  const ok = el('button', 'tb primary', '选择位置并导出');
  foot.append(prev, sp, cancel, ok);

  const { close } = openModal({ title: '导出 Markdown', body, footer: foot });
  cancel.onclick = close;

  prev.onclick = async () => {
    const includeSchedules = body.querySelector('#expSched').checked;
    const r = await act(API.exportPreview(ids, { includeSchedules }));
    if (!r) return;
    const pre = el('pre', 'preview-md', r.markdown);
    const { close: c2 } = openModal({
      title: '导出内容预览',
      subtitle: '这是将要写入 Markdown 的完整文本。',
      body: pre,
      wide: true,
      footer: (() => {
        const f = el('div');
        f.style.cssText = 'display:flex;gap:8px;width:100%';
        const sp2 = el('span');
        sp2.style.flex = '1';
        const copy = el('button', 'tb', '复制到剪贴板');
        copy.onclick = async () => {
          const cc = await act(API.copyText(r.markdown));
          if (cc) toast('已复制', 'ok');
        };
        const closeBtn = el('button', 'tb primary', '关闭');
        closeBtn.onclick = () => c2();
        f.append(copy, sp2, closeBtn);
        return f;
      })(),
    });
  };

  ok.onclick = async () => {
    const mode = body.querySelector('input[name="expMode"]:checked').value;
    const copyAttachments = body.querySelector('#expAtt').checked;
    const includeSchedules = body.querySelector('#expSched').checked;
    close();
    const r = await act(API.exportMarkdown(ids, { mode, copyAttachments, includeSchedules }));
    if (!r || r.canceled) return;
    if (r.mode === 'combined') {
      toast(`已导出 ${r.entries} 条到 ${r.path.split('/').pop()}`, 'ok');
    } else {
      toast(`已导出 ${r.entries} 个 Markdown 文件`, 'ok');
    }
    const okGo = await confirmDialog({
      title: '导出完成',
      message: `位置：${r.path}${r.copied ? `\n附件副本：${r.copied} 个` : ''}`,
      okLabel: '打开导出位置',
    });
    if (okGo) await act(API.revealPath(r.path));
  };
}

/** 备份：默认直接写进资料库的 backups/，也可以另存到别的位置 */
async function doBackup({ toLibrary = true } = {}) {
  const r = toLibrary ? await act(API.backupToLibrary()) : await act(API.createBackup());
  if (!r || r.canceled) return null;
  if (toLibrary) {
    const ok = await confirmDialog({
      title: '备份完成',
      message: `已存进资料库的 backups/ 目录。\n包含 ${r.files} 个文件，共 ${humanSize(r.bytes)}。`,
      okLabel: '在访达中显示',
    });
    if (ok) await act(API.revealPath(r.path));
    refreshBackupList();
  } else {
    const ok = await confirmDialog({
      title: '备份完成',
      message: `备份包：${r.path}\n包含 ${r.files} 个文件，共 ${humanSize(r.bytes)}。`,
      okLabel: '在访达中显示',
    });
    if (ok) await act(API.revealPath(r.path));
  }
  return r;
}

/* ---------------------------------------------------------------- 设置面板 */

async function openSettings() {
  const body = el('div');

  const themes = THEME_ORDER.map(
    (k) => `
    <button type="button" class="theme-card${state.prefs.theme === k ? ' on' : ''}" data-theme="${k}">
      <span class="theme-swatch" style="background:linear-gradient(135deg, ${THEMES[k].swatch[0]} 0 50%, ${THEMES[k].swatch[1]} 50% 100%)"></span>
      <span class="theme-name">${esc(THEMES[k].name)}</span>
    </button>`
  ).join('');

  body.innerHTML = `
    <div class="set-section">
      <h4>配色主题</h4>
      <div class="theme-grid" id="themeGrid">${themes}</div>
    </div>

    <div class="set-section">
      <h4>备份与恢复</h4>
      <div class="bk-actions">
        <button class="tb primary" id="setBackup">立即备份</button>
        <button class="tb" id="setBackupAs">备份到其他位置…</button>
        <button class="tb" id="setRestore">从备份恢复…</button>
      </div>
      <div class="bk-list" id="bkList"></div>
      <div class="set-note">
        备份会打包成 zip，包含全部资料与附件副本。恢复时会用备份内容整体替换当前资料库，
        并把恢复前的内容留一份到 backups/ 里兜底。
      </div>
    </div>

    <div class="set-section">
      <h4>资料库位置</h4>
      <div class="set-row">
        <div class="set-info">
          <div class="set-t">数据保存在本机</div>
          <div class="set-d" id="setLibPath">${esc(state.libraryPath)}</div>
        </div>
        <button class="tb" id="setOpenLib">打开</button>
        <button class="tb" id="setChangeLib">更换</button>
      </div>
    </div>

    <div class="set-section">
      <h4>日历与日程</h4>
      <label class="set-row" style="cursor:pointer">
        <div class="set-info">
          <div class="set-t">提醒同时走 macOS 通知中心</div>
          <div class="set-d">关掉之后只在应用内弹提示条。注意：应用没打开时不会提醒 —— 这是本地离线应用的物理限制。</div>
        </div>
        <input type="checkbox" id="setNotify" ${state.prefs.notify ? 'checked' : ''} style="accent-color:var(--moss);width:16px;height:16px" />
      </label>
      <div class="set-row">
        <div class="set-info">
          <div class="set-t">导出日程</div>
          <div class="set-d">导出标准 .ics 文件，可导进 macOS 日历、Google 日历；重复日程会展开成具体时间。</div>
        </div>
        <button class="tb" id="setExportIcs">导出 .ics…</button>
      </div>
      <div class="set-note">
        日程与资料存在同一个 archive.json 里，所以备份、恢复、迁移都会自动带上它们，不需要单独操作。
      </div>
    </div>

    <div class="set-section">
      <h4>显示</h4>
      <label class="set-row" style="cursor:pointer">
        <div class="set-info">
          <div class="set-t">Markdown 编辑器默认显示右侧预览</div>
          <div class="set-d">关掉之后，编辑器里只留书写区，需要时再点工具栏的「显示预览」。</div>
        </div>
        <input type="checkbox" id="setMdPreview" ${state.prefs.mdPreview ? 'checked' : ''} style="accent-color:var(--moss);width:16px;height:16px" />
      </label>
      <div class="set-row">
        <div class="set-info">
          <div class="set-t">两侧栏</div>
          <div class="set-d">左侧分类栏与中间列表栏都可以收起，快捷键 ⌘1 / ⌘2。</div>
        </div>
        <button class="tb" id="setToggleSide">${state.prefs.sidebarCollapsed ? '展开分类栏' : '收起分类栏'}</button>
        <button class="tb" id="setToggleList">${state.prefs.listCollapsed ? '展开列表栏' : '收起列表栏'}</button>
      </div>
    </div>

    <div class="set-section" id="fsSection">
      <h4>飞书日历同步</h4>
      <div class="set-note">
        把飞书<strong>主日历</strong>的日程拉进 My Workbench（自动或手动），也可以把本机手动创建的日程推回飞书。
        需要先在飞书开放平台给这个应用开通日历权限（读取 / 读取日程 / 更新日程），并在「重定向 URL」里加上
        <code>http://127.0.0.1:18925/callback</code>。
      </div>
      <div class="set-row fs-row">
        <div class="set-info"><div class="set-t">App ID</div></div>
        <input type="text" id="fsAppId" class="fs-input" placeholder="cli_xxxxxxxx" autocomplete="off" />
      </div>
      <div class="set-row fs-row">
        <div class="set-info"><div class="set-t">App Secret</div></div>
        <input type="password" id="fsAppSecret" class="fs-input" placeholder="如已填过可留空" autocomplete="off" />
      </div>
      <div class="set-row fs-row">
        <div class="set-info">
          <div class="set-t">回调端口</div>
          <div class="set-d">飞书「重定向 URL」填 http://127.0.0.1:&lt;端口&gt;/callback</div>
        </div>
        <input type="number" id="fsPort" class="fs-input" value="18925" style="max-width:96px" />
      </div>
      <div class="set-row" style="align-items:center">
        <div class="set-info">
          <div class="set-t" id="fsLoginState">未登录</div>
          <div class="set-d" id="fsSyncInfo"></div>
        </div>
        <button class="tb primary" id="fsLogin">登录飞书</button>
        <button class="tb" id="fsLogout">退出</button>
      </div>
      <label class="set-row" style="cursor:pointer">
        <div class="set-info"><div class="set-t">自动从飞书拉取</div><div class="set-d">应用启动时 + 每 30 分钟自动拉取一次（仅拉取，不推送）。</div></div>
        <input type="checkbox" id="fsAuto" style="accent-color:var(--moss);width:16px;height:16px" />
      </label>
      <div class="bk-actions">
        <button class="tb" id="fsPull">从飞书同步（拉取）</button>
        <button class="tb" id="fsPush">推送到飞书</button>
      </div>
    </div>

    <div class="set-section">
      <h4>关于</h4>
      <div class="kv-list">
        <div class="row"><span class="k">应用</span><span class="v">${esc(
          (state.appInfo && state.appInfo.name) || 'My Workbench'
        )} ${esc(state.appInfo ? state.appInfo.version : '')}</span></div>
        <div class="row"><span class="k">运行环境</span><span class="v">${
          state.appInfo ? `${state.appInfo.platform} / ${state.appInfo.arch} · Electron ${state.appInfo.electron} · Node ${state.appInfo.node}` : ''
        }</span></div>
        <div class="row"><span class="k">配置目录</span><span class="v">${esc(
          state.appInfo ? state.appInfo.userData : ''
        )}</span></div>
      </div>
    </div>
  `;

  const closeBtn = el('button', 'modal-close', '✕');
  closeBtn.title = '关闭';
  const foot = el('div');
  foot.style.cssText = 'display:flex;gap:8px;width:100%';
  const note = el('span', null, '设置会自动保存，随时可以改。');
  note.style.cssText = 'font-size:11.5px;color:var(--ink-4);align-self:center;flex:1';
  const done = el('button', 'tb primary', '完成');
  foot.append(note, done);

  const { modal, close } = openModal({ title: '设置', body, footer: foot, wide: true });
  modal.appendChild(closeBtn);
  closeBtn.onclick = close;
  done.onclick = close;

  // 主题
  body.querySelectorAll('.theme-card').forEach((card) => {
    card.onclick = () => {
      body.querySelectorAll('.theme-card').forEach((c) => c.classList.remove('on'));
      card.classList.add('on');
      setPrefs({ theme: card.dataset.theme });
      toast('已切换到「' + THEMES[card.dataset.theme].name + '」', 'ok');
    };
  });

  // 备份 / 恢复
  body.querySelector('#setBackup').onclick = () => doBackup({ toLibrary: true });
  body.querySelector('#setBackupAs').onclick = () => doBackup({ toLibrary: false });
  body.querySelector('#setRestore').onclick = async () => {
    close();
    await doRestore();
    openSettings();
  };

  // 资料库
  body.querySelector('#setOpenLib').onclick = () => act(API.openLibrary());
  body.querySelector('#setChangeLib').onclick = async () => {
    close();
    await changeLibraryFlow();
    openSettings();
  };

  // 日历与日程
  body.querySelector('#setNotify').onchange = (e) => {
    setPrefs({ notify: e.target.checked });
    toast(e.target.checked ? '提醒会同时发到 macOS 通知中心' : '只在应用内提示', 'ok');
  };
  body.querySelector('#setExportIcs').onclick = () => exportIcsFlow();

  // 显示
  body.querySelector('#setMdPreview').onchange = (e) => {
    setPrefs({ mdPreview: e.target.checked });
    if (state.editing) {
      const split = $('#mdSplit');
      const btn = $('#mdPreviewBtn');
      if (split) split.classList.toggle('preview-off', !e.target.checked);
      if (btn) btn.textContent = e.target.checked ? '隐藏预览' : '显示预览';
      if (e.target.checked) syncMdPreview();
    }
  };
  const ts = body.querySelector('#setToggleSide');
  ts.onclick = () => {
    toggleSidebar();
    ts.textContent = state.prefs.sidebarCollapsed ? '展开分类栏' : '收起分类栏';
  };
  const tl = body.querySelector('#setToggleList');
  tl.onclick = () => {
    toggleList();
    tl.textContent = state.prefs.listCollapsed ? '展开列表栏' : '收起列表栏';
  };

  // 飞书日历同步
  const fsState = body.querySelector('#fsLoginState');
  const fsInfo = body.querySelector('#fsSyncInfo');
  const fsLoginBtn = body.querySelector('#fsLogin');
  const fsLogoutBtn = body.querySelector('#fsLogout');
  const fsAuto = body.querySelector('#fsAuto');
  const fsAppId = body.querySelector('#fsAppId');
  const fsAppSecret = body.querySelector('#fsAppSecret');
  const fsPort = body.querySelector('#fsPort');
  const fsPull = body.querySelector('#fsPull');
  const fsPush = body.querySelector('#fsPush');

  const fmtSyncInfo = (cfg) => {
    const parts = [];
    if (cfg.lastPullAt) parts.push('上次拉取 ' + relTime(cfg.lastPullAt));
    if (cfg.lastPushAt) parts.push('上次推送 ' + relTime(cfg.lastPushAt));
    if (cfg.lastError) parts.push('⚠️ ' + cfg.lastError);
    return parts.join(' · ');
  };

  const refreshFs = async () => {
    const r = await act(API.feishu.getConfig());
    if (!r) return;
    const cfg = r.config || {};
    if (fsAppId) fsAppId.value = cfg.appId || '';
    if (fsPort) fsPort.value = cfg.redirectPort || 18925;
    if (fsAuto) fsAuto.checked = !!cfg.autoSync;
    const loggedIn = !!cfg.loggedIn;
    if (fsState) fsState.textContent = loggedIn ? '已登录飞书' : '未登录';
    if (fsInfo) fsInfo.textContent = fmtSyncInfo(cfg);
    if (fsLoginBtn) fsLoginBtn.style.display = loggedIn ? 'none' : '';
    if (fsLogoutBtn) fsLogoutBtn.style.display = loggedIn ? '' : 'none';
    if (fsPull) fsPull.disabled = !loggedIn;
    if (fsPush) fsPush.disabled = !loggedIn;
  };

  if (fsAppId) fsAppId.onchange = () => act(API.feishu.saveConfig({ appId: fsAppId.value.trim() }));
  if (fsAppSecret) fsAppSecret.onchange = () => {
    const v = fsAppSecret.value.trim();
    if (!v) return;
    act(API.feishu.saveConfig({ appSecret: v }));
    fsAppSecret.value = '';
  };
  if (fsPort) fsPort.onchange = () => {
    const n = parseInt(fsPort.value, 10);
    act(API.feishu.saveConfig({ redirectPort: Number.isFinite(n) && n > 0 ? n : 18925 }));
  };
  if (fsAuto) fsAuto.onchange = () => act(API.feishu.saveConfig({ autoSync: fsAuto.checked }));
  if (fsLoginBtn) fsLoginBtn.onclick = async () => {
    fsLoginBtn.disabled = true;
    await act(API.feishu.login());
    fsLoginBtn.disabled = false;
    await refreshFs();
  };
  if (fsLogoutBtn) fsLogoutBtn.onclick = async () => {
    const ok = await confirmDialog({
      title: '退出飞书登录？',
      message: '本地保存的飞书令牌会被清除；已经拉进 My Workbench 的日程会原样保留。',
      okLabel: '退出',
    });
    if (!ok) return;
    await act(API.feishu.logout());
    await refreshFs();
  };
  const doSync = async (kind) => {
    const btn = kind === 'pull' ? fsPull : fsPush;
    if (btn) btn.disabled = true;
    const r = await act(kind === 'pull' ? API.feishu.pull() : API.feishu.push());
    if (btn) btn.disabled = false;
    if (r) {
      applySnapshot(r);
      renderAll();
      await refreshFs();
    }
  };
  if (fsPull) fsPull.onclick = () => doSync('pull');
  if (fsPush) fsPush.onclick = () => doSync('push');

  await refreshFs();

  refreshBackupList();
}

async function refreshBackupList() {
  const box = document.querySelector('#bkList');
  if (!box) return;
  const r = await act(API.listBackups());
  if (!r) return;
  const items = (r.items || []).filter((x) => !x.isDir && x.name.endsWith('.zip'));
  if (!items.length) {
    box.innerHTML = '<div class="bk-empty">还没有备份，点「立即备份」创建。</div>';
    return;
  }
  box.innerHTML = '';
  items.slice(0, 8).forEach((it) => {
    const row = el('div', 'bk-item');
    row.innerHTML = `
      <span class="bk-ico">🗜</span>
      <span class="bk-main">
        <span class="bk-name">${esc(it.name)}</span>
        <span class="bk-sub">${humanSize(it.size)} · ${relTime(new Date(it.mtime).toISOString())}</span>
      </span>
      <span class="bk-acts"></span>`;
    const acts = row.querySelector('.bk-acts');
    const reveal = el('button', null, '在访达中显示');
    reveal.onclick = () => act(API.revealPath(it.path));
    const use = el('button', null, '用这个恢复');
    use.onclick = async () => {
      closeModal();
      await doRestore(it.path);
      openSettings();
    };
    acts.append(reveal, use);
    box.appendChild(row);
  });
}

async function doRestore(zipPath) {
  const info = zipPath ? await act(API.inspectPath(zipPath)) : await act(API.inspectBackup());
  if (!info || info.canceled) return;

  const body = el('div');
  body.innerHTML = `
    <p style="font-size:12.5px;color:var(--ink-2);margin-bottom:12px;line-height:1.8">
      这是一个<strong>My Workbench</strong>备份包，可以恢复。
    </p>
    <div class="kv-list">
      <div class="row"><span class="k">文件</span><span class="v">${esc(info.path.split('/').pop())}</span></div>
      <div class="row"><span class="k">资料条数</span><span class="v">${info.entries} 条（其中未删除 ${info.active} 条）</span></div>
      <div class="row"><span class="k">包含文件</span><span class="v">${info.files} 个</span></div>
      <div class="row"><span class="k">备份时间</span><span class="v">${esc(info.createdAt || '未知')}</span></div>
    </div>
    <p style="font-size:11.5px;color:var(--danger);margin-top:14px;line-height:1.8">
      ⚠️ 恢复会用备份内容<strong>整体替换</strong>当前资料库（${state.stats.total} 条资料、${state.stats.trashed} 条回收站内容）。
      恢复前，当前内容会自动留存到 backups/ 目录下的保险副本里。
    </p>`;
  const foot = el('div');
  foot.style.cssText = 'display:flex;gap:8px;width:100%';
  const sp = el('span');
  sp.style.flex = '1';
  const cancel = el('button', 'tb', '取消');
  const ok = el('button', 'tb danger', '确认恢复');
  foot.append(sp, cancel, ok);
  const { close } = openModal({ title: '从备份恢复', body, footer: foot, wide: true });
  cancel.onclick = close;
  ok.onclick = async () => {
    close();
    const r = await act(API.restoreBackup(info.path));
    if (!r || r.canceled) return;
    applySnapshot(r);
    state.selectedId = null;
    state.editing = null;
    state.checked.clear();
    renderAll();
    toast(`已恢复 ${r.entries} 条资料、${r.attachments} 个附件`, 'ok');
  };
}

/* ---------------------------------------------------------------- 全量渲染 */

function renderAll() {
  renderSidebar();
  renderListControls();
  renderList();
  renderDetail();
}

/* ---------------------------------------------------------------- 事件绑定 */

function bindEvents() {
  $('#btnNew').onclick = startNewFlow;

  $('#searchInput').addEventListener('input', (e) => {
    const v = e.target.value;
    clearTimeout(bindEvents._t);
    bindEvents._t = setTimeout(() => {
      state.q = v.trim();
      state.selectedId = null;
      renderListControls();
      renderList();
    }, 130);
  });
  $('#searchClear').onclick = () => {
    state.q = '';
    $('#searchInput').value = '';
    renderListControls();
    renderList();
    $('#searchInput').focus();
  };
  $('#searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#searchClear').click();
    }
  });

  $('#filterType').onchange = (e) => {
    state.filterType = e.target.value;
    renderListControls();
    renderList();
  };
  $('#filterTag').onchange = (e) => {
    state.filterTag = e.target.value;
    renderListControls();
    renderList();
  };
  $('#filterDate').onchange = (e) => {
    state.filterDate = e.target.value;
    renderListControls();
    renderList();
  };
  $('#sortBy').onchange = (e) => {
    state.sort = e.target.value;
    renderList();
  };
  $('#btnClearFilters').onclick = () => {
    state.q = '';
    state.filterType = '';
    state.filterTag = '';
    state.filterDate = '';
    $('#searchInput').value = '';
    renderListControls();
    renderList();
  };

  $('#checkAll').onchange = (e) => {
    if (e.target.checked) state.lastVisible.forEach((x) => state.checked.add(x.id));
    else state.checked.clear();
    renderList();
  };

  $('#btnExport').onclick = () => openExportDialog([...state.checked]);
  $('#btnBulkTrash').onclick = async () => {
    const ids = [...state.checked];
    if (!ids.length) return;
    const ok = await confirmDialog({
      title: `把选中的 ${ids.length} 条移到回收站？`,
      message: '之后可以在回收站里还原。',
      okLabel: '移到回收站',
    });
    if (!ok) return;
    const r = await act(API.trashEntries(ids), `已移入回收站（${ids.length} 条）`);
    if (r) {
      applySnapshot(r);
      state.checked.clear();
      if (ids.includes(state.selectedId)) state.selectedId = null;
      renderAll();
    }
  };
  $('#btnBulkRestore').onclick = async () => {
    const ids = [...state.checked];
    const r = await act(API.restoreEntries(ids), `已还原 ${ids.length} 条`);
    if (r) {
      applySnapshot(r);
      state.checked.clear();
      renderAll();
    }
  };
  $('#btnBulkDelete').onclick = async () => {
    const ids = [...state.checked];
    const ok = await confirmDialog({
      title: `彻底删除 ${ids.length} 条资料？`,
      message: '删除后无法恢复，附件副本也会一并清掉。',
      okLabel: '彻底删除',
      danger: true,
    });
    if (!ok) return;
    const r = await act(API.deleteForever(ids), `已彻底删除 ${ids.length} 条`);
    if (r) {
      applySnapshot(r);
      state.checked.clear();
      if (ids.includes(state.selectedId)) state.selectedId = null;
      renderAll();
    }
  };
  $('#btnEmptyTrash').onclick = async () => {
    const n = state.stats.trashed + (state.stats.schedules ? state.stats.schedules.trashed : 0);
    if (!n) return toast('回收站已经是空的', '');
    const ok = await confirmDialog({
      title: `清空回收站（${n} 条）？`,
      message: '回收站里的全部资料、日程与附件都会被彻底删除，无法恢复。',
      okLabel: '清空回收站',
      danger: true,
    });
    if (!ok) return;
    const r = await act(API.emptyTrash(), `已清空回收站（${n} 条）`);
    if (r) {
      applySnapshot(r);
      state.selectedId = null;
      state.selectedScheduleId = null;
      state.checked.clear();
      renderAll();
    }
  };

  $('#btnOpenLib').onclick = () => act(API.openLibrary());
  $('#libPath').onclick = () => act(API.openLibrary());
  $('#btnChangeLib').onclick = changeLibraryFlow;

  // ---- 日历工具条 ----
  $('#calPrev').onclick = () => {
    state.calCursor = state.calView === 'month' ? addMonths(state.calCursor, -1) : addDays(state.calCursor, -state.calRange);
    state.selectedScheduleId = null;
    renderAll();
  };
  $('#calNext').onclick = () => {
    state.calCursor = state.calView === 'month' ? addMonths(state.calCursor, 1) : addDays(state.calCursor, state.calRange);
    state.selectedScheduleId = null;
    renderAll();
  };
  $('#calToday').onclick = () => gotoCalendar({ date: todayStr() });
  $('#calNew').onclick = () => startNewSchedule(state.calSelectedDate || todayStr());
  $('#calSync').onclick = async () => {
    const r = await act(API.feishu.pull());
    if (r) {
      applySnapshot(r);
      renderAll();
    }
  };
  $('#calExport').onclick = exportIcsFlow;

  // 飞书同步结果（自动 / 手动都会触发）
  API.feishu.onResult((p) => {
    if (p.snapshot) {
      applySnapshot(p.snapshot);
      renderAll();
    }
    if (!p.silent) {
      const isPush = p.kind === 'push';
      const kind = isPush ? '推送到飞书' : '从飞书同步';
      const bits = [];
      if (p.created) bits.push('新增 ' + p.created);
      if (p.updated) bits.push('更新 ' + p.updated);
      if (p.removed) bits.push('移除 ' + p.removed);
      const summary = bits.length ? '（' + bits.join('、') + '）' : '';
      toast(kind + '完成' + summary, 'ok');
      // 同步完顺手刷新设置面板里的登录 / 时间信息
      const fsInfo = document.querySelector('#fsSyncInfo');
      if (fsInfo) {
        API.feishu.getConfig().then((r2) => {
          if (!r2 || !r2.config) return;
          const cfg = r2.config;
          const parts = [];
          if (cfg.lastPullAt) parts.push('上次拉取 ' + relTime(cfg.lastPullAt));
          if (cfg.lastPushAt) parts.push('上次推送 ' + relTime(cfg.lastPushAt));
          if (cfg.lastError) parts.push('⚠️ ' + cfg.lastError);
          fsInfo.textContent = parts.join(' · ');
        });
      }
    }
  });
  $('#calViewSeg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      state.calView = b.dataset.v;
      if (state.calView === 'agenda') state.calCursor = todayStr();
      setPrefs({ calView: state.calView });
      renderAll();
    };
  });
  $('#calRangeSeg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      state.calRange = Number(b.dataset.r);
      setPrefs({ calRange: state.calRange });
      renderAll();
    };
  });

  // 左右两栏收起 / 展开
  $('#sideCollapse').onclick = toggleSidebar;
  $('#sideExpand').onclick = toggleSidebar;
  $('#listCollapse').onclick = toggleList;
  $('#listExpand').onclick = toggleList;

  $('#btnSettings').onclick = openSettings;
  $('#btnBackup').onclick = () => doBackup({ toLibrary: true });
  $('#btnRestore').onclick = () => doRestore();

  $('#btnAddCategory').onclick = () => {
    const body = el('div');
    body.innerHTML = `<div class="field"><label>新分类名称</label><input type="text" id="newCatInput" placeholder="如：旅行、家人、收藏" /></div>`;
    const foot = el('div');
    foot.style.cssText = 'display:flex;gap:8px;width:100%';
    const sp = el('span');
    sp.style.flex = '1';
    const cancel = el('button', 'tb', '取消');
    const ok = el('button', 'tb primary', '创建');
    foot.append(sp, cancel, ok);
    const { close } = openModal({ title: '新建分类', body, footer: foot });
    const input = body.querySelector('#newCatInput');
    input.focus();
    cancel.onclick = close;
    const doAdd = async () => {
      const v = input.value.trim();
      if (!v) return toast('分类名不能为空', 'err');
      const r = await act(API.addCategory(v), '分类已创建');
      if (r) {
        applySnapshot(r);
        close();
        renderAll();
      }
    };
    ok.onclick = doAdd;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') doAdd();
    };
  };

  // 详情区滚动时给工具栏加分隔线
  $('#detailScroll').addEventListener('scroll', (e) => {
    $('#detailBar').classList.toggle('stuck', e.target.scrollTop > 4);
  });

  // 全局快捷键
  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    const tag = (e.target && e.target.tagName) || '';
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable);
    if (meta && e.key === 'f') {
      e.preventDefault();
      $('#searchInput').focus();
      $('#searchInput').select();
    } else if (meta && e.key === 's') {
      if (state.scheduleEditing) {
        e.preventDefault();
        saveScheduleEditing();
      } else if (state.editing) {
        e.preventDefault();
        saveEditing();
      }
    } else if (e.key === 'Escape' && !modalCloser) {
      if (state.scheduleEditing) cancelScheduleEditing();
      else if (state.editing) cancelEditing();
    } else if (!inField && !meta && state.view === 'calendar') {
      // 日历里的裸键：← → 切月 / 切区间，T 回今天
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        $('#calPrev').click();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        $('#calNext').click();
      } else if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        gotoCalendar({ date: todayStr() });
      }
    }
  });

  // 空态也能拖入文件（拖到中栏列表时提示新建）
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  API.onMenu(async (ch) => {
    if (ch === 'menu:new') startNewFlow();
    else if (ch === 'menu:save' && state.editing) saveEditing();
    else if (ch === 'menu:search') {
      $('#searchInput').focus();
      $('#searchInput').select();
    } else if (ch === 'menu:settings') openSettings();
    else if (ch === 'menu:backup') doBackup({ toLibrary: true });
    else if (ch === 'menu:backup-as') doBackup({ toLibrary: false });
    else if (ch === 'menu:restore') doRestore();
    else if (ch === 'menu:toggle-side') toggleSidebar();
    else if (ch === 'menu:toggle-list') toggleList();
    else if (ch === 'menu:help') {
      const r = await act(API.snapshot());
      if (!r) return;
      const help = state.entries.find((x) => !x.deleted && x.tags.includes('使用说明'));
      if (help) {
        state.view = 'all';
        state.q = '';
        state.selectedId = help.id;
        state.editing = null;
        renderAll();
      } else {
        toast('左下角「设置与配色」里有备份与资料库入口，第一条资料里写着使用说明。');
      }
    }
  });
}

/* ---------------------------------------------------------------- 启动 */

async function changeLibraryFlow() {
  const ok = await confirmDialog({
    title: '更换资料库位置？',
    message:
      '选择一个新目录后，应用会切换到那里读取资料。\n注意：原目录里的资料不会自动搬过去，需要你把 archive.json 和 attachments 一起拷过去。',
    okLabel: '继续选择目录',
  });
  if (!ok) return null;
  const r = await act(API.changeLibrary());
  if (!r || r.canceled) return null;
  applySnapshot(r);
  state.selectedId = null;
  state.editing = null;
  state.checked.clear();
  state.view = 'all';
  renderAll();
  toast('资料库已切换到 ' + r.libraryPath, 'ok');
  return r;
}

async function boot() {
  // 回收站清空按钮
  const btnEmpty = el('button', 'link-btn hidden', '清空回收站');
  btnEmpty.id = 'btnEmptyTrash';
  document.querySelector('.list-meta').insertBefore(btnEmpty, $('#btnClearFilters'));

  // 日历的默认落点：今天是光标，也是选中的那天
  state.calCursor = todayStr();
  state.calSelectedDate = todayStr();
  if (state.prefs.calView) state.calView = state.prefs.calView;
  if (state.prefs.calRange) state.calRange = state.prefs.calRange;

  // 先用当前主题渲染一遍，避免首屏闪一下默认色
  applyPrefs();
  bindEvents();

  const r = await act(API.snapshot());
  if (!r) {
    renderOverview();
    return;
  }
  applySnapshot(r);
  if (state.prefs.calView) state.calView = state.prefs.calView;
  if (state.prefs.calRange) state.calRange = state.prefs.calRange;
  applyPrefs();
  renderAll();
  renderReminders();

  if (state.migratedFrom) {
    toast('资料库已随改名迁到「My Workbench 资料库」', 'ok');
  }
}

boot();
