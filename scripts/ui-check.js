'use strict';
/**
 * 界面端到端自测：由 src/main/devtools.js 在 LA_TEST_SCRIPT 下加载。
 * 走一遍真实窗口的：初始 → 建资料 → 列表 → 详情 → 编辑 → 搜索 → 筛选 → 回收站 → 导出对话框 → 新建对话框
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nativeImage } = require('electron');

const log = (...a) => console.log('[ui]', ...a);
const assert = (cond, label) => {
  if (!cond) throw new Error('断言失败：' + label);
  log('  ✓ ' + label);
};
/** 本次自测用的资料库目录（模块级，供各段共用） */
const LIB_DIR = process.env.LA_LIBRARY_PATH;

module.exports = async function ({ win, app, shot, errors }) {
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-ui-'));

  // ---- 造测试素材 -------------------------------------------------------
  const dataUrl = await run(`(() => {
    const c = document.createElement('canvas');
    c.width = 1000; c.height = 620;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 1000, 620);
    grad.addColorStop(0, '#93a882'); grad.addColorStop(1, '#3f5741');
    g.fillStyle = grad; g.fillRect(0, 0, 1000, 620);
    g.fillStyle = 'rgba(255,253,249,0.94)';
    g.font = '600 72px "Songti SC", serif';
    g.fillText('书桌一角', 64, 300);
    g.fillStyle = 'rgba(255,253,249,0.72)';
    g.font = '400 32px "PingFang SC", sans-serif';
    g.fillText('2026 · 春天 · 窗边的下午', 66, 366);
    return c.toDataURL('image/png');
  })()`);
  const imgPath = path.join(tmp, '书桌一角.png');
  fs.writeFileSync(imgPath, nativeImage.createFromDataURL(dataUrl).toPNG());
  const docPath = path.join(tmp, '新学期课程安排会议纪要.txt');
  fs.writeFileSync(docPath, '会议时间：2026-09-12\n参会：教学组全体\n议题：新学期课程排布与督导安排', 'utf8');
  log('测试素材已生成：' + tmp);

  await shot('初始界面');

  // ---- 建资料 -----------------------------------------------------------
  const ids = await run(`(async () => {
    const api = window.api;
    const out = [];
    const one = async (p) => { const r = await api.createEntry(p); if (!r.ok) throw new Error(r.error); out.push(r.entry.id); };
    await one({ type:'text', title:'第一次独立出差', content:'在虹桥机场等了三个小时，忽然觉得一个人也还行。\\n\\n回来的高铁上把这段写了下来。', date:'2026-08-14', source:'个人经历', category:'经历', tags:['旅行','心情'] });
    await one({ type:'link', title:'注意力比时间更稀缺', url:'https://example.com/attention', content:'核心观点：注意力是真正稀缺的资源，保护它比管理时间更重要。', date:'2026-09-01', source:'某周刊 2026 年 8 月号', category:'阅读笔记', tags:['阅读','认知'] });
    await one({ type:'image', title:'书桌一角', content:'那天下午的光很好，随手拍了一张。', date:'2026-04-06', source:'自己拍的', category:'经历', tags:['生活','照片'] });
    await one({ type:'file', title:'新学期课程安排会议纪要', content:'要点：督导听课每周不少于两次；进度表按章节+学时填报。', date:'2026-09-12', source:'教学组会议', category:'工作资料', tags:['会议','教学'] });
    await one({ type:'text', title:'关于「档案馆」这个想法', content:'资料散落在各处：微信收藏、备忘录、网盘、截图。\\n想要一个地方，能立刻搜到，还能一次性交给 AI 读。', date:'2026-09-18', source:'灵感', category:'灵感', tags:['产品','灵感'] });
    return out;
  })()`);
  log('已创建 ' + ids.length + ' 条资料');

  // 给「书桌一角」和「会议纪要」加上真实附件
  await run(`(async () => {
    const api = window.api;
    const a1 = await api.addAttachmentPaths(${JSON.stringify(ids[2])}, ${JSON.stringify([imgPath])});
    await api.updateEntry(${JSON.stringify(ids[2])}, { attachments: a1.added });
    const a2 = await api.addAttachmentPaths(${JSON.stringify(ids[3])}, ${JSON.stringify([docPath, imgPath])});
    await api.updateEntry(${JSON.stringify(ids[3])}, { attachments: a2.added });
    const s = await api.snapshot();
    applySnapshot(s);
    renderAll();
    return 1;
  })()`);
  await shot('列表页');

  // ---- 详情 -------------------------------------------------------------
  await run(`(() => {
    state.selectedId = ${JSON.stringify(ids[3])};
    state.editing = null;
    renderAll();
    return 1;
  })()`);
  await shot('详情页-含附件');

  // ---- 真实点击一张卡片 --------------------------------------------------
  const clicked = await run(`(() => {
    const cards = [...document.querySelectorAll('.card')];
    const hit = cards.find((c) => c.textContent.includes('书桌一角'));
    if (!hit) return 'NOT_FOUND';
    hit.click();
    return hit.textContent.slice(0, 20);
  })()`);
  log('点击卡片：' + clicked);
  await shot('详情页-图片预览');

  // ---- 编辑态 -----------------------------------------------------------
  await run(`(() => {
    const e = state.entries.find((x) => x.id === ${JSON.stringify(ids[0])});
    startEdit(e);
    return 1;
  })()`);
  await shot('编辑态');

  // 编辑态里改标题 + 加标签
  const edited = await run(`(() => {
    const t = document.querySelector('#fTitle');
    t.value = '第一次独立出差（改过标题）';
    t.dispatchEvent(new Event('input'));
    const ti = document.querySelector('#tagInput');
    ti.value = '一个人';
    ti.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return document.querySelector('#fTitle').value + ' | tags=' + state.editing.tags.join(',');
  })()`);
  log('编辑态写入：' + edited);
  await shot('编辑态-已修改');

  // 保存
  const saved = await run(`(async () => { await saveEditing(); return state.entries.find(x=>x.id===${JSON.stringify(ids[0])}).title; })()`);
  log('保存后标题：' + saved);

  // ---- 未保存草稿：新建 ---------------------------------------------------
  await run(`(() => { startNewFlow(); return 1; })()`);
  await shot('新建-选择类型');
  await run(`(() => { closeModal(); return 1; })()`);

  // ---- 搜索 -------------------------------------------------------------
  const searched = await run(`(() => {
    const inp = document.querySelector('#searchInput');
    inp.value = '出差';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return new Promise((r) => setTimeout(() => {
      r({ 列表条数: state.lastVisible.length, 高亮: document.querySelectorAll('.card mark').length, 计数文案: document.querySelector('#listCount').textContent });
    }, 260));
  })()`);
  log('搜索「出差」：' + JSON.stringify(searched));
  await shot('搜索高亮');

  // 搜正文
  const searched2 = await run(`(() => {
    const inp = document.querySelector('#searchInput');
    inp.value = '虹桥机场';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return new Promise((r) => setTimeout(() => r(state.lastVisible.map(x=>x.title)), 260));
  })()`);
  log('搜索正文「虹桥机场」命中：' + JSON.stringify(searched2));

  // ---- 筛选 -------------------------------------------------------------
  const filtered = await run(`(() => {
    document.querySelector('#searchClear').click();
    const ft = document.querySelector('#filterType');
    ft.value = 'image';
    ft.dispatchEvent(new Event('change', { bubbles: true }));
    return { 类型筛选: state.lastVisible.map(x=>x.title), 过滤标签可见: !document.querySelector('#btnClearFilters').classList.contains('hidden') };
  })()`);
  log('类型筛选 image：' + JSON.stringify(filtered));
  await shot('筛选-图片类型');

  await run(`(() => { document.querySelector('#btnClearFilters').click(); return 1; })()`);

  // 标签筛选
  const tagFiltered = await run(`(() => {
    const chips = [...document.querySelectorAll('#tagCloud .tag-chip')];
    const hit = chips.find(c => c.textContent.startsWith('旅行'));
    hit.click();
    return { 视图: state.view, 条数: state.lastVisible.length };
  })()`);
  log('点击标签「旅行」：' + JSON.stringify(tagFiltered));
  await shot('标签筛选');
  await run(`(() => { state.view='all'; renderAll(); return 1; })()`);

  // ---- 排序 -------------------------------------------------------------
  const sorted = await run(`(() => {
    const sb = document.querySelector('#sortBy');
    sb.value = 'date_asc';
    sb.dispatchEvent(new Event('change', { bubbles: true }));
    return state.lastVisible.map(x => x.date);
  })()`);
  log('按日期旧→新：' + JSON.stringify(sorted));
  await run(`(() => { const sb=document.querySelector('#sortBy'); sb.value='updated_desc'; sb.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);

  // ---- 勾选 + 导出对话框 --------------------------------------------------
  const bulk = await run(`(() => {
    const boxes = [...document.querySelectorAll('.card .pick')];
    boxes.slice(0, 2).forEach(b => b.click());
    return { 已选: state.checked.size, 批量条文案: document.querySelector('#bulkCount').textContent };
  })()`);
  log('勾选：' + JSON.stringify(bulk));
  await shot('勾选与批量操作');

  await run(`(() => { document.querySelector('#btnExport').click(); return 1; })()`);
  await shot('导出对话框');

  const preview = await run(`(async () => {
    const btns = [...document.querySelectorAll('.modal-foot button')];
    btns.find(b => b.textContent === '预览内容').click();
    await new Promise(r => setTimeout(r, 400));
    const pre = document.querySelector('pre.preview-md');
    return pre ? pre.textContent.slice(0, 260) : 'NO_PREVIEW';
  })()`);
  log('导出预览前 260 字：\n' + preview);
  await shot('导出预览');
  await run(`(() => { closeModal(); return 1; })()`);

  // ---- 回收站 -----------------------------------------------------------
  await run(`(() => {
    state.checked.clear();
    state.view = 'trash';
    state.selectedId = ${JSON.stringify(ids[1])};
    renderAll();
    return 1;
  })()`);
  await shot('回收站-空');

  const trashed = await run(`(async () => {
    state.view = 'all'; renderAll();
    await api.trashEntries([${JSON.stringify(ids[4])}]);
    const s = await api.snapshot(); applySnapshot(s);
    state.view = 'trash'; state.selectedId = ${JSON.stringify(ids[4])};
    renderAll();
    return { 在回收站: state.lastVisible.length, 统计: state.stats.trashed };
  })()`);
  log('移到回收站：' + JSON.stringify(trashed));
  await shot('回收站-有内容');

  const restored = await run(`(async () => {
    const btns = [...document.querySelectorAll('#detailBar button')];
    const hit = btns.find(b => b.textContent === '还原');
    if (!hit) return 'NO_RESTORE_BTN';
    hit.click();
    await new Promise(r => setTimeout(r, 400));
    return { 统计回收站: state.stats.trashed, 总数: state.stats.total };
  })()`);
  log('还原：' + JSON.stringify(restored));

  // ---- 分类维护 ---------------------------------------------------------
  await run(`(() => { state.view='all'; state.selectedId=null; renderAll(); return 1; })()`);
  await run(`(() => { document.querySelector('#btnAddCategory').click(); return 1; })()`);
  await shot('新建分类');
  const newCat = await run(`(async () => {
    const inp = document.querySelector('#newCatInput');
    inp.value = '家人';
    [...document.querySelectorAll('.modal-foot button')].find(b=>b.textContent==='创建').click();
    await new Promise(r => setTimeout(r, 350));
    return state.stats.categories;
  })()`);
  log('分类列表：' + JSON.stringify(newCat));

  // ---- 剪贴板 / Markdown 复制 --------------------------------------------
  const mdCopy = await run(`(async () => {
    const r = await api.exportPreview([${JSON.stringify(ids[3])}]);
    if (!r.ok) return 'PREVIEW_FAIL';
    const c = await api.copyText(r.markdown);
    return c.ok ? 'OK' : c.error;
  })()`);
  log('复制 Markdown：' + mdCopy);

  // ---- 编辑态：⌘V 粘贴图片 / 拖拽加附件 -----------------------------------
  const paste = await run(`(async () => {
    state.view = 'all';
    const e = state.entries.find(x => x.id === ${JSON.stringify(ids[0])});
    startEdit(e);
    const before = state.editing.attachments.length;
    const cv = document.createElement('canvas'); cv.width = 160; cv.height = 100;
    const g = cv.getContext('2d'); g.fillStyle = '#6e8163'; g.fillRect(0, 0, 160, 100);
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], '粘贴的截图.png', { type: 'image/png' }));
    const ta = document.querySelector('#fContent');
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 600));
    const added = state.editing.attachments.slice(before);
    return { 之前: before, 之后: state.editing.attachments.length, 新附件: added.map(a => a.name), 是图片: added.every(a => a.isImage) };
  })()`);
  log('编辑态粘贴图片：' + JSON.stringify(paste));
  assert(paste.之后 === paste.之前 + 1 && paste.是图片, '⌘V 粘贴的图片成为附件');
  await shot('编辑态-粘贴图片后');

  // 拖拽：合成一次 drop 事件，确认处理器被接上（合成事件的 File 没有磁盘路径，
  // 真实拖拽的路径提取无法自动触发，见使用说明的未验证事项）
  const dropWired = await run(`(async () => {
    const zone = document.querySelector('#dropZone');
    const dt = new DataTransfer();
    dt.items.add(new File([new Blob(['x'])], 'a.txt', { type: 'text/plain' }));
    zone.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const hot = zone.classList.contains('hot');
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 300));
    return { 高亮: hot, 拖拽后高亮解除: !zone.classList.contains('hot'), 提示: (document.querySelector('.toast') || {}).textContent || '' };
  })()`);
  log('拖拽落区接线：' + JSON.stringify(dropWired));
  assert(dropWired.高亮 && dropWired.拖拽后高亮解除, '拖拽经过/离开时落区高亮状态正确');

  // 拖拽落盘之后的实际行动：把真实磁盘路径交给同一个处理函数
  const dropped = await run(`(async () => {
    const before = state.editing.attachments.length;
    await addPathsToDraft(${JSON.stringify([docPath, imgPath])});
    return { 之前: before, 之后: state.editing.attachments.length, 名称: state.editing.attachments.slice(before).map(a => a.name) };
  })()`);
  log('拖入真实文件（同一处理函数）：' + JSON.stringify(dropped));
  assert(dropped.之后 === dropped.之前 + 2, '拖入的两个文件都被复制成附件');

  const cancelled = await run(`(async () => {
    const n = state.editing.pendingRelPaths.length;
    await cancelEditing();
    const e = state.entries.find(x => x.id === ${JSON.stringify(ids[0])});
    return { 本次暂存: n, 取消后该条的附件数: e.attachments.length, 仍在编辑: !!state.editing };
  })()`);
  log('取消编辑：' + JSON.stringify(cancelled));
  assert(cancelled.取消后该条的附件数 === 0 && !cancelled.仍在编辑, '取消编辑后附件改动没有落进资料，编辑态已退出');

  // ---- 配色主题 --------------------------------------------------------
  const themeTest = await run(`(async () => {
    openSettings();
    await new Promise(r => setTimeout(r, 320));
    const cards = [...document.querySelectorAll('.theme-card')];
    const bgBefore = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    const accentBefore = getComputedStyle(document.documentElement).getPropertyValue('--moss').trim();
    cards.find(c => c.dataset.theme === 'wine').click();
    await new Promise(r => setTimeout(r, 320));
    const bgAfter = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    const accentAfter = getComputedStyle(document.documentElement).getPropertyValue('--moss').trim();
    return {
      主题数: cards.length,
      主题名: cards.map(c => c.querySelector('.theme-name').textContent),
      切换前底色: bgBefore, 切换后底色: bgAfter,
      切换前强调: accentBefore, 切换后强调: accentAfter,
      当前: state.prefs.theme,
      选中卡: document.querySelector('.theme-card.on').dataset.theme,
    };
  })()`);
  log('配色主题：' + JSON.stringify(themeTest));
  assert(themeTest.主题数 === 5, '设置里列出 5 套配色主题');
  assert(themeTest.切换后底色 !== themeTest.切换前底色 && themeTest.切换后强调 !== themeTest.切换前强调, '切换主题后 CSS 变量立即变化');
  assert(themeTest.当前 === 'wine' && themeTest.选中卡 === 'wine', '选中的主题卡状态正确');
  await shot('设置-配色主题');

  const cfgPath = path.join(app.getPath('userData'), 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {}
  assert(cfg.prefs && cfg.prefs.theme === 'wine', '主题偏好已落盘（config.json）');

  // 换回默认主题，后面的截图沿用初始观感
  const themeBack = await run(`(async () => {
    document.querySelector('.theme-card[data-theme="sage"]').click();
    await new Promise(r => setTimeout(r, 260));
    return state.prefs.theme;
  })()`);
  assert(themeBack === 'sage', '主题可以切回鼠尾草绿系');

  // ---- 设置里的一键备份 --------------------------------------------------
  const bkLib = await run(`(async () => {
    document.querySelector('#setBackup').click();
    await new Promise(r => setTimeout(r, 1400));
    const title = (document.querySelector('.modal-head h2') || {}).textContent || '';
    const cancel = [...document.querySelectorAll('.modal-foot button')].find(b => b.textContent === '取消');
    if (cancel) cancel.click();
    await new Promise(r => setTimeout(r, 300));
    return { 弹窗标题: title, 还开着弹层: !!document.querySelector('.overlay') };
  })()`);
  log('设置里点「立即备份」：' + JSON.stringify(bkLib));
  assert(bkLib.弹窗标题.includes('备份完成'), '一键备份成功并给出结果提示');

  const backupDir = path.join(LIB_DIR, 'backups');
  const zips = fs.readdirSync(backupDir).filter((f) => f.endsWith('.zip'));
  assert(zips.length >= 1 && zips[0].startsWith('My Life 备份_'), '备份 zip 落在资料库 backups/ 且命名带 My Life：' + zips.join(', '));
  const zipSize = fs.statSync(path.join(backupDir, zips[0])).size;
  assert(zipSize > 1000, '备份文件有实际内容（' + Math.round(zipSize / 1024) + ' KB）');

  const bkListUi = await run(`(async () => {
    openSettings();
    await new Promise(r => setTimeout(r, 700));
    const rows = [...document.querySelectorAll('#bkList .bk-item')];
    const txt = (document.querySelector('#bkList') || {}).textContent || '';
    const r = { 备份条数: rows.length, 首条: rows[0] ? rows[0].querySelector('.bk-name').textContent : '', 空态文案: txt.includes('还没有备份') };
    closeModal();
    return r;
  })()`);
  log('设置里的备份列表：' + JSON.stringify(bkListUi));
  assert(bkListUi.备份条数 >= 1 && !bkListUi.空态文案, '备份列表列出了刚做的备份');
  await shot('设置-备份列表');

  // ---- 左右两栏收缩 ------------------------------------------------------
  const collapse = await run(`(async () => {
    const w = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().width);
    const sideW0 = w('#sidebar');
    document.querySelector('#sideCollapse').click();
    await new Promise(r => setTimeout(r, 380));
    const sideW1 = w('#sidebar');
    const railShown = getComputedStyle(document.querySelector('#sideExpand')).display !== 'none';
    document.querySelector('#sideExpand').click();
    await new Promise(r => setTimeout(r, 380));
    const sideW2 = w('#sidebar');
    const listW0 = w('#listPane');
    document.querySelector('#listCollapse').click();
    await new Promise(r => setTimeout(r, 380));
    const listW1 = w('#listPane');
    document.querySelector('#listExpand').click();
    await new Promise(r => setTimeout(r, 380));
    const listW2 = w('#listPane');
    return { 分类栏: [sideW0, sideW1, sideW2], 列表栏: [listW0, listW1, listW2], 轨道按钮可见: railShown, 偏好: { s: state.prefs.sidebarCollapsed, l: state.prefs.listCollapsed } };
  })()`);
  log('两栏收缩：' + JSON.stringify(collapse));
  assert(collapse.分类栏[1] < 60 && collapse.分类栏[2] > 200, '分类栏可收成窄条并展开还原');
  assert(collapse.列表栏[1] < 60 && collapse.列表栏[2] > 300, '列表栏可收成窄条并展开还原');
  assert(collapse.轨道按钮可见, '收起后出现展开按钮');
  assert(!collapse.偏好.s && !collapse.偏好.l, '展开后偏好已回到未收起');

  const collapseShot = await run(`(async () => {
    document.querySelector('#sideCollapse').click();
    document.querySelector('#listCollapse').click();
    await new Promise(r => setTimeout(r, 420));
    return 1;
  })()`);
  void collapseShot;
  await shot('两栏收起-编辑区更宽');
  await run(`(async () => {
    document.querySelector('#sideExpand').click();
    document.querySelector('#listExpand').click();
    await new Promise(r => setTimeout(r, 420));
    return 1;
  })()`);

  // ---- Markdown 编辑器 --------------------------------------------------
  const mdDraft = await run(`(async () => {
    state.view = 'all'; state.selectedId = null; renderAll();
    const r = await api.newDraftId();
    state.editing = blankDraft('text', r.id);
    renderAll();
    return {
      默认格式: state.editing.format,
      有工具栏: !!document.querySelector('#mdToolbar'),
      有预览区: !!document.querySelector('#mdPreview'),
      右栏宽: Math.round(document.querySelector('#detailPane').getBoundingClientRect().width),
      编辑区宽度: Math.round(document.querySelector('.detail-inner').getBoundingClientRect().width),
      输入框高: Math.round(document.querySelector('#fContent').getBoundingClientRect().height),
    };
  })()`);
  log('新建文字资料的编辑器：' + JSON.stringify(mdDraft));
  assert(mdDraft.默认格式 === 'markdown' && mdDraft.有工具栏 && mdDraft.有预览区, '文字资料默认用 Markdown 编辑器');
  assert(
    mdDraft.编辑区宽度 >= mdDraft.右栏宽 - 95 && mdDraft.输入框高 >= 440,
    `编辑器放大到几乎占满右栏（右栏 ${mdDraft.右栏宽}px / 编辑区 ${mdDraft.编辑区宽度}px，输入框高 ${mdDraft.输入框高}px）`
  );
  await shot('Markdown 编辑器-空');

  const mdTyped = await run(`(async () => {
    const t = document.querySelector('#fTitle');
    t.value = 'Markdown 录入测试';
    t.dispatchEvent(new Event('input'));
    const ta = document.querySelector('#fContent');
    ta.value = '# 今日要点\\n\\n这是 **加粗**、*斜体* 和 \`行内代码\`。\\n\\n- 甲\\n- 乙\\n\\n> 一句引用\\n';
    ta.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 320));
    const prev = document.querySelector('#mdPreview');
    return {
      渲染到的标签: [...prev.querySelectorAll('h1,strong,em,code,li,blockquote')].map(n => n.tagName).join(','),
      预览文本: prev.textContent.replace(/\\s+/g, ' ').trim().slice(0, 48),
      内容已同步: state.editing.content.includes('今日要点'),
    };
  })()`);
  log('Markdown 实时预览：' + JSON.stringify(mdTyped));
  assert(mdTyped.渲染到的标签.includes('H1') && mdTyped.渲染到的标签.includes('STRONG') && mdTyped.渲染到的标签.includes('LI'), '预览把标题/粗体/列表渲染成了 HTML');
  assert(mdTyped.内容已同步, '边写边同步进编辑状态');
  await shot('Markdown 编辑器-实时预览');

  const mdTools = await run(`(async () => {
    const ta = document.querySelector('#fContent');
    const prev = document.querySelector('#mdPreview');
    const click = (k) => document.querySelector('#mdToolbar button[data-md="' + k + '"]').click();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    click('table');
    await new Promise(r => setTimeout(r, 180));
    const hasTable = ta.value.includes('| --- |');
    const previewAfterTable = prev.innerHTML;

    ta.setSelectionRange(0, 0);
    click('h2');
    await new Promise(r => setTimeout(r, 180));
    const hasH2 = ta.value.startsWith('## ');
    const previewAfterH2 = prev.innerHTML;

    const at = ta.value.indexOf('这是');
    ta.setSelectionRange(at, at + 2);
    click('bold');
    await new Promise(r => setTimeout(r, 180));
    const bolded = ta.value.includes('**这是**');
    const previewAfterBold = prev.innerHTML;

    return {
      插入表格: hasTable,
      插入二级标题: hasH2,
      选区加粗: bolded,
      预览含table: previewAfterTable.includes('<table'),
      预览含h2: previewAfterH2.includes('<h2'),
      预览含strong: previewAfterBold.includes('<strong>'),
    };
  })()`);
  log('Markdown 工具栏：' + JSON.stringify(mdTools));
  assert(mdTools.插入表格 && mdTools.预览含table, '工具栏「表格」可用且预览能渲染表格');
  assert(mdTools.插入二级标题 && mdTools.预览含h2, '工具栏「H2」给当前行加标题');
  assert(mdTools.选区加粗 && mdTools.预览含strong, '工具栏「B」给选中文字加粗并反映到预览');

  const mdToggle = await run(`(async () => {
    const before = state.prefs.mdPreview;
    document.querySelector('#mdPreviewBtn').click();
    await new Promise(r => setTimeout(r, 220));
    const hidden = document.querySelector('#mdSplit').classList.contains('preview-off');
    document.querySelector('#mdPreviewBtn').click();
    await new Promise(r => setTimeout(r, 220));
    const shown = !document.querySelector('#mdSplit').classList.contains('preview-off');
    return { 之前: before, 隐藏成功: hidden, 恢复显示: shown };
  })()`);
  log('预览开关：' + JSON.stringify(mdToggle));
  assert(mdToggle.隐藏成功 && mdToggle.恢复显示, '预览可随时隐藏 / 显示');

  const mdSwitch = await run(`(async () => {
    document.querySelector('#contentSeg button[data-f="plain"]').click();
    await new Promise(r => setTimeout(r, 260));
    const plain = { 格式: state.editing.format, 有工具栏: !!document.querySelector('#mdToolbar'), 内容: document.querySelector('#fContent').value.slice(0, 8) };
    document.querySelector('#contentSeg button[data-f="markdown"]').click();
    await new Promise(r => setTimeout(r, 260));
    const back = { 格式: state.editing.format, 有工具栏: !!document.querySelector('#mdToolbar'), 内容: document.querySelector('#fContent').value.slice(0, 8) };
    return { plain, back };
  })()`);
  log('纯文本 / Markdown 切换：' + JSON.stringify(mdSwitch));
  assert(mdSwitch.plain.格式 === 'plain' && !mdSwitch.plain.有工具栏, '切到纯文本后工具栏消失');
  assert(mdSwitch.back.格式 === 'markdown' && mdSwitch.back.内容 === mdSwitch.plain.内容, '切回 Markdown 内容不丢');

  // 写一份干净的 Markdown 存下来，验证详情页渲染
  const mdSaved = await run(`(async () => {
    const ta = document.querySelector('#fContent');
    ta.value = '# 周会记录\\n\\n## 结论\\n\\n| 事项 | 负责人 |\\n| --- | --- |\\n| 督导听课 | 吴倩 |\\n\\n- [x] 已排课\\n- [ ] 待确认教室\\n';
    ta.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 220));
    await saveEditing();
    await new Promise(r => setTimeout(r, 400));
    const e = state.entries.find(x => x.title === 'Markdown 录入测试');
    const body = document.querySelector('#detailScroll .md-body');
    return {
      已保存: !!e,
      存的格式: e ? e.format : '',
      存的原文前10字: e ? e.content.slice(0, 10) : '',
      详情页是渲染的: !!body,
      详情页标签: body ? [...body.querySelectorAll('h1,h2,table,li')].map(n => n.tagName).join(',') : '',
      详情页有复选框: body ? body.querySelectorAll('.md-check').length : 0,
    };
  })()`);
  log('保存后详情页：' + JSON.stringify(mdSaved));
  assert(mdSaved.已保存 && mdSaved.存的格式 === 'markdown', 'Markdown 格式随资料一起存下来');
  assert(mdSaved.详情页是渲染的 && mdSaved.详情页标签.includes('H1') && mdSaved.详情页标签.includes('TABLE'), '详情页按 Markdown 渲染（标题与表格）');
  assert(mdSaved.详情页有复选框 === 2, '任务列表渲染成复选框');
  await shot('详情页-Markdown 渲染');

  // ---- 专注编辑 --------------------------------------------------------
  const focus = await run(`(async () => {
    state.selectedId = null; startEdit(state.entries.find(x => x.title === 'Markdown 录入测试'));
    await new Promise(r => setTimeout(r, 260));
    const before = Math.round(document.querySelector('#sidebar').getBoundingClientRect().width);
    const paneBefore = Math.round(document.querySelector('#detailPane').getBoundingClientRect().width);
    document.querySelector('#btnFocus').click();
    await new Promise(r => setTimeout(r, 420));
    const sideW = Math.round(document.querySelector('#sidebar').getBoundingClientRect().width);
    const listW = Math.round(document.querySelector('#listPane').getBoundingClientRect().width);
    const paneAfter = Math.round(document.querySelector('#detailPane').getBoundingClientRect().width);
    const innerW = Math.round(document.querySelector('.detail-inner').getBoundingClientRect().width);
    return { 专注前侧栏: before, 专注后侧栏: sideW, 专注后列表: listW, 专注前右栏: paneBefore, 专注后右栏: paneAfter, 编辑区宽: innerW, 按钮点亮: document.querySelector('#btnFocus').classList.contains('on'), 偏好未变: !state.prefs.sidebarCollapsed && !state.prefs.listCollapsed };
  })()`);
  log('专注编辑：' + JSON.stringify(focus));
  assert(focus.专注后侧栏 < 60 && focus.专注后列表 < 60, '专注模式下两栏都收起');
  assert(focus.专注后右栏 > focus.专注前右栏 + 400, `专注模式编辑区明显变宽（右栏 ${focus.专注前右栏} → ${focus.专注后右栏}px）`);
  assert(focus.偏好未变, '专注只是临时状态，没有改掉偏好');
  await shot('专注编辑模式');
  await run(`(async () => { document.querySelector('#btnFocus').click(); await cancelEditing(); await new Promise(r=>setTimeout(r,300)); return 1; })()`);

  // ---- 备份 → 破坏现状 → 恢复（真实 IPC + 真实文件）------------------------
  const zipPath = path.join(tmp, '备份.zip');
  await run(`(() => { state.selectedId = null; state.editing = null; renderAll(); return 1; })()`);
  const beforeTitles = await run(`state.entries.filter(e=>!e.deleted).map(e=>e.title).sort().join('|')`);
  const beforeCount = await run(`state.stats.total`);

  const bk = await run(`(async () => {
    const r = await api.createBackup(${JSON.stringify(zipPath)});
    return r.ok ? { bytes: r.bytes, files: r.files } : r;
  })()`);
  log('备份结果：' + JSON.stringify(bk));
  assert(!bk.error && bk.bytes > 0, '通过界面触发备份，zip 已生成');
  assert(fs.existsSync(zipPath), '备份文件确实落在磁盘上');

  // 破坏现状：加一条、删一条
  const broken = await run(`(async () => {
    await api.createEntry({ type:'text', title:'备份之后才写的', content:'恢复后应该消失' });
    const victim = state.entries.find(e=>!e.deleted && e.title.includes('注意力'));
    if (victim) await api.trashEntries([victim.id]);
    const s = await api.snapshot(); applySnapshot(s); renderAll();
    return {
      多出来的: state.entries.filter(e=>!e.deleted && e.title === '备份之后才写的').length,
      回收站: state.stats.trashed,
      总数: state.stats.total,
    };
  })()`);
  log('破坏后的现状：' + JSON.stringify(broken));
  assert(broken.多出来的 === 1, '现状已被改成与备份不同（多出一条备份里没有的）');
  assert(broken.回收站 === 1, '现状与备份不同（少了一条）');
  await shot('恢复前-被改乱的资料库');

  const restoreInfo = await run(`(async () => {
    const r = await api.restoreBackup(${JSON.stringify(zipPath)});
    if (!r.ok) return r;
    applySnapshot(r); renderAll();
    return { entries: r.entries, attachments: r.attachments, safetyDir: r.safetyDir };
  })()`);
  log('恢复结果：' + JSON.stringify(restoreInfo));
  assert(!restoreInfo.error, '恢复 IPC 返回成功');
  const afterStats = await run(`({ total: state.stats.total, trashed: state.stats.trashed })`);
  assert(afterStats.total === beforeCount, `恢复后在库条数回到备份时（${beforeCount}）`);
  assert(afterStats.trashed === 0, '恢复后回收站回到备份时的状态（空）');
  assert(restoreInfo.attachments >= 3, '恢复带回附件文件');

  const afterTitles = await run(`state.entries.filter(e=>!e.deleted).map(e=>e.title).sort().join('|')`);
  assert(afterTitles === beforeTitles, '恢复后每条资料内容与备份时完全一致');
  assert(!afterTitles.includes('备份之后才写的'), '备份之后新建的那条已被覆盖掉');

  const attFiles = fs.existsSync(path.join(LIB_DIR, 'attachments'))
    ? fs.readdirSync(path.join(LIB_DIR, 'attachments')).length
    : 0;
  assert(attFiles >= 2, `恢复后附件目录里有 ${attFiles} 组文件`);
  assert(fs.existsSync(restoreInfo.safetyDir), '恢复前自动留存了保险副本');
  await shot('恢复后-资料库回到备份状态');

  // ---- 空态 / 概览 -------------------------------------------------------
  await run(`(() => { state.selectedId = null; state.editing = null; renderAll(); return 1; })()`);
  await shot('概览空态');

  // ---- 附件打开（走系统 shell，只验证 IPC 不报错） ------------------------
  const attOpen = await run(`(async () => {
    const e = state.entries.find(x => x.id === ${JSON.stringify(ids[3])});
    const a = e.attachments[0];
    const r = await api.revealAttachment(a.relPath);
    return r.ok ? 'OK' : r.error;
  })()`);
  log('在访达中显示附件：' + attOpen);

  const badPath = await run(`(async () => {
    const r = await api.openAttachment('../../../../etc/passwd');
    return r.ok ? 'UNEXPECTED_OK' : r.error;
  })()`);
  log('越界附件访问被拒绝：' + badPath);

  log('截图目录见 LA_SHOT_DIR；渲染进程错误 ' + errors.length + ' 条');
  fs.rmSync(tmp, { recursive: true, force: true });
};
