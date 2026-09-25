'use strict';
/**
 * My Workbench —— 飞书 ⇄ 本机 的同步编排
 *
 * 纯映射函数（feishuEventToSchedule / scheduleToFeishuEvent）不触碰网络，
 * 可以被 smoke-test 单测；编排函数（pullFromFeishu / pushToFeishu）由主进程调用，
 * 需要传入已初始化的 store 与 feishu 客户端。
 */

const { rruleToMyLifeRepeat, stripHtml } = require('./feishu');

/** 把飞书事件的 start/end 解析成 My Workbench 用的时间字段 */
function parseFeishuTime(startObj, endObj) {
  const out = { allDay: false, date: '', endDate: null, start: '', end: '' };
  if (startObj && startObj.date) {
    out.allDay = true;
    out.date = startObj.date;
    if (endObj && endObj.date && endObj.date > startObj.date) out.endDate = endObj.date;
    return out;
  }
  if (startObj && startObj.time) {
    out.allDay = false;
    out.date = startObj.time.slice(0, 10);
    out.start = startObj.time.slice(11, 16);
    if (endObj && endObj.time) {
      out.end = endObj.time.slice(11, 16);
      const ed = endObj.time.slice(0, 10);
      if (ed > out.date) out.endDate = ed;
    }
    return out;
  }
  // 都没有时间信息，退化成当天全天
  out.allDay = true;
  out.date = new Date().toISOString().slice(0, 10);
  return out;
}

/**
 * 飞书事件 → My Workbench 日程（不含 source/feishu 之外的业务键，交给 store 归一化）。
 * 返回 null 表示这是已取消的事件（调用方据此删除本地副本）。
 */
function feishuEventToSchedule(ev, calendarId) {
  if (!ev || !ev.event_id) return null;
  if (ev.status === 'cancelled') {
    return { __cancelled: true, eventId: ev.event_id };
  }
  const t = parseFeishuTime(ev.start, ev.end);
  const rrule = Array.isArray(ev.recurrence) ? ev.recurrence[0] : ev.recurrence || null;
  const repeat = rruleToMyLifeRepeat(rrule) || { freq: 'none' };
  const loc = (ev.event_location && ev.event_location.name) || ev.location || '';
  return {
    source: 'feishu',
    title: (ev.summary || '').trim() || '（无标题）',
    date: t.date,
    endDate: t.endDate,
    allDay: t.allDay,
    start: t.start,
    end: t.end,
    location: typeof loc === 'string' ? loc : '',
    note: stripHtml(ev.description || ''),
    repeat,
    feishu: {
      calendarId,
      eventId: ev.event_id,
      updatedAt: ev.update_time || '',
      syncedAt: new Date().toISOString(),
      push: false,
    },
  };
}

/** 本机日程 → 飞书事件请求体（create / update 通用） */
function scheduleToFeishuEvent(s) {
  const body = {
    summary: s.title || '（无标题）',
    description: s.note || '',
    need_notification: false,
  };
  if (s.location) body.event_location = { name: s.location };
  if (s.allDay) {
    body.start_time = { date: s.date };
    body.end_time = { date: s.endDate || s.date };
  } else {
    body.start_time = { time: localTimeStr(s.date, s.start || '00:00') };
    body.end_time = { time: localTimeStr(s.endDate || s.date, s.end || s.start || '00:00') };
  }
  return body;
}

/** 生成本地时区带偏移的时间串：YYYY-MM-DDTHH:MM:SS+08:00 */
function localTimeStr(dateStr, hm) {
  const offMin = new Date().getTimezoneOffset(); // 中国为 -480
  const sign = offMin <= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  return `${dateStr}T${hm}:00${sign}${oh}:${om}`;
}

/** 在 store 里按飞书 eventId 找已存在的日程 */
function findByEventId(store, calendarId, eventId) {
  return (
    (store.data.schedules || []).find(
      (s) => s.feishu && s.feishu.eventId === eventId && s.feishu.calendarId === calendarId
    ) || null
  );
}

