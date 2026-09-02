/**
 * 设置面板（公开版）。
 *
 * 公开版只有通用项，改完即时写入。自定义分析源与其授权/SSRF 校验属自用版，
 * 公开版整体不含该能力，因此这里没有任何需要 host 授权的入口。
 */
'use strict';

const OPEN_MODES = ['compact', 'full', 'off'];
const DEFAULTS = {
  openMode: 'compact',
  hoverPreview: true,
  lang: 'zh',
};

/**
 * openMode 归一 + 迁移：显式合法值优先；否则回落老的 autoOpen 布尔
 * （true→'compact'，false→'off'）；都没有 → 'compact'。
 */
function resolveOpenMode(v) {
  const m = v && v.openMode;
  if (OPEN_MODES.indexOf(m) !== -1) return m;
  if (v && v.autoOpen === false) return 'off';
  if (v && v.autoOpen === true) return 'compact';
  return 'compact';
}

const el = (id) => document.getElementById(id);
const ui = {
  openMode: el('openMode'),
  hoverPreview: el('hoverPreview'),
  lang: el('lang'),
};

// 同时取回老的 autoOpen，供 resolveOpenMode 迁移判定（openMode/autoOpen 用 null 兜底以区分"没存过"）
chrome.storage.sync.get(Object.assign({}, DEFAULTS, { openMode: null, autoOpen: null }), (v) => {
  const raw = v || {};
  const mode = resolveOpenMode(raw);
  ui.openMode.value = mode;
  ui.hoverPreview.checked = raw.hoverPreview !== false;
  ui.lang.value = raw.lang === 'en' ? 'en' : 'zh';
  // 迁移落地：从老 autoOpen 迁上来（storage 里没有合法 openMode）时，把 openMode 写实、清掉 autoOpen
  if (OPEN_MODES.indexOf(raw.openMode) === -1) {
    chrome.storage.sync.set({ openMode: mode });
    if ('autoOpen' in raw && raw.autoOpen !== null) {
      try { chrome.storage.sync.remove('autoOpen'); } catch (_) { /* 忽略 */ }
    }
  }
});

// ---- 通用项：改完立刻生效 ----
ui.openMode.addEventListener('change', () => {
  const m = OPEN_MODES.indexOf(ui.openMode.value) !== -1 ? ui.openMode.value : 'compact';
  chrome.storage.sync.set({ openMode: m });
});
ui.hoverPreview.addEventListener('change', () => {
  chrome.storage.sync.set({ hoverPreview: ui.hoverPreview.checked });
});
ui.lang.addEventListener('change', () => {
  chrome.storage.sync.set({ lang: ui.lang.value === 'en' ? 'en' : 'zh' });
});
