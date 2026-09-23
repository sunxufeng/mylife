'use strict';
/* ==========================================================================
   My Life —— 日期 / 重复规则 / 冲突检测（纯函数）
   同一份文件被两边复用：
     · 渲染进程：index.html 里当普通 <script> 加载
     · 主进程 / Node 自测：require('../renderer/schedule.js')
   所以这里不能碰 DOM，也不能碰 Electron。
   ========================================================================== */

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
const SCHEDULE_COLORS = ['moss', 'amber', 'blue', 'coral', 'pink', 'gray'];
const COLOR_NAMES = {
  moss: '苔绿',
  amber: '琥珀',
  blue: '雾蓝',
  coral: '珊瑚',
  pink: '藕粉',
  gray: '石灰',
};
const REPEAT_FREQS = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
const REPEAT_NAMES = {
  none: '不重复',
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  yearly: '每年',
};
/** 提醒选项：v 是「提前多少分钟」，空字符串代表不提醒 */
const REMIND_OPTIONS = [
  { v: '', l: '不提醒' },
  { v: '0', l: '准点' },
  { v: '5', l: '提前 5 分钟' },
  { v: '15', l: '提前 15 分钟' },
  { v: '30', l: '提前 30 分钟' },
  { v: '60', l: '提前 1 小时' },
  { v: '1440', l: '提前 1 天' },
];
/** 重复展开的硬上限，防止「每天 · 无限」把循环跑死 */
const MAX_STEPS = 4000;