/**
 * 飞书 → My Workbench（增量 upsert + 删除）。
 * 拉取主日历在 [now-30d, now+365d] 区间内的事件；以 eventId 去重更新；
 * 上次同步进来、这次不再出现的飞书事件（或已 cancelled）从本机移除（进回收站）。
 */
async function pullFromFeishu(store, feishu, { windowDays = 365, backDays = 30 } = {}) {
  const calendarId = await feishu.getPrimaryCalendar();
  const nowSec = Math.floor(Date.now() / 1000);
  const startTs = nowSec - backDays * 86400;
  const endTs = nowSec + windowDays * 86400;

  const events = await feishu.listEvents(calendarId, startTs, endTs);
  const seen = new Set();
  let created = 0;
  let updated = 0;

  for (const ev of events) {
    const mapped = feishuEventToSchedule(ev, calendarId);
    if (!mapped) continue;
    if (mapped.__cancelled) {
      seen.add(mapped.eventId);
      continue;
    }
    seen.add(mapped.eventId);
    const existing = findByEventId(store, calendarId, mapped.feishu.eventId);
    if (existing) {
      // 只更新时间/标题/地点/备注/重复，保留本机的 links/tags/category/color
      await store.updateSchedule(existing.id, {
        title: mapped.title,
        date: mapped.date,
        endDate: mapped.endDate,
        allDay: mapped.allDay,
        start: mapped.start,
        end: mapped.end,
        location: mapped.location,
        note: mapped.note,
        repeat: mapped.repeat,
        feishu: mapped.feishu,
      });
      // 若本机已手动标记「同步到飞书」，保留该意图
      if (existing.feishu && existing.feishu.push) {
        await store.updateSchedule(existing.id, { feishu: { ...mapped.feishu, push: true } });
      }
      updated += 1;
    } else {
      await store.createSchedule(mapped);
      created += 1;
    }
  }

  // 删除：本机里 source=feishu、属于该日历、但这次没拉到的（含已被飞书删除/取消的）
  const toRemove = (store.data.schedules || []).filter(
    (s) =>
      !s.deleted &&
      s.source === 'feishu' &&
      s.feishu &&
      s.feishu.calendarId === calendarId &&
      s.feishu.eventId &&
      !seen.has(s.feishu.eventId)
  );
  let removed = 0;
  if (toRemove.length) {
    await store.trashSchedules(toRemove.map((s) => s.id));
    removed = toRemove.length;
  }

  feishu.saveConfig({ lastPullAt: new Date().toISOString(), lastError: null });
  return { created, updated, removed, pulled: events.length, total: store.data.schedules.length };
}

/**
 * My Workbench → 飞书（手动，按需）。只推送本机里「同步到飞书」(feishu.push=true) 的日程：
 * 没有 eventId 的就创建；有 eventId 的就更新。返回汇总。
 */
async function pushToFeishu(store, feishu) {
  const calendarId = await feishu.getPrimaryCalendar();
  const candidates = (store.data.schedules || []).filter(
    (s) => !s.deleted && s.source === 'local' && s.feishu && s.feishu.push === true
  );
  let created = 0;
  let updated = 0;
  for (const s of candidates) {
    const body = scheduleToFeishuEvent(s);
    if (s.feishu.eventId) {
      await feishu.updateEvent(calendarId, s.feishu.eventId, body);
      await store.updateSchedule(s.id, {
        feishu: { ...s.feishu, syncedAt: new Date().toISOString() },
      });
      updated += 1;
    } else {
      const data = await feishu.createEvent(calendarId, body);
      const eventId = data && data.event_id;
      await store.updateSchedule(s.id, {
        feishu: {
          calendarId,
          eventId: eventId || '',
          syncedAt: new Date().toISOString(),
          push: true,
        },
      });
      created += 1;
    }
  }
  feishu.saveConfig({ lastPushAt: new Date().toISOString(), lastError: null });
  return { created, updated, total: candidates.length };
}

module.exports = {
  feishuEventToSchedule,
  scheduleToFeishuEvent,
  parseFeishuTime,
  localTimeStr,
  findByEventId,
  pullFromFeishu,
  pushToFeishu,
};
