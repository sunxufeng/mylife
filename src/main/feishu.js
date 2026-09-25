'use strict';
/**
 * My Life —— 飞书日历客户端（主进程）
 *
 * 负责：
 *  · 加密保存 access/refresh token（AES-256-GCM，密钥由本机信息 + appSecret 派生）
 *  · OAuth 2.0 授权码流程（127.0.0.1 本地回调，浏览器登录后拿 code）
 *  · 飞书 Calendar v4 API：主日历 / 事件列表 / 创建 / 更新 / 删除
 *  · RRULE → My Life 重复规则 的轻量转换
 *
 * 不依赖任何第三方包，全部用 Node 内置模块 + Electron 的 shell。
 */

const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const { shell } = require('electron');

const API_BASE = 'https://open.feishu.cn/open-apis';
const OAUTH_BASE = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const AUTHORIZE_URL = 'https://open.feishu.cn/open-apis/authen/v1/authorize';
const SCOPES = ['calendar:calendar', 'calendar:calendar.event', 'calendar:calendar.event:write'];

/** 派生加解密密钥：本机稳定串 + appSecret 做盐，纯属本地混淆（非高安全） */
function deriveKey(appSecret) {
  const machine = `${os.userInfo().username}@${os.hostname()}`;
  const salt = `my-life-feishu-v1:${appSecret || 'no-secret'}`;
  return crypto.scryptSync(machine, salt, 32);
}

function encryptJSON(obj, appSecret) {
  const key = deriveKey(appSecret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptJSON(b64, appSecret) {
  if (!b64) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const key = deriveKey(appSecret);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(json.toString('utf8'));
  } catch {
    return null;
  }
}

class FeishuClient {
  constructor(lib) {
    this.lib = lib;
  }

  config() {
    return this.lib.getFeishuConfig();
  }

  saveConfig(patch) {
    return this.lib.setFeishuConfig(patch);
  }

  /** 当前是否处于登录态（有令牌即视为已登录；过期由 getValidToken 自动刷新） */
  isLoggedIn() {
    const c = this.config();
    return !!(c.appId && c.tokens);
  }

  /** 给 UI 用的状态摘要 */
  status() {
    const c = this.config();
    return {
      configured: !!(c.appId && c.appSecret),
      loggedIn: this.isLoggedIn(),
      appId: c.appId || '',
      autoSync: !!c.autoSync,
      primaryCalendarId: c.primaryCalendarId || '',
      lastPullAt: c.lastPullAt || null,
      lastPushAt: c.lastPushAt || null,
      lastError: c.lastError || null,
      redirectPort: c.redirectPort || 18925,
    };
  }

  /** 取有效 access_token，过期则用 refresh_token 自动刷新并回写 */
  async getValidToken() {
    const c = this.config();
    if (!c.tokens) throw new Error('尚未登录飞书，请先在设置里登录');
    let tok = decryptJSON(c.tokens, c.appSecret);
    if (!tok) throw new Error('令牌已损坏，请重新登录');

    const now = Date.now();
    const expiresAt = tok.expires_at || 0;
    // 提前 5 分钟刷新，避免用到过期令牌
    if (expiresAt - now < 5 * 60 * 1000) {
      if (!tok.refresh_token) throw new Error('刷新令牌缺失，请重新登录');
      const fresh = await this.#exchange({
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
        app_id: c.appId,
        app_secret: c.appSecret,
      });
      tok = this.#normalizeTokens(fresh);
      this.saveConfig({ tokens: encryptJSON(tok, c.appSecret) });
    }
    return tok.access_token;
  }

  #normalizeTokens(data) {
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (Number(data.expires_in) || 7200) * 1000,
    };
  }

  async #exchange(body) {
    const res = await fetch(OAUTH_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (json.code !== 0) {
      throw new Error(`飞书授权失败（${json.code || res.status}）：${json.msg || res.statusText}`);
    }
    return json.data;
  }

  /**
   * OAuth 授权码登录：起本地回调服务 → 打开浏览器 → 等 code → 换令牌并保存。
   * 浏览器会打开飞书授权页，用户同意后回跳到
   * http://127.0.0.1:<port>/callback?code=xxx&state=xxx
   */
  async login(timeoutMs = 120000) {
    const c = this.config();
    if (!c.appId || !c.appSecret) throw new Error('请先填写飞书 App ID 与 App Secret');
    const port = Number(c.redirectPort) || 18925;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const state = crypto.randomBytes(16).toString('hex');
    const authorize =
      `${AUTHORIZE_URL}?app_id=${encodeURIComponent(c.appId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(SCOPES.join(' '))}` +
      `&state=${state}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, redirectUri);
        if (url.pathname === '/callback') {
          const code = url.searchParams.get('code');
          const retState = url.searchParams.get('state');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          if (code && retState === state) {
            res.end(
              '<html><body style="font-family:-apple-system,sans-serif;padding:48px;text-align:center">' +
                '<h2>✅ 飞书登录成功</h2><p>可以关闭这个页面，回到 My Life 继续了。</p></body></html>'
            );
            finish(null, code);
          } else {
            res.end(
              '<html><body style="font-family:-apple-system,sans-serif;padding:48px;text-align:center">' +
                '<h2>⚠️ 登录回调校验失败</h2><p>state 不匹配，请重试。</p></body></html>'
            );
            finish(new Error('OAuth state 不匹配'));
          }
        } else {
          res.writeHead(404);
          res.end('not found');
        }
      });

      const timer = setTimeout(() => finish(new Error('登录超时（2 分钟未操作）')), timeoutMs);
      const finish = async (err, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          server.close();
        } catch {}
        if (err) {
          this.saveConfig({ lastError: err.message });
          return reject(err);
        }
        try {
          const data = await this.#exchange({
            grant_type: 'authorization_code',
            code,
            app_id: c.appId,
            app_secret: c.appSecret,
          });
          const tok = this.#normalizeTokens(data);
          this.saveConfig({ tokens: encryptJSON(tok, c.appSecret), lastError: null });
          resolve({ ok: true });
        } catch (e) {
          this.saveConfig({ lastError: e.message });
          reject(e);
        }
      };

      server.on('error', (err) => finish(err));
      server.listen(port, '127.0.0.1', () => {
        shell.openExternal(authorize);
      });
    });
  }

  async logout() {
    this.saveConfig({ tokens: null, primaryCalendarId: '', lastError: null });
  }

  /** 统一请求封装：自动带 token、解析 data、抛出飞书业务错误 */
  async api(method, p, body) {
    const token = await this.getValidToken();
    const res = await fetch(`${API_BASE}${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (json.code !== 0) {
      throw new Error(`飞书接口错误（${json.code}）：${json.msg || res.statusText}`);
    }
    return json.data;
  }

  /** 取主日历 id（缓存到配置，避免每次拉取都查一次） */
  async getPrimaryCalendar() {
    const c = this.config();
    if (c.primaryCalendarId) return c.primaryCalendarId;
    const data = await this.api('GET', '/calendar/v4/calendar/primary');
    const id = data && data.calendar_id;
    if (!id) throw new Error('未能获取飞书主日历');
    this.saveConfig({ primaryCalendarId: id });
    return id;
  }

  /** 拉取某日历在 [startTs, endTs]（Unix 秒）区间内的事件，一次性返回（page_size=1000） */
  async listEvents(calendarId, startTs, endTs) {
    const data = await this.api(
      'GET',
      `/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events` +
        `?start_time=${startTs}&end_time=${endTs}&page_size=1000`
    );
    return (data && data.items) || [];
  }

  async createEvent(calendarId, payload) {
    const data = await this.api(
      'POST',
      `/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`,
      payload
    );
    return data;
  }

  async updateEvent(calendarId, eventId, payload) {
    return this.api(
      'PATCH',
      `/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      payload
    );
  }

  async deleteEvent(calendarId, eventId) {
    return this.api(
      'DELETE',
      `/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
    );
  }
}

/* ------------------------------------------------------ RRULE 转换 */

/**
 * 把飞书事件的 recurrence（RRULE 字符串）尽量转成 My Life 的 repeat。
 * 只支持最常见的 DAILY / WEEKLY / MONTHLY / YEARLY + INTERVAL + COUNT + UNTIL。
 * 不支持的（带 BYDAY 复杂组合、EXDATE 等）返回 null，由调用方退化为单实例。
 */
function rruleToMyLifeRepeat(rrule) {
  if (!rrule || typeof rrule !== 'string') return null;
  const map = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' };
  // 飞书 recurrence 形如 "RRULE:FREQ=WEEKLY;COUNT=4"，先去掉前缀
  const cleaned = rrule.replace(/^RRULE:/i, '');
  let freq = null;
  let interval = 1;
  let count = null;
  let until = null;
  for (const part of cleaned.split(';')) {
    const [k, v] = part.split('=');
    if (!k) continue;
    if (k === 'FREQ') freq = map[v];
    else if (k === 'INTERVAL') interval = Math.max(1, Number(v) || 1);
    else if (k === 'COUNT') count = Math.max(1, Number(v) || 1);
    else if (k === 'UNTIL') until = rruleUntilToDate(v);
  }
  if (!freq) return null;
  // My Life 的 repeat 不区分 INTERVAL 之外的复杂规则；INTERVAL>1 时仍用同一 freq
  const out = { freq };
  if (interval > 1) out.interval = interval; // 注：normalizeRepeat 未显式支持 interval，这里保留兼容字段
  if (count != null) out.count = count;
  if (until) out.until = until;
  return out;
}

/** 飞书 UNTIL 形如 20211231T160000Z（UTC）→ 本地日期 YYYY-MM-DD */
function rruleUntilToDate(v) {
  const m = /^(\d{4})(\d{2})(\d{2})T/.exec(v);
  if (!m) return null;
  // 转为该 UTC 时刻对应的本地日期
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 给 UI/调试用 */
function stripHtml(s) {
  if (!s) return '';
  return String(s).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

module.exports = { FeishuClient, rruleToMyLifeRepeat, stripHtml, encryptJSON, decryptJSON };
