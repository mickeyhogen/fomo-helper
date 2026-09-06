/*! Fomo放大镜 · Fomo Helper — © 2026 0xHogen (https://x.com/0xHogen)
 *  Source: https://github.com/mickeyhogen/fomo-helper · MIT License
 *  Derivative builds: keep this notice and the visible "By @0xHogen" attribution. */
/** Public settings: three sites, bilingual UI, no custom data sources. */
'use strict';

const OPEN_MODES = ['compact', 'full', 'off'];
const DEFAULTS = {
  openMode: 'compact',
  caPageAutoOpen: true,
  hoverPreview: true,
  updateCheck: true,
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

function resolveCaPageAutoOpen(v) {
  return typeof v.caPageAutoOpen === 'boolean' ? v.caPageAutoOpen : resolveOpenMode(v) !== 'off';
}

const el = (id) => document.getElementById(id);
const ui = {
  openMode: el('openMode'),
  caPageAutoOpen: el('caPageAutoOpen'),
  hoverPreview: el('hoverPreview'),
  updateCheck: el('updateCheck'),
  brightness: el('brightness'),
  opacity: el('opacity'),
  brightnessVal: el('brightnessVal'),
  opacityVal: el('opacityVal'),
  lang: el('lang'),
};

const EN = {
  title: 'Fomo Lens',
  intro: 'View narratives, Fomo theses and holdings on Fomo, GMGN and xxyy. Sign in to Fomo in this browser first.',
  general: 'General', openMode: 'Card content',
  compact: 'Compact (origin and rating rationale)', full: 'Fully expanded',
  openHint: 'Choose how much content to expand. Hover previews stay compact.',
  caPage: 'Current CA page', caPageOpen: 'Open by default', caPageOff: 'Keep closed by default',
  caPageHint: 'Applies when entering or switching token pages. Hover previews still work; click Fomo Lens to open manually.',
  hover: 'Hover preview', hoverHint: 'On by default; pause on a token row to preview it',
  language: 'Default language', languageHint: 'You can also switch languages in the card',
  edition: 'Check for updates', updateHint: 'Check GitHub Releases every 6 hours; turn off to stop checking.',
  brightness: 'Card brightness', opacity: 'Card opacity', opacityHint: '35%–100%; also available under ☀ in the card',
  footer: 'Settings apply immediately.',
};
const originalLabels = new Map(Array.from(document.querySelectorAll('[data-i18n]'), node => [node, node.textContent]));
const bilingual = (zh, en) => ui.lang.value === 'en' ? en : zh;
function paintPopupLanguage() {
  const english = ui.lang.value === 'en';
  document.documentElement.lang = english ? 'en' : 'zh-CN';
  document.title = english ? EN.title : 'Fomo Lens';
  for (const [node, original] of originalLabels) node.textContent = english ? (EN[node.dataset.i18n] || original) : original;
  const bver = el('bver');
  try {
    const version = chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version;
    if (bver) bver.textContent = bilingual('Fomo放大镜', 'Fomo Lens') + (version ? ' v' + version : '');
  } catch (_) { /* Keep the existing attribution if the extension is unloading. */ }
}

// Read unset values as null so existing automatic-opening preferences survive migration.
chrome.storage.sync.get(Object.assign({}, DEFAULTS, { openMode: null, autoOpen: null, caPageAutoOpen: null }), (v) => {
  const raw = v || {};
  const mode = resolveOpenMode(raw);
  // Legacy off opened manual cards fully; keep that layout when separating the settings.
  const layout = mode === 'off' ? 'full' : mode;
  const caPageAutoOpen = resolveCaPageAutoOpen(raw);
  ui.openMode.value = layout;
  ui.caPageAutoOpen.value = caPageAutoOpen ? 'open' : 'off';
  ui.hoverPreview.checked = raw.hoverPreview !== false;
  ui.updateCheck.checked = raw.updateCheck !== false;
  ui.lang.value = raw.lang === 'en' ? 'en' : 'zh';
  paintPopupLanguage();
  // Persist layout and page behavior together: an old off preference must never flash open.
  if (raw.openMode !== layout || typeof raw.caPageAutoOpen !== 'boolean') {
    chrome.storage.sync.set({ openMode: layout, caPageAutoOpen }, () => {
      if (chrome.runtime && chrome.runtime.lastError) return;
      if (raw.autoOpen !== null && raw.autoOpen !== undefined) {
        try { chrome.storage.sync.remove('autoOpen'); } catch (_) { /* 忽略 */ }
      }
    });
  }
});

// ---- 通用项：改完立刻生效 ----
ui.openMode.addEventListener('change', () => {
  const m = ui.openMode.value === 'full' ? 'full' : 'compact';
  chrome.storage.sync.set({ openMode: m });
});
ui.caPageAutoOpen.addEventListener('change', () => {
  chrome.storage.sync.set({ caPageAutoOpen: ui.caPageAutoOpen.value === 'open' });
});
ui.hoverPreview.addEventListener('change', () => {
  chrome.storage.sync.set({ hoverPreview: ui.hoverPreview.checked });
});
ui.lang.addEventListener('change', () => {
  paintPopupLanguage();
  chrome.storage.sync.set({ lang: ui.lang.value === 'en' ? 'en' : 'zh' });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.lang) {
    ui.lang.value = changes.lang.newValue === 'en' ? 'en' : 'zh';
    paintPopupLanguage();
    }
});

// 亮度/透明度存 storage.local（与卡片头部 ☀ 同源，双向实时同步）
const clampB = (v) => Math.min(150, Math.max(50, Number(v) || 100));
const clampO = (v) => Math.min(100, Math.max(35, Number(v) || 100));
chrome.storage.local.get({ displayBrightness: 100, displayOpacity: 100 }, (v) => {
  const b = clampB(v && v.displayBrightness), o = clampO(v && v.displayOpacity);
  ui.brightness.value = String(b); ui.brightnessVal.textContent = b + '%';
  ui.opacity.value = String(o); ui.opacityVal.textContent = o + '%';
});
ui.updateCheck.addEventListener('change', () => {
  chrome.storage.sync.set({ updateCheck: ui.updateCheck.checked });
});
ui.brightness.addEventListener('input', () => {
  const b = clampB(ui.brightness.value);
  ui.brightnessVal.textContent = b + '%';
  chrome.storage.local.set({ displayBrightness: b });
});
ui.opacity.addEventListener('input', () => {
  const o = clampO(ui.opacity.value);
  ui.opacityVal.textContent = o + '%';
  chrome.storage.local.set({ displayOpacity: o });
});
