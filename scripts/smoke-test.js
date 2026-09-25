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
const { LibraryService, buildMarkdown } = require('../src/main/library');
const {
  occurrenceStarts,
  occurrencesInRange,
  occurrencesOn,
  conflictsIn,
  splitPayload,
  repeatWithout,
} = require('../src/renderer/schedule');

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

  // ==========================================================================
  // 日历与日程
  // ==========================================================================

  const calStore = new ArchiveStore(path.join(root, 'cal-lib'));
  await calStore.load();

  section('16. 日程：新建与查询');
  const hostEntry = await calStore.create({
    type: 'text',
    title: '教学组例会纪要',
    content: '会议要点：督导听课每周不少于两次。',
    date: '2026-09-23',
    category: '工作资料',
    tags: ['教学'],
  });
  const meet = await calStore.createSchedule({
    title: '教学组例会',
    date: '2026-09-23',
    start: '10:00',
    end: '11:30',
    location: '三楼会议室',
    category: '工作资料',
    tags: ['教学', '会议'],
    links: [hostEntry.id],
    remind: 15,
  });
  // 沿用既有约定：资料是 e + hex、附件是 a + hex，日程就是 s + hex（首字母区分，不会撞）
  ok(/^s[0-9a-f]+$/.test(meet.id), '日程 id 以 s 开头（与资料的 e 区分）', meet.id);
  ok(calStore.getSchedule(meet.id) !== null, '日程可以按 id 查到');
  ok(calStore.data.schedules.length === 1, '日程写进同一个 archive.json');
  ok(calStore.stats().schedules.total === 1, 'stats 里含日程计数');
  ok(calStore.data.categories.includes('工作资料'), '日程用到的分类自动登记');
  ok(meet.links.length === 1 && meet.links[0] === hostEntry.id, '关联资料已保存');
  ok(meet.remind === 15, '提醒分钟数已保存');
  ok(calStore.data.version === 2, 'ARCHIVE_VERSION 升到 2');

  section('17. 日程编辑 / 全天 / 脏数据归一化');
  await calStore.updateSchedule(meet.id, { title: '教学组例会（周会）', remind: 30 });
  ok(calStore.getSchedule(meet.id).title === '教学组例会（周会）', '日程标题可更新');
  ok(calStore.getSchedule(meet.id).remind === 30, '提醒时间可更新');

  const trip = await calStore.createSchedule({
    title: '外出调研',
    date: '2026-09-28',
    endDate: '2026-09-30',
    allDay: true,
    start: '08:00',
    end: '09:00',
  });
  ok(trip.allDay === true && trip.start === '' && trip.end === '', '全天日程忽略填进来的时间');
  ok(trip.endDate === '2026-09-30', '跨天日程保留结束日期');

  const dirty = await calStore.createSchedule({
    title: '脏数据',
    date: '不是日期',
    endDate: '2026-01-01',
    remind: 'abc',
    color: '紫色',
    repeat: { freq: '每周' },
  });
  ok(/^\d{4}-\d{2}-\d{2}$/.test(dirty.date), '非法日期回落到今天', dirty.date);
  ok(dirty.endDate === null, '结束日期早于开始日期时被丢弃');
  ok(dirty.remind === null, '非法提醒值被丢弃');
  ok(dirty.color === '', '非法色标被丢弃');
  ok(dirty.repeat.freq === 'none', '非法重复频率回落到不重复');
  await calStore.removeSchedulesForever([dirty.id]);

  section('18. 重复规则展开（只存规则，不预生成实例）');
  const weekly = await calStore.createSchedule({
    title: '每周督导会',
    date: '2026-09-01',
    start: '09:00',
    repeat: { freq: 'weekly', count: 4 },
  });
  const weeklyStarts = occurrenceStarts(weekly, '2026-08-01', '2026-12-31');
  ok(weeklyStarts.length === 4, '每周 + count=4 展开 4 次', weeklyStarts.join(','));
  ok(weeklyStarts.join(',') === '2026-09-01,2026-09-08,2026-09-15,2026-09-22', '每周按 7 天递推');
  ok(calStore.data.schedules.filter((s) => s.repeat.freq === 'weekly').length === 1, '重复规则只有一条记录，没有塞 1000 条实例');

  const monthly = await calStore.createSchedule({
    title: '月末结账',
    date: '2026-01-31',
    repeat: { freq: 'monthly', until: '2026-04-30' },
  });
  ok(
    occurrenceStarts(monthly, '2026-01-01', '2026-12-31').join(',') ===
      '2026-01-31,2026-02-28,2026-03-31,2026-04-30',
    '每月重复遇到 31 号自动钳到月末，且不会「越跑越早」'
  );

  const yearly = await calStore.createSchedule({
    title: '周年',
    date: '2024-02-29',
    repeat: { freq: 'yearly' },
  });
  ok(
    occurrenceStarts(yearly, '2024-01-01', '2028-12-31').join(',') ===
      '2024-02-29,2025-02-28,2026-02-28,2027-02-28,2028-02-29',
    '每年重复：2/29 在平年落到 2/28，闰年回到 2/29'
  );

  const daily = await calStore.createSchedule({
    title: '每日复盘',
    date: '2026-09-01',
    repeat: { freq: 'daily', until: '2026-09-05' },
  });
  const dailyStarts = occurrenceStarts(daily, '2026-09-01', '2026-09-30');
  ok(dailyStarts.length === 5, '每天重复 + until 上限生效', dailyStarts.join(','));
  ok(dailyStarts[4] === '2026-09-05', 'until 含端点那一天');

  section('19. 跨天与按天展开');
  const tripOcc = occurrencesInRange([trip], '2026-09-27', '2026-10-01');
  ok(tripOcc.length === 3, '跨天日程覆盖 3 天', tripOcc.map((o) => o.date).join(','));
  ok(tripOcc[0].spanStart && tripOcc[2].spanEnd, '首尾标记正确（月视图据此画连续色条）');
  ok(!tripOcc[1].spanStart && !tripOcc[1].spanEnd, '中间那天两头都不封口');
  ok(occurrencesOn(calStore.listSchedules(), '2026-09-28').length === 1, '按天查询只返回当天命中的');
  ok(
    occurrencesOn(calStore.listSchedules(), '2026-09-23')[0].schedule.title === '教学组例会（周会）',
    '按天查询拿到的是改名后的日程'
  );

  section('20. 时间冲突检测');
  const cA = await calStore.createSchedule({ title: 'A', date: '2026-10-01', start: '10:00', end: '11:30' });
  const cB = await calStore.createSchedule({ title: 'B', date: '2026-10-01', start: '11:00', end: '12:00' });
  const cC = await calStore.createSchedule({ title: 'C', date: '2026-10-01', start: '11:31', end: '12:30' });
  const conflicts = conflictsIn(occurrencesOn(calStore.listSchedules(), '2026-10-01'));
  ok(Object.keys(conflicts).length === 3, 'A↔B、B↔C 各算一次冲突', JSON.stringify(Object.keys(conflicts)));
  ok(conflicts[`${cB.id}@2026-10-01`].sort().join(',') === 'A,C', '中间的 B 与两边都冲突');
  ok(!conflicts[`${cA.id}@2026-10-01`].includes('C'), 'A（到 11:30）与 C（11:31 起）不算冲突');
  ok(conflictsIn([]).constructor === Object, '空列表返回空映射，不炸');
  await calStore.removeSchedulesForever([cA.id, cB.id, cC.id]);

  section('21. 日程回收站');
  await calStore.trashSchedules([meet.id]);
  ok(calStore.stats().schedules.trashed === 1, '日程软删除后进入回收站计数');
  ok(calStore.listSchedules().every((s) => s.id !== meet.id), '默认列表不含回收站日程');
  ok(calStore.listSchedules({ includeDeleted: true }).some((s) => s.id === meet.id), '可查询回收站里的日程');
  await calStore.restoreSchedules([meet.id]);
  ok(calStore.stats().schedules.trashed === 0, '日程还原成功');
  ok(calStore.getSchedule(meet.id).deleted === false, '还原后 deleted 复位');
  await calStore.trashSchedules([meet.id]);
  await calStore.removeSchedulesForever([meet.id]);
  ok(calStore.getSchedule(meet.id) === null, '日程彻底删除');

  section('22. 资料被彻底删除后，日程里的悬空关联要清掉');
  const doomed = await calStore.create({ type: 'text', title: '要被删掉的资料' });
  const refSched = await calStore.createSchedule({
    title: '引用这条资料的日程',
    date: '2026-10-02',
    links: [doomed.id],
  });
  ok(calStore.getSchedule(refSched.id).links.length === 1, '关联建立');
  await calStore.trash([doomed.id]);
  await calStore.removeForever([doomed.id]);
  ok(calStore.getSchedule(refSched.id).links.length === 0, '资料彻底删除后不留悬空 id');

  section('23. 拆「只改这一次」');
  const series = await calStore.createSchedule({
    title: '每周例会',
    date: '2026-11-02',
    repeat: { freq: 'weekly' },
  });
  const split = await calStore.createSchedule(splitPayload(series, '2026-11-09'));
  await calStore.updateSchedule(series.id, { repeat: repeatWithout(series.repeat, '2026-11-09') });
  const afterSplit = occurrenceStarts(calStore.getSchedule(series.id), '2026-11-01', '2026-12-01');
  ok(!afterSplit.includes('2026-11-09'), '原重复日程跳过被拆走的那一天', afterSplit.join(','));
  ok(afterSplit.includes('2026-11-16'), '其余各次不受影响');
  ok(split.repeat.freq === 'none' && split.repeatOf === series.id, '拆出来的是一条独立日程，并指回原日程');
  ok(split.date === '2026-11-09' && split.title === '每周例会', '拆出来的日程带着原来那次的日期与标题');

  section('24. 导出 .ics');
  // 前面的用例把带提醒的那条日程删掉了，这里重新造一条，专门验提醒有没有带进 VALARM
  const icsRemind = await calStore.createSchedule({
    title: '带提醒的日程',
    date: '2026-11-20',
    start: '09:00',
    end: '10:00',
    remind: 15,
  });
  const icsPath = path.join(root, 'out', '日程.ics');
  const icsOut = await lib.exportIcs(calStore.listSchedules(), icsPath, { range: 'all' });
  const icsText = await fsp.readFile(icsPath, 'utf8');
  ok(fs.existsSync(icsPath), '.ics 文件已生成');
  ok(icsText.startsWith('BEGIN:VCALENDAR') && icsText.includes('END:VCALENDAR'), 'iCalendar 结构完整');
  ok(/DTSTART;VALUE=DATE:\d{8}/.test(icsText), '全天日程用 VALUE=DATE 形式');
  ok(/DTEND;VALUE=DATE:\d{8}/.test(icsText), '全天日程的结束日期是次日（iCalendar 的排他约定）');
  ok(/DTSTART:\d{8}T\d{6}/.test(icsText), '定时日程用本地时间形式');
  ok(icsText.includes('TRIGGER:-PT15M'), '提醒设置随事件带进 VALARM');
  ok(icsText.includes(`UID:${icsRemind.id}-2026-11-20@my-life`), '每个事件的 UID 稳定可追溯');
  ok(icsText.includes('SUMMARY:'), '每个事件都有标题');
  ok(icsOut.events > 0 && icsOut.events >= icsOut.schedules, '展开出的 VEVENT 数量合理', JSON.stringify(icsOut));
  let icsThrew = false;
  try {
    await lib.exportIcs([], path.join(root, 'out', '空.ics'));
  } catch {
    icsThrew = true;
  }
  ok(icsThrew, '没有日程时导出直接报错，不生成空文件');

  section('25. 导出 Markdown 附带相关日程');
  const mdHost = await calStore.create({
    type: 'text',
    title: '带日程的资料',
    content: '正文内容',
    date: '2026-12-01',
  });
  const mdSched = await calStore.createSchedule({
    title: '跟这条资料有关的会',
    date: '2026-12-01',
    start: '14:00',
    end: '15:00',
    links: [mdHost.id],
    tags: ['会议'],
  });
  const plainMd = buildMarkdown([mdHost]);
  ok(!plainMd.includes('相关日程'), '不勾选时不会多出「相关日程」段落');
  const richMd = buildMarkdown([mdHost], { includeSchedules: true, schedules: calStore.listSchedules() });
  ok(richMd.includes('### 相关日程'), '勾选后多出「相关日程」段落');
  ok(richMd.includes('跟这条资料有关的会'), '段落里含日程标题');
  ok(richMd.includes('14:00–15:00'), '段落里含时间段');

  section('26. 备份 / 恢复要带上日程');
  const calZip = path.join(root, 'cal-备份.zip');
  await lib.createBackup(calZip, calStore);
  const schedBefore = calStore.listSchedules().length;
  const schedTitlesBefore = calStore
    .listSchedules()
    .map((s) => s.title)
    .sort()
    .join('|');
  await calStore.createSchedule({ title: '备份之后才建的日程', date: '2026-12-31' });
  await calStore.trashSchedules([mdSched.id]);
  const calInfo = await lib.inspectBackup(calZip);
  ok((calInfo.data.schedules || []).length === schedBefore, '备份里含日程', String(schedBefore));
  const calRestored = await lib.restoreBackup(calZip, calStore);
  ok(calRestored.schedules === schedBefore, '恢复后日程条数回到备份时', String(calRestored.schedules));
  ok(
    calStore
      .listSchedules()
      .map((s) => s.title)
      .sort()
      .join('|') === schedTitlesBefore,
    '恢复后每条日程与备份时完全一致'
  );
  ok(
    !calStore.listSchedules().some((s) => s.title === '备份之后才建的日程'),
    '备份之后新建的日程被覆盖掉'
  );
  ok(calStore.getSchedule(mdSched.id).deleted === false, '被移到回收站的日程恢复后回来了');

  section('27. 清空回收站要连日程一起清');
  await calStore.trashSchedules([mdSched.id]);
  const emptied = await calStore.emptyTrash();
  ok(emptied >= 1, '清空回收站返回清掉的总条数（资料 + 日程）', String(emptied));
  ok(calStore.getSchedule(mdSched.id) === null, '日程被彻底删除');
  ok(calStore.getSchedule(refSched.id) !== null, '没进回收站的日程不受影响');
  ok(calStore.stats().schedules.trashed === 0, '回收站里的日程清空后计数归零');

  section('28. 标签体系是资料与日程共用的');
  await calStore.create({ type: 'text', title: '带标签的资料', tags: ['共标签'] });
  await calStore.createSchedule({ title: '带标签的日程', date: '2026-12-05', tags: ['共标签'] });
  const tagStat = calStore.stats().tags.find((t) => t.name === '共标签');
  ok(tagStat && tagStat.count === 2, '同一标签在资料与日程上合并计数', JSON.stringify(tagStat));
  ok(calStore.stats().schedules.repeating >= 1, 'stats 里统计了重复日程的条数');

  section('29. 老版本 archive.json（没有 schedules 字段）');
  const oldDir = path.join(root, 'old-lib');
  await fsp.mkdir(path.join(oldDir, 'attachments'), { recursive: true });
  await fsp.writeFile(
    path.join(oldDir, 'archive.json'),
    JSON.stringify({
      version: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      categories: ['经历'],
      entries: [
        {
          id: 'e1',
          type: 'text',
          title: '旧资料',
          content: '本文件里根本没有 schedules 字段。',
          date: '2026-09-01',
          category: '经历',
          tags: [],
          attachments: [],
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
          deleted: false,
        },
      ],
    }),
    'utf8'
  );
  const oldStore = new ArchiveStore(oldDir);
  await oldStore.load();
  ok(Array.isArray(oldStore.data.schedules) && oldStore.data.schedules.length === 0, '老文件读入后 schedules 归一化成空数组');
  ok(oldStore.data.entries.length === 1, '老资料一条都没丢');
  ok(oldStore.data.version === 2, '内存里的版本号已升到 2');
  const oldNew = await oldStore.createSchedule({ title: '在老资料库上新建的日程', date: '2026-10-10' });
  const oldRaw = JSON.parse(await fsp.readFile(path.join(oldDir, 'archive.json'), 'utf8'));
  ok(oldRaw.schedules.length === 1 && oldRaw.schedules[0].id === oldNew.id, '新日程正常写回老档案文件');
  ok(oldRaw.entries.length === 1, '写回时没有破坏原有资料');

  // ==========================================================================
  // 飞书日历同步（纯映射 + 配置存储，不触网）
  // ==========================================================================

  section('30. 飞书日历同步：纯映射函数 + 配置存储');

  // electron 只在主进程里存在；这里给个最小桩，让 feishu.js 能被 require
  const Module = require('node:module');
  const _origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'electron') return { shell: { openExternal: async () => {} } };
    return _origLoad.apply(this, arguments);
  };
  const {
    FeishuClient,
    encryptJSON,
    decryptJSON,
    rruleToMyLifeRepeat,
  } = require('../src/main/feishu');
  const { feishuEventToSchedule, scheduleToFeishuEvent, findByEventId } = require('../src/main/sync');

  // 配置存储（不依赖网络）
  ok(lib.getFeishuConfig().appId === '', '飞书配置默认空');
  lib.setFeishuConfig({ appId: 'cli_test', autoSync: true });
  ok(lib.getFeishuConfig().appId === 'cli_test', '可写入并读回 App ID');
  ok(lib.getFeishuConfig().autoSync === true, '自动同步开关可保存');
  ok(lib.getFeishuConfig().redirectPort === 18925, '回调端口保留默认值');
  const fclient = new FeishuClient(lib);
  ok(fclient.status().configured === false, '只配了 appId 没有 secret，视为未配置完成');
  lib.setFeishuConfig({ appSecret: 's3cret' });
  ok(fclient.status().configured === true, 'appId + appSecret 齐了才算 configured');
  ok(fclient.isLoggedIn() === false, '没有令牌不算已登录');

  // 令牌加密 / 解密 往返
  const tok = { access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() + 3600e3 };
  const enc = encryptJSON(tok, 's3cret');
  ok(typeof enc === 'string' && enc !== JSON.stringify(tok), '令牌被加密成字符串');
  const dec = decryptJSON(enc, 's3cret');
  ok(dec && dec.access_token === 'AT' && dec.refresh_token === 'RT', '解密能还原令牌');
  ok(decryptJSON(enc, 'wrong') === null, '错误密钥解不开（返回 null）');

  // 飞书事件 → My Life 日程
  const ev = {
    event_id: 'evt_1',
    summary: '飞书例会',
    description: '<p>带 <b>HTML</b> 的备注</p>',
    start: { time: '2026-10-01T10:00:00+08:00' },
    end: { time: '2026-10-01T11:30:00+08:00' },
    event_location: { name: '三楼会议室' },
    recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
  };
  const sch = feishuEventToSchedule(ev, 'cal_primary');
  ok(sch.source === 'feishu', '映射结果标记为飞书来源');
  ok(sch.feishu.calendarId === 'cal_primary' && sch.feishu.eventId === 'evt_1', '记录飞书日历与事件 id');
  ok(sch.title === '飞书例会' && sch.date === '2026-10-01', '标题与日期解析正确');
  ok(sch.start === '10:00' && sch.end === '11:30', '起止时间解析正确');
  ok(sch.location === '三楼会议室', '地点解析正确');
  ok(sch.note === '带 HTML 的备注', 'HTML 备注被脱成纯文本');
  ok(sch.repeat && sch.repeat.freq === 'weekly' && sch.repeat.count === 4, 'RRULE 周重复 + 次数映射正确');

  // 全天事件
  const allDayEv = { event_id: 'evt_2', summary: '放假', start: { date: '2026-10-02' }, end: { date: '2026-10-03' } };
  const allDaySch = feishuEventToSchedule(allDayEv, 'cal_primary');
  ok(allDaySch.allDay === true && allDaySch.date === '2026-10-02', '全天事件识别为 allDay');

  // 取消的事件
  const cancelled = feishuEventToSchedule({ event_id: 'evt_3', status: 'cancelled' }, 'cal_primary');
  ok(cancelled.__cancelled === true && cancelled.eventId === 'evt_3', '已取消的事件标记待清理');

  // My Life 日程 → 飞书事件 body
  const toFeishu = scheduleToFeishuEvent({
    title: '本地日程',
    date: '2026-10-05',
    start: '09:00',
    end: '10:00',
    location: '二楼',
    note: '备注',
  });
  ok(toFeishu.summary === '本地日程', '上传标题正确');
  ok(toFeishu.start_time.time.includes('2026-10-05T09:00'), '上传定时字段带本地时间');
  ok(toFeishu.end_time.time.includes('10:00'), '上传结束时间正确');
  ok(toFeishu.event_location && toFeishu.event_location.name === '二楼', '上传地点正确');
  const allDayUp = scheduleToFeishuEvent({ title: '全天', date: '2026-10-06', allDay: true });
  ok(allDayUp.start_time.date === '2026-10-06', '全天上传用 date 字段');

  // RRULE → repeat 直测（含不支持的 INTERVAL 保留兼容字段）
  const rI = rruleToMyLifeRepeat('RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261231T160000Z');
  ok(rI && rI.freq === 'daily' && rI.interval === 2 && rI.until === '2026-12-31', '每日隔天 + until 映射正确');
  ok(rruleToMyLifeRepeat('FREQ=HOURLY') === null, '不支持的频率返回 null（退化单实例）');

  // findByEventId
  const storeForFs = new ArchiveStore(path.join(root, 'fs-lib'));
  await storeForFs.load();
  const fsSched = await storeForFs.createSchedule({
    title: '飞书来的',
    date: '2026-10-07',
    source: 'feishu',
    feishu: { calendarId: 'cal_primary', eventId: 'evt_x', updatedAt: 't' },
  });
  const found = findByEventId(storeForFs, 'cal_primary', 'evt_x');
  ok(found && found.id === fsSched.id, '能按 日历+事件id 找到本机对应日程');
  ok(findByEventId(storeForFs, 'cal_primary', 'nope') === null, '找不到时返回 null');

  Module._load = _origLoad;

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