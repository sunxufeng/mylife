'use strict';
/* ==========================================================================
   My Life —— 轻量 Markdown 渲染器（无依赖）
   先转义 HTML，再套用规则，所以内容里的 <script> 之类不会被当标签执行。
   支持：标题 / 粗体 / 斜体 / 删除线 / 行内代码 / 代码块 / 引用 / 有序无序列表 /
        任务列表 / 表格 / 分割线 / 链接 / 图片
   ========================================================================== */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 只放行安全的链接协议 */
function safeUrl(url, opts = {}) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (opts.image && /^archive:\/\//i.test(u)) return u; // 资料库附件
  if (/^https?:\/\//i.test(u)) return u;
  if (opts.image && /^data:image\//i.test(u)) return u;
  if (opts.image && !/^[a-z]+:/i.test(u)) return u; // 相对路径的图片
  return '';
}

function renderInline(src) {
  let text = escapeHtml(src);
  const codes = [];
  // 行内代码先抠出来，避免里面的 * _ 被当成标记
  text = text.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  // 图片 ![alt](url)
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (m, alt, url, title) => {
    const href = safeUrl(url, { image: true });
    if (!href) return m;
    return `<img src="${href}" alt="${alt}"${title ? ` title="${title}"` : ''}>`;
  });
  // 链接 [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (m, label, url, title) => {
    const href = safeUrl(url);
    if (!href) return m;
    return `<a href="${href}" target="_blank" rel="noreferrer"${title ? ` title="${title}"` : ''}>${label}</a>`;
  });
  // 裸链接（不跟在引号或 = 后面）
  text = text.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>()]+)/g, (m, pre, url) => {
    return `${pre}<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`;
  });

  text = text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>');

  text = text.replace(/\u0000C(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
  return text;
}

/** 表格：返回 { html, next } 或 null */
function tryTable(lines, i) {
  const head = lines[i];
  const sep = lines[i + 1];
  if (!head || !sep) return null;
  if (!head.includes('|')) return null;
  if (!/^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(sep)) return null;
  const cells = (line) =>
    line
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((c) => c.trim());
  const heads = cells(head);
  const aligns = cells(sep).map((s) => {
    const left = s.startsWith(':');
    const right = s.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return left ? 'left' : '';
  });
  let j = i + 2;
  const rows = [];
  while (j < lines.length && lines[j].includes('|') && lines[j].trim()) {
    rows.push(cells(lines[j]));
    j++;
  }
  const style = (k) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : '');
  let html = '<table><thead><tr>';
  heads.forEach((c, k) => (html += `<th${style(k)}>${renderInline(c)}</th>`));
  html += '</tr></thead><tbody>';
  for (const r of rows) {
    html += '<tr>';
    for (let k = 0; k < heads.length; k++) html += `<td${style(k)}>${renderInline(r[k] || '')}</td>`;
    html += '</tr>';
  }
  html += '</tbody></table>';
  return { html, next: j };
}

function mdToHtml(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const para = [];
  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${para.join('<br>')}</p>`);
    para.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)\s*$/);
    if (fence) {
      flushPara();
      const mark = fence[1];
      const lang = fence[2];
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${mark}\\s*$`).test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾的 ```
      out.push(
        `<pre class="md-code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(buf.join('\n'))}</code></pre>`
      );
      continue;
    }

    // 空行
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    // 分割线
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
      flushPara();
      out.push('<hr>');
      i++;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const lv = h[1].length;
      out.push(`<h${lv} class="md-h${lv}">${renderInline(h[2].trim())}</h${lv}>`);
      i++;
      continue;
    }

    // 引用（可连续多行）
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${mdToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // 表格
    const table = tryTable(lines, i);
    if (table) {
      flushPara();
      out.push(table.html);
      i = table.next;
      continue;
    }

    // 列表
    const ul = line.match(/^\s*([-*+])\s+(.*)$/);
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      const items = [];
      while (i < lines.length) {
        const m = ordered
          ? lines[i].match(/^\s*(\d+)[.)]\s+(.*)$/)
          : lines[i].match(/^\s*([-*+])\s+(.*)$/);
        if (!m) {
          // 支持列表项里的续行（缩进）
          if (items.length && /^\s{2,}\S/.test(lines[i])) {
            items[items.length - 1] += '<br>' + renderInline(lines[i].trim());
            i++;
            continue;
          }
          break;
        }
        let body = m[2];
        const task = body.match(/^\[([ xX])\]\s*(.*)$/);
        if (task) {
          const checked = task[1].toLowerCase() === 'x';
          items.push(
            `<li class="md-task"><span class="md-check${checked ? ' on' : ''}">${checked ? '✓' : ''}</span>${renderInline(task[2])}</li>`
          );
        } else {
          items.push(`<li>${renderInline(body)}</li>`);
        }
        i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    // 普通段落（单换行按 <br> 处理，录入笔记更顺手）
    para.push(renderInline(line));
    i++;
  }
  flushPara();
  return out.join('\n');
}

/** 详情页渲染用：包一层容器 */
function renderMarkdown(src) {
  return `<div class="md-body">${mdToHtml(src)}</div>`;
}

/** 纯文本摘要（列表里显示用），去掉常见标记 */
function mdToPlain(src) {
  return String(src == null ? '' : src)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`=|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