/* ------------------------------------------------------------------ 日期 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function dateToStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 'YYYY-MM-DD' → 本地零点的 Date（非法返回 null） */
function parseDate(s) {
  if (!isDateStr(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

function todayStr(base) {
  return dateToStr(base instanceof Date ? base : new Date());
}

function addDays(s, n) {
  const d = parseDate(s);
  if (!d) return s;
  d.setDate(d.getDate() + n);
  return dateToStr(d);
}

/** b - a，单位天（b 晚于 a 为正） */
function diffDays(a, b) {
  const da = parseDate(a);
  const db = parseDate(b);
  if (!da || !db) return NaN;
  return Math.round((db - da) / 86400000);
}

function weekdayOf(s) {
  const d = parseDate(s);
  return d ? d.getDay() : 0;
}

/** m 用 1-12 */
function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate();
}

function monthStart(s) {
  const d = parseDate(s);
  if (!d) return todayStr();
  return dateToStr(new Date(d.getFullYear(), d.getMonth(), 1));
}

function monthEnd(s) {
  const d = parseDate(s);
  if (!d) return todayStr();
  return dateToStr(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

function addMonths(s, n) {
  const d = parseDate(s);
  if (!d) return s;
  const ref = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const dim = daysInMonth(ref.getFullYear(), ref.getMonth() + 1);
  return dateToStr(new Date(ref.getFullYear(), ref.getMonth(), Math.min(d.getDate(), dim)));
}

/** 月视图 6×7 网格（周一开头），返回 42 个日期字符串 */
function monthGrid(anchor) {
  const first = monthStart(anchor);
  const d = parseDate(first);
  const offset = (d.getDay() + 6) % 7; // 周日=0 → 周一开头
  const start = addDays(first, -offset);
  const days = [];
  for (let i = 0; i < 42; i++) days.push(addDays(start, i));
  return { start, end: days[41], days };
}

/** 日期落在第几周（以周一为一周开始） */
function weekStart(s) {
  const d = parseDate(s);
  if (!d) return s;
  return addDays(s, -((d.getDay() + 6) % 7));
}

function fmtMonthTitle(s) {
  const d = parseDate(s);
  return d ? `${d.getFullYear()} 年 ${d.getMonth() + 1} 月` : '';
}

function fmtMonthDay(s) {
  const d = parseDate(s);
  return d ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : '';
}

function fmtDayTitle(s) {
  const d = parseDate(s);
  if (!d) return '';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WEEK_CN[d.getDay()]}`;
}

function fmtCnDate(s) {
  const d = parseDate(s);
  if (!d) return '';
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

function fmtSlashDate(s) {
  if (!isDateStr(s)) return '';
  const [y, m, d] = s.split('-');
  return `${y}/${m}/${d}`;
}

/** 今天 / 明天 / 昨天 / 9 月 23 日 */
function fmtRelDay(s, base) {
  const today = todayStr(base);
  const n = diffDays(today, s);
  if (n === 0) return '今天';
  if (n === 1) return '明天';
  if (n === 2) return '后天';
  if (n === -1) return '昨天';
  return fmtMonthDay(s);
}

/* ------------------------------------------------------------------ 时间 */

function hmToMin(hm) {
  if (!/^\d{1,2}:\d{2}$/.test(String(hm || ''))) return null;
  const [h, m] = String(hm).split(':').map(Number);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function minToHm(min) {
  const n = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  return `${pad2(Math.floor(n / 60))}:${pad2(n % 60)}`;
}

function isValidHm(hm) {
  return hmToMin(hm) != null;
}

/** 日程的时间段（分钟），全天或没填时间返回 null */
function timedRange(sch) {
  if (!sch || sch.allDay) return null;
  const s = hmToMin(sch.start);
  if (s == null) return null;
  let e = hmToMin(sch.end);
  if (e == null || e <= s) e = s + 30;
  return [s, e];
}

/** '10:00–11:30' / '10:00' / '全天' */
function fmtTime(sch) {
  if (!sch) return '';
  if (sch.allDay) return '全天';
  const s = hmToMin(sch.start);
  if (s == null) return '全天';
  const e = hmToMin(sch.end);
  return `${minToHm(s)}–${minToHm(e == null || e <= s ? s + 30 : e)}`;
}

/* ------------------------------------------------------------ 重复与展开 */

function normalizeRepeat(rep) {
  const r = rep && typeof rep === 'object' ? rep : {};
  const freq = REPEAT_FREQS.includes(r.freq) ? r.freq : 'none';
  const out = { freq };
  if (isDateStr(r.until)) out.until = r.until;
  const count = Number(r.count);
  if (Number.isInteger(count) && count > 0) out.count = count;
  const skip = Array.isArray(r.skip) ? [...new Set(r.skip.filter(isDateStr))].sort() : [];
  if (skip.length) out.skip = skip;
  return out;
}

function repeatDesc(rep) {
  const r = normalizeRepeat(rep);
  if (r.freq === 'none') return '';
  const bits = [REPEAT_NAMES[r.freq]];
  if (r.until) bits.push(`至 ${fmtSlashDate(r.until)}`);
  if (r.count) bits.push(`共 ${r.count} 次`);
  if (r.skip && r.skip.length) bits.push(`跳过 ${r.skip.length} 次`);
  return bits.join(' · ');
}

/** 日程跨几天（非跨天返回 0） */
function spanDays(sch) {
  if (!sch || !isDateStr(sch.date) || !isDateStr(sch.endDate)) return 0;
  const n = diffDays(sch.date, sch.endDate);
  return n > 0 ? n : 0;
}

/**
 * 把一条日程按重复规则展开成「开始日期」列表，只保留与
 * [rangeStart, rangeEnd] 有交集的那些次。
 * 只算规则，不预生成实例 —— 这是整个设计的核心。
 */
function occurrenceStarts(sch, rangeStart, rangeEnd) {
  if (!sch || !isDateStr(rangeStart) || !isDateStr(rangeEnd)) return [];
  const base = isDateStr(sch.date) ? sch.date : todayStr();
  const span = spanDays(sch);
  const rep = normalizeRepeat(sch.repeat);
  const out = [];
  // 'YYYY-MM-DD' 直接比字符串就是比日期先后
  const emit = (startStr) => {
    const endStr = addDays(startStr, span);
    if (endStr < rangeStart) return; // 整段都早于区间
    if (startStr > rangeEnd) return; // 整段都晚于区间
    out.push(startStr);
  };

  if (rep.freq === 'none') {
    emit(base);
    return out;
  }

  const until = rep.until || null;
  const maxCount = rep.count || Infinity;
  const hardStop = addDays(rangeEnd, 400);
  const baseDate = parseDate(base);
  let n = 0;

  const step = (i) => {
    if (rep.freq === 'daily') return addDays(base, i);
    if (rep.freq === 'weekly') return addDays(base, i * 7);
    if (rep.freq === 'monthly') {
      const ref = new Date(baseDate.getFullYear(), baseDate.getMonth() + i, 1);
      const dim = daysInMonth(ref.getFullYear(), ref.getMonth() + 1);
      return dateToStr(
        new Date(ref.getFullYear(), ref.getMonth(), Math.min(baseDate.getDate(), dim))
      );
    }
    const y = baseDate.getFullYear() + i;
    const dim = daysInMonth(y, baseDate.getMonth() + 1);
    return dateToStr(new Date(y, baseDate.getMonth(), Math.min(baseDate.getDate(), dim)));
  };

  for (let i = 0; i < MAX_STEPS; i++) {
    const cand = step(i);
    if (until && cand > until) break;
    if (rep.skip && rep.skip.includes(cand)) continue; // 被单独改过的那次不计数
    if (n >= maxCount) break;
    n++;
    if (cand > hardStop) break;
    emit(cand);
  }
  return out;
}

/**
 * 展开成「按天」的实例列表，跨天日程会覆盖到它经过的每一天，
 * 便于月视图里画成一条连续色条。
 * 返回 [{ schedule, key, date, startDate, endDate, spanStart, spanEnd, days }]
 */
function occurrencesInRange(schedules, rangeStart, rangeEnd, opts = {}) {
  const out = [];
  for (const sch of schedules || []) {
    if (!sch || typeof sch !== 'object') continue;
    if (sch.deleted && !opts.includeDeleted) continue;
    const span = spanDays(sch);
    for (const s of occurrenceStarts(sch, rangeStart, rangeEnd)) {
      const endStr = addDays(s, span);
      const days = Math.max(1, diffDays(s, endStr) + 1);
      for (let k = 0; k < days; k++) {
        const day = addDays(s, k);
        if (day < rangeStart || day > rangeEnd) continue;
        out.push({
          schedule: sch,
          key: `${sch.id}@${s}`,
          date: day,
          startDate: s,
          endDate: endStr,
          spanStart: k === 0,
          spanEnd: k === days - 1,
          days,
        });
      }
    }
  }
  return sortOccurrences(out);
}

function occurrencesOn(schedules, dateStr, opts = {}) {
  return occurrencesInRange(schedules, dateStr, dateStr, opts);
}

/** 全天在前，然后按开始时间，最后按标题 */
function sortOccurrences(list) {
  return list.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const aAll = !!a.schedule.allDay;
    const bAll = !!b.schedule.allDay;
    if (aAll !== bAll) return aAll ? -1 : 1;
    const am = hmToMin(a.schedule.start);
    const bm = hmToMin(b.schedule.start);
    if (am == null && bm == null) {
      return String(a.schedule.title || '').localeCompare(String(b.schedule.title || ''), 'zh');
    }
    if (am == null) return -1;
    if (bm == null) return 1;
    if (am !== bm) return am - bm;
    return String(a.schedule.title || '').localeCompare(String(b.schedule.title || ''), 'zh');
  });
}

/** 时间重叠检测：返回 { [occurrenceKey]: [冲突的日程标题] } */
function conflictsIn(occurrences) {
  const timed = [];
  const seen = new Set();
  for (const o of occurrences || []) {
    const r = timedRange(o.schedule);
    if (!r) continue;
    if (seen.has(o.key)) continue;
    seen.add(o.key);
    timed.push({ o, r });
  }
  const map = {};
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const A = timed[i];
      const B = timed[j];
      if (A.o.schedule.id === B.o.schedule.id) continue;
      if (A.r[0] < B.r[1] && B.r[0] < A.r[1]) {
        if (!map[A.o.key]) map[A.o.key] = [];
        if (!map[B.o.key]) map[B.o.key] = [];
        if (!map[A.o.key].includes(B.o.schedule.title)) map[A.o.key].push(B.o.schedule.title);
        if (!map[B.o.key].includes(A.o.schedule.title)) map[B.o.key].push(A.o.schedule.title);
      }
    }
  }
  return map;
}

/* ------------------------------------------------------------------ 颜色 */

/** 没选颜色时，按分类名散列出一个稳定的色标，避免每行都一个色 */
function colorOf(sch) {
  if (sch && SCHEDULE_COLORS.includes(sch.color)) return sch.color;
  const key = String((sch && (sch.category || sch.title)) || '');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 997;
  return SCHEDULE_COLORS[h % SCHEDULE_COLORS.length];
}

/* ------------------------------------------------------- 拆一次 / 跳过一次 */

/** 「只改这一次」时用的独立日程字段：重复规则清空，指回原日程 */
function splitPayload(sch, dateStr) {
  const span = spanDays(sch);
  return {
    title: sch.title,
    date: dateStr,
    endDate: span ? addDays(dateStr, span) : null,
    allDay: !!sch.allDay,
    start: sch.start || '',
    end: sch.end || '',
    location: sch.location || '',
    note: sch.note || '',
    category: sch.category || '',
    color: sch.color || '',
    tags: Array.isArray(sch.tags) ? [...sch.tags] : [],
    links: Array.isArray(sch.links) ? [...sch.links] : [],
    repeat: { freq: 'none' },
    remind: sch.remind == null ? null : sch.remind,
    done: false,
    repeatOf: sch.id,
  };
}

/** 拆分后回来把原始日程的那一次排除掉 */
function repeatWithout(rep, dateStr) {
  const r = normalizeRepeat(rep);
  const skip = [...new Set([...(r.skip || []), dateStr])].sort();
  return { ...r, skip };
}

/* -------------------------------------------------------------------- ICS */

function icsEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsStamp(d) {
  const dt = d instanceof Date ? d : new Date();
  return (
    `${dt.getUTCFullYear()}${pad2(dt.getUTCMonth() + 1)}${pad2(dt.getUTCDate())}` +
    `T${pad2(dt.getUTCHours())}${pad2(dt.getUTCMinutes())}${pad2(dt.getUTCSeconds())}Z`
  );
}

/** YYYYMMDDTHHMMSS（浮动本地时间，不写 Z） */
function icsLocal(dateStr, min) {
  const d = parseDate(dateStr);
  if (!d) return '';
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `T${pad2(Math.floor(min / 60))}${pad2(min % 60)}00`
  );
}

/** RFC5545 建议每行不超过 75 字节，超了折行并以下一行首位空格续接 */
function foldIcs(line) {
  const text = String(line);
  const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  if (!enc) return text;
  if (enc.encode(text).length <= 73) return text;
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of text) {
    const b = enc.encode(ch).length;
    if (bytes + b > 73 && cur) {
      out.push(cur);
      cur = ' ' + ch;
      bytes = 1 + b;
    } else {
      cur += ch;
      bytes += b;
    }
  }
  if (cur) out.push(cur);
  return out.join('\r\n');
}

/**
 * 生成标准 iCalendar 文本。重复日程按区间展开成多条 VEVENT，
 * 这样导进 macOS 日历 / Google 日历都能原样显示。
 */
function buildIcs(schedules, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const from = isDateStr(opts.from) ? opts.from : todayStr(now);
  const to = isDateStr(opts.to) ? opts.to : addDays(from, 365);
  const stamp = icsStamp(now);
  const occs = occurrencesInRange(schedules || [], from, to);
  const seen = new Set();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//My Life//Schedule//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:My Life 日程',
  ];

  for (const o of occs) {
    if (seen.has(o.key)) continue;
    seen.add(o.key);
    const s = o.schedule;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${icsEscape(`${s.id}-${o.startDate}@my-life`)}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`SUMMARY:${icsEscape(s.title || '未命名日程')}`);

    const st = hmToMin(s.start);
    if (s.allDay || st == null) {
      lines.push(`DTSTART;VALUE=DATE:${o.startDate.replace(/-/g, '')}`);
      lines.push(`DTEND;VALUE=DATE:${addDays(o.endDate, 1).replace(/-/g, '')}`);
    } else {
      let et = hmToMin(s.end);
      if (et == null || et <= st) et = st + 30;
      lines.push(`DTSTART:${icsLocal(o.startDate, st)}`);
      lines.push(`DTEND:${icsLocal(o.endDate, et)}`);
    }
    if (s.location) lines.push(`LOCATION:${icsEscape(s.location)}`);
    if (s.note && String(s.note).trim()) lines.push(`DESCRIPTION:${icsEscape(s.note.trim())}`);
    const cats = [s.category, ...(Array.isArray(s.tags) ? s.tags : [])].filter(Boolean);
    if (cats.length) lines.push(`CATEGORIES:${cats.map(icsEscape).join(',')}`);
    lines.push(`STATUS:${s.done ? 'CONFIRMED' : 'TENTATIVE'}`);
    if (s.remind != null && Number.isFinite(Number(s.remind))) {
      lines.push('BEGIN:VALARM');
      lines.push(`TRIGGER:-PT${Math.max(0, Math.round(Number(s.remind)))}M`);
      lines.push('ACTION:DISPLAY');
      lines.push(`DESCRIPTION:${icsEscape(s.title || '日程提醒')}`);
      lines.push('END:VALARM');
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldIcs).join('\r\n') + '\r\n';
}

/* --------------------------------------------------------------- 提醒计算 */

/** 某次日程的绝对开始时间（Date）；全天用当天 09:00 作为提醒基准 */
function occurrenceDate(sch, dateStr, fallbackHour = 9) {
  const d = parseDate(dateStr);
  if (!d) return null;
  if (sch.allDay) {
    d.setHours(fallbackHour, 0, 0, 0);
    return d;
  }
  const st = hmToMin(sch.start);
  if (st == null) {
    d.setHours(fallbackHour, 0, 0, 0);
    return d;
  }
  d.setHours(Math.floor(st / 60), st % 60, 0, 0);
  return d;
}

/** 该在什么时刻提醒（无提醒设置返回 null） */
function remindAt(sch, dateStr) {
  if (sch.remind == null || !Number.isFinite(Number(sch.remind))) return null;
  const base = occurrenceDate(sch, dateStr);
  if (!base) return null;
  return new Date(base.getTime() - Number(sch.remind) * 60000);
}

/* --------------------------------------------------------------- Node 导出 */

if (typeof module === 'object' && module.exports) {
  module.exports = {
    WEEK_CN,
    SCHEDULE_COLORS,
    COLOR_NAMES,
    REPEAT_FREQS,
    REPEAT_NAMES,
    REMIND_OPTIONS,
    pad2,
    isDateStr,
    dateToStr,
    parseDate,
    todayStr,
    addDays,
    addMonths,
    diffDays,
    weekdayOf,
    daysInMonth,
    monthStart,
    monthEnd,
    monthGrid,
    weekStart,
    fmtMonthTitle,
    fmtMonthDay,
    fmtDayTitle,
    fmtCnDate,
    fmtSlashDate,
    fmtRelDay,
    hmToMin,
    minToHm,
    isValidHm,
    timedRange,
    fmtTime,
    normalizeRepeat,
    repeatDesc,
    spanDays,
    occurrenceStarts,
    occurrencesInRange,
    occurrencesOn,
    sortOccurrences,
    conflictsIn,
    colorOf,
    splitPayload,
    repeatWithout,
    icsEscape,
    foldIcs,
    buildIcs,
    occurrenceDate,
    remindAt,
  };
}
