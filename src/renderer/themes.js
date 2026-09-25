'use strict';
/* ==========================================================================
   My Workbench —— 配色主题
   每套主题只覆盖 CSS 变量；--moss* 是「强调色」的通用命名（历史原因沿用）。
   swatch = [浅色底, 强调色]，用于设置面板里的斜角色卡。
   ========================================================================== */

const THEMES = {
  sand: {
    name: '暖沙色系',
    swatch: ['#f8f3ea', '#b08248'],
    vars: {
      '--bg': '#f8f3ea',
      '--bg-deep': '#f1e9dc',
      '--panel': '#fffdf8',
      '--panel-2': '#fcf8f1',
      '--panel-3': '#f6efe3',
      '--line': '#e6dbc8',
      '--line-soft': '#f0e8da',
      '--ink': '#302b23',
      '--ink-2': '#5a5245',
      '--ink-3': '#8d8375',
      '--ink-4': '#aaa091',
      '--moss': '#b08248',
      '--moss-deep': '#8e6836',
      '--moss-soft': '#f4ead8',
      '--moss-line': '#e0cdac',
      '--gold': '#a9822f',
      '--gold-soft': '#f6ecd4',
      '--danger': '#a65a46',
      '--danger-soft': '#f8eae3',
    },
  },
  mist: {
    name: '雾蓝色系',
    swatch: ['#eef3f8', '#4f7391'],
    vars: {
      '--bg': '#f2f5f8',
      '--bg-deep': '#e8eef3',
      '--panel': '#fdfefe',
      '--panel-2': '#f7fafc',
      '--panel-3': '#eef3f7',
      '--line': '#d9e2ea',
      '--line-soft': '#e8eef4',
      '--ink': '#262b30',
      '--ink-2': '#4d565f',
      '--ink-3': '#7f8a94',
      '--ink-4': '#9ea9b3',
      '--moss': '#4f7391',
      '--moss-deep': '#3b5a75',
      '--moss-soft': '#e4edf4',
      '--moss-line': '#c2d5e2',
      '--gold': '#a98a4e',
      '--gold-soft': '#f2ecdd',
      '--danger': '#a8544e',
      '--danger-soft': '#f7e8e6',
    },
  },
  clay: {
    name: '陶土橙色系',
    swatch: ['#fbf1e7', '#c2683a'],
    vars: {
      '--bg': '#fbf3ea',
      '--bg-deep': '#f6e9db',
      '--panel': '#fffdfa',
      '--panel-2': '#fdf7f0',
      '--panel-3': '#f8ede1',
      '--line': '#ecdcc8',
      '--line-soft': '#f4e8da',
      '--ink': '#33291f',
      '--ink-2': '#5e5044',
      '--ink-3': '#918274',
      '--ink-4': '#ada08f',
      '--moss': '#c2683a',
      '--moss-deep': '#9c4f28',
      '--moss-soft': '#fae7da',
      '--moss-line': '#ebc4a9',
      '--gold': '#b1873f',
      '--gold-soft': '#f7ead2',
      '--danger': '#a8483c',
      '--danger-soft': '#f9e5e0',
    },
  },
  sage: {
    name: '鼠尾草绿系',
    swatch: ['#f6f2ea', '#6e8163'],
    vars: {
      '--bg': '#f6f2ea',
      '--bg-deep': '#efe9dd',
      '--panel': '#fffdf9',
      '--panel-2': '#fbf8f1',
      '--panel-3': '#f4efe5',
      '--line': '#e4dbcb',
      '--line-soft': '#eee7da',
      '--ink': '#2c2a25',
      '--ink-2': '#55504a',
      '--ink-3': '#8b8375',
      '--ink-4': '#a9a294',
      '--moss': '#6e8163',
      '--moss-deep': '#55684b',
      '--moss-soft': '#e8eee1',
      '--moss-line': '#cdd8c0',
      '--gold': '#b08d57',
      '--gold-soft': '#f3ead8',
      '--danger': '#a65a4c',
      '--danger-soft': '#f7e9e5',
    },
  },
  wine: {
    name: '深酒红色系',
    swatch: ['#f9eeee', '#8e2f3c'],
    vars: {
      '--bg': '#f9f0f0',
      '--bg-deep': '#f3e4e5',
      '--panel': '#fffdfd',
      '--panel-2': '#fcf7f7',
      '--panel-3': '#f6eaea',
      '--line': '#e8d3d4',
      '--line-soft': '#f2e4e5',
      '--ink': '#302526',
      '--ink-2': '#5b4a4c',
      '--ink-3': '#8e7b7d',
      '--ink-4': '#aa9899',
      '--moss': '#8e2f3c',
      '--moss-deep': '#6f1f2b',
      '--moss-soft': '#f7e3e6',
      '--moss-line': '#e3bfc4',
      '--gold': '#a8863f',
      '--gold-soft': '#f5e9d3',
      '--danger': '#a63a3a',
      '--danger-soft': '#f8e4e4',
    },
  },
};

const THEME_ORDER = ['sand', 'mist', 'clay', 'sage', 'wine'];
const DEFAULT_THEME = 'sage';

/** 把主题变量写到 :root 上 */
function applyTheme(key) {
  const theme = THEMES[key] || THEMES[DEFAULT_THEME];
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.vars)) {
    root.style.setProperty(k, v);
  }
  // 让原生控件的配色（滚动条、表单控件、选中高亮）也跟着走
  root.style.setProperty('color-scheme', 'light');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.vars['--bg']);
  return key in THEMES ? key : DEFAULT_THEME;
}
