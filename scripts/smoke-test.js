'use strict';
/**
 * 人生档案馆 —— 核心逻辑自测（不依赖 Electron，直接跑数据层）
 * 用法：node scripts/smoke-test.js
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { ArchiveStore } = require('../src/main/store');
const { LibraryService } = require('../src/main/library');

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + label);
  } else {
    fail++;
    failures.push(label + (extra ? ' → ' + extra : ''));
    console.log('  ✗ ' + label + (extra ? ' → ' + extra : ''));
  }
}

function section(t) {
  console.log('\n' + t);
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'la-smoke-'));
  const libDir = path.join(root, '人生档案馆');
  const store = new ArchiveStore(libDir);
  const lib = new LibraryService(path.join(root, 'config.json'));

  section('1. 初始化资料库');
  await store.load();
  ok(fs.existsSync(path.join(libDir, 'archive.json')), 'archive.json 已创建');
  ok(fs.existsSync(path.join(libDir, 'attachments')), 'attachments 目录已创建');
  ok(fs.existsSync(path.join(libDir, 'backups')), 'backups 目录已创建');
  ok(store.data.entries.length === 1, '首次启动写入 1 条使用说明', '实际 ' + store.data.entries.length);

  section('2. 新建四种类型资料');
  const textEntry = await store.create({
    type: 'text',
    title: '第一次独立出差',
    content: '在虹桥机场等了三个小时，忽然觉得一个人也还行。',
    date: '2026-08-14',
    source: '随笔',
    category: '经历',
    tags: ['旅行', '心情'],
  });
  ok(!!textEntry.id, '文字资料创建成功');

  const linkEntry = await store.create({
    type: 'link',
    title: '一篇关于注意力经济的文章',
    url: 'https://example.com/attention-economy',
    content: '核心观点：注意力比时间更稀缺。',
    date: '2026-09-01',
    source: '某某周刊',
    category: '阅读笔记',
    tags: ['阅读', '认知'],
  });
  ok(linkEntry.url.includes('example.com'), '链接资料保存了 URL');
  ok(store.data.categories.includes('阅读笔记'), '新分类自动登记');

  // 造两个真实文件当附件
  const tmpFile = path.join(root, '原始文档.txt');
  await fsp.writeFile(tmpFile, '这是一份原始资料的正文。', 'utf8');
  const tmpPng = path.join(root, '现场照片.png');
  await fsp.writeFile(tmpPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));

  const fileAtt = await store.addAttachmentFromPath(textEntry.id, tmpFile);
  const imgAtt = await store.addAttachmentFromPath(textEntry.id, tmpPng);
  ok(fs.existsSync(path.join(libDir, ...fileAtt.relPath.split('/'))), '文件附件已复制进资料库');
  ok(fs.existsSync(path.join(libDir, ...imgAtt.relPath.split('/'))), '图片附件已复制进资料库');
  ok(fs.existsSync(tmpFile), '原始文件仍然保留在原处（未被移动）');
  ok(fileAtt.isImage === false && imgAtt.isImage === true, '图片/文件类型识别正确');
  await store.update(textEntry.id, { attachments: [fileAtt, imgAtt] });

  const bufAtt = await store.addAttachmentFromBuffer(
    linkEntry.id,
    Buffer.from('fake-png-data'),
    '截图.png'
  );
  ok(bufAtt.isImage === true, '剪贴板二进制转附件成功');
  await store.update(linkEntry.id, { attachments: [bufAtt] });

  section('3. 同名附件不覆盖');
  const dup = await store.addAttachmentFromPath(textEntry.id, tmpFile);
  ok(dup.name !== fileAtt.name, '同名文件自动加序号', `${fileAtt.name} / ${dup.name}`);
  await store.update(textEntry.id, { attachments: [fileAtt, imgAtt, dup] });

  section('4. 编辑资料');
  await store.update(textEntry.id, {
    title: '第一次独立出差（修订）',
    source: '个人经历',
    tags: ['旅行', '心情', '独立', '旅行'],
    date: '2026-08-15',
  });
  const t2 = store.get(textEntry.id);
  ok(t2.title === '第一次独立出差（修订）', '标题已更新');
  ok(t2.tags.length === 3, '标签自动去重', t2.tags.join(','));
  ok(t2.date === '2026-08-15', '日期已更新');
  ok(new Date(t2.updatedAt) >= new Date(t2.createdAt), 'updatedAt 已刷新');

  section('5. 统计');
  const st = store.stats();
  ok(st.total === 3, '在库资料 3 条', '实际 ' + st.total);
  ok(st.tags.some((x) => x.name === '旅行' && x.count === 1), '标签统计正确');
  ok(st.byCategory['经历'] === 1, '分类统计正确');

  section('6. 回收站');
  await store.trash([linkEntry.id]);
  ok(store.stats().total === 2 && store.stats().trashed === 1, '移入回收站后计数正确');
  ok(store.list().every((e) => e.id !== linkEntry.id), '默认列表不含回收站内容');
  ok(store.list({ includeDeleted: true }).some((e) => e.id === linkEntry.id), '可查询回收站内容');
  await store.restore([linkEntry.id]);
  ok(store.stats().trashed === 0, '还原成功');
  await store.trash([linkEntry.id]);
  await store.removeForever([linkEntry.id]);
  ok(store.get(linkEntry.id) === null, '彻底删除成功');
  ok(
    !fs.existsSync(path.join(libDir, 'attachments', linkEntry.id)),
    '彻底删除同时清掉附件目录'
  );

  section('7. 重新加载（模拟重启应用）');
  const store2 = new ArchiveStore(libDir);
  await store2.load();
  ok(store2.data.entries.length === 2, '重启后仍能读到资料', '实际 ' + store2.data.entries.length);
  const reloaded = store2.get(textEntry.id);
  ok(reloaded && reloaded.title === '第一次独立出差（修订）', '重启后内容与标题一致');
  ok(reloaded.attachments.length === 3, '重启后附件记录完整', '实际 ' + reloaded.attachments.length);
  ok(reloaded.tags.length === 3, '重启后标签完整');

  section('8. 导出 Markdown');
  const targets = store.list();
  const mdPath = path.join(root, 'out', '导出.md');
  const exp = await lib.exportCombined(targets, mdPath, store, { copyAttachments: true });
  const mdText = await fsp.readFile(mdPath, 'utf8');
  ok(fs.existsSync(mdPath), '合并 Markdown 已生成');
  ok(mdText.includes('第一次独立出差（修订）'), 'Markdown 含标题');
  ok(mdText.includes('在虹桥机场等了三个小时'), 'Markdown 含正文');
  ok(mdText.includes('**来源**：个人经历'), 'Markdown 保留来源');
  ok(mdText.includes('#旅行'), 'Markdown 保留标签');
  ok(mdText.includes('- **日期**：2026-08-15'), 'Markdown 保留日期');
  ok(exp.copied === 3, '附件副本随导出一起复制', '实际 ' + exp.copied);
  ok(
    fs.existsSync(path.join(root, 'out', 'attachments', textEntry.id, fileAtt.name)),
    '附件副本落在导出目录下，Markdown 内相对链接可打开'
  );

  const perDir = path.join(root, 'per');
  const exp2 = await lib.exportPerEntry(targets, perDir, store, { copyAttachments: true });
  const perFiles = await fsp.readdir(perDir);
  ok(exp2.entries === 2 && perFiles.filter((f) => f.endsWith('.md')).length === 2, '每条资料一个 .md 文件');

  section('9. 备份');
  const zipPath = path.join(root, '备份.zip');
  const bk = await lib.createBackup(zipPath, store);
  ok(fs.existsSync(zipPath) && bk.bytes > 0, '备份 zip 已生成', bk.bytes + ' 字节');
  ok(bk.files >= 4, '备份包含 archive.json 与全部附件', '实际 ' + bk.files + ' 个文件');
  const beforeBackup = JSON.stringify(store.data.entries.map((e) => e.title).sort());

  section('10. 破坏后再恢复');
  await store.create({ type: 'text', title: '这条是备份之后才加的', content: '应该被恢复覆盖掉' });
  await store.trash([textEntry.id]);
  ok(store.stats().total === 2, '制造了与备份不一致的现状', '实际 ' + store.stats().total);

  const info = await lib.inspectBackup(zipPath);
  ok(info.data.entries.length === 2, '备份校验通过，读到 2 条资料', '实际 ' + info.data.entries.length);

  const restored = await lib.restoreBackup(zipPath, store);
  ok(restored.entries === 2, '恢复后条数回到备份状态', '实际 ' + restored.entries);
  ok(
    JSON.stringify(store.data.entries.map((e) => e.title).sort()) === beforeBackup,
    '恢复后内容与备份时完全一致'
  );
  ok(
    fs.existsSync(path.join(libDir, 'attachments', textEntry.id, fileAtt.name)),
    '恢复后附件文件回来了'
  );
  ok(fs.existsSync(restored.safetyDir), '恢复前自动留存了保险副本');
  ok(
    fs.existsSync(path.join(restored.safetyDir, 'archive.json')),
    '保险副本里有恢复前的 archive.json'
  );
  const store3 = new ArchiveStore(libDir);
  await store3.load();
  ok(store3.data.entries.length === 2, '恢复后重启仍能正常读取');

  section('11. 分类维护');
  await store3.renameCategory('经历', '人生经历');
  ok(store3.stats().byCategory['人生经历'] === 1, '分类改名后资料跟着走');
  await store3.removeCategory('人生经历');
  ok(!store3.data.categories.includes('人生经历'), '分类删除成功');
  ok(store3.stats().byCategory['未分类'] === 2, '原资料变成未分类，没有被删掉', JSON.stringify(store3.stats().byCategory));

  section('12. 安全校验');
  ok(store3.isInsideLibrary(path.join(libDir, 'attachments', 'x.png')), '库内路径判定正确');
  ok(!store3.isInsideLibrary('/etc/passwd'), '库外路径被拒绝');
  ok(!store3.isInsideLibrary(path.join(libDir, '..', 'evil')), '../ 越界被拒绝');
  let threw = false;
  try {
    store3.absOfAttachment('../outside.png');
  } catch {
    threw = true;
  }
  ok(threw, '附件越界访问抛错');

  section('13. 损坏文件兜底');
  const archivePath = path.join(libDir, 'archive.json');
  await fsp.writeFile(archivePath, '{ 这不是合法 JSON', 'utf8');
  const store4 = new ArchiveStore(libDir);
  await store4.load();
  ok(store4.data.entries.length === 2, '损坏时自动从 .bak 恢复');

  section('14. 从旧版「人生档案馆」迁移');
  const legacyDir = path.join(root, 'legacy-lib');
  await fsp.mkdir(path.join(legacyDir, 'attachments'), { recursive: true });
  await fsp.mkdir(path.join(legacyDir, 'backups'), { recursive: true });
  await fsp.writeFile(
    path.join(legacyDir, 'archive.json'),
    JSON.stringify(
      {
        version: 1,
        createdAt: '2026-09-20T00:00:00.000Z',
        updatedAt: '2026-09-20T00:00:00.000Z',
        categories: ['经历', '工作资料', '阅读笔记', '灵感'],
        entries: [
          {
            id: 'eold',
            type: 'text',
            title: '欢迎使用人生档案馆',
            content: '这里是一段旧版的说明文案。',
            source: '人生档案馆',
            date: '2026-09-20',
            category: '',
            tags: ['使用说明'],
            attachments: [],
            createdAt: '2026-09-20T00:00:00.000Z',
            updatedAt: '2026-09-20T00:00:00.000Z',
            deleted: false,
          },
          {
            id: 'emy',
            type: 'text',
            title: '我自己改过标题的说明',
            content: '这是我自己写的内容，不该被改。',
            source: '我',
            date: '2026-09-21',
            category: '',
            tags: ['使用说明'],
            attachments: [],
            createdAt: '2026-09-21T00:00:00.000Z',
            updatedAt: '2026-09-21T00:00:00.000Z',
            deleted: false,
          },
          {
            id: 'ekeep',
            type: 'text',
            title: '一条普通资料',
            content: '正文里有「人生档案馆」四个字，不该被当成说明条目。',
            source: '人生档案馆',
            date: '2026-09-21',
            category: '',
            tags: ['工作'],
            attachments: [],
            createdAt: '2026-09-21T00:00:00.000Z',
            updatedAt: '2026-09-21T00:00:00.000Z',
            deleted: false,
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  );
  const legacyStore = new ArchiveStore(legacyDir);
  await legacyStore.load();
  const upgraded = legacyStore.get('eold');
  ok(upgraded.title === '欢迎使用 My Life', '旧版说明条目的标题跟着更新', upgraded.title);
  ok(upgraded.format === 'markdown', '并带上了 Markdown 格式');
  ok(upgraded.content.includes('My Life 资料库'), '正文换成了新版说明');
  ok(upgraded.source === 'My Life', '来源字段也更新了');
  ok(legacyStore.get('emy').title === '我自己改过标题的说明', '自己改过标题的条目不被动');
  ok(legacyStore.get('ekeep').source === '人生档案馆', '普通资料的来源字段保持原样');
  ok(legacyStore.data.entries.length === 3, '升级过程没有多插入条目', '实际 ' + legacyStore.data.entries.length);

  section('15. rename 被拒时的写入兜底');
  const fsp2 = require('node:fs/promises');
  const realRename = fsp2.rename;
  const blockedDir = path.join(root, 'rename-blocked');
  const probe = new ArchiveStore(blockedDir);
  await probe.load();
  fsp2.rename = async () => {
    const e = new Error('EPERM: operation not permitted, rename');
    e.code = 'EPERM';
    throw e;
  };
  let writeThrew = false;
  try {
    await probe.create({ type: 'text', title: 'rename 被拦时写的资料', content: '不该丢' });
  } catch {
    writeThrew = true;
  }
  fsp2.rename = realRename;
  ok(!writeThrew, 'rename 失败不会让整次写入失败');
  const probe2 = new ArchiveStore(blockedDir);
  await probe2.load();
  ok(
    probe2.data.entries.some((e) => e.title === 'rename 被拦时写的资料'),
    '内容确实落盘了（退化成直接覆盖写）'
  );
  ok(!fs.existsSync(path.join(blockedDir, 'archive.json.tmp')), '残留的 .tmp 被清掉');
  ok(fs.existsSync(path.join(blockedDir, 'archive.json.bak')), '.bak 仍然保留');

  await fsp.rm(root, { recursive: true, force: true });

  console.log('\n' + '='.repeat(52));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log(' · ' + f));
    process.exit(1);
  } else {
    console.log('核心逻辑全部通过 ✅');
  }
})().catch((err) => {
  console.error('\n自测脚本崩溃：', err);
  process.exit(2);
});
