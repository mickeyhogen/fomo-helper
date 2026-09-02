/**
 * 设置面板。
 *
 * 通用项即时写入；数据源项要先拿到对应源的访问授权（optional_host_permissions），
 * 授权必须在点击这个用户手势里发起，否则 Chrome 会直接拒。
 */
'use strict';

const OPEN_MODES = ['compact', 'full', 'off'];
const DEFAULTS = {
  openMode: 'compact',
  hoverPreview: true,
  lang: 'zh',
  analysisTemplate: '',
  detailTemplate: '',
  allowPrivateAnalysisSource: false,
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
  analysisTemplate: el('analysisTemplate'),
  detailTemplate: el('detailTemplate'),
  allowPrivate: el('allowPrivate'),
  msg: el('msg'),
  save: el('save'),
};

// 同时取回老的 autoOpen，供 resolveOpenMode 迁移判定（openMode/autoOpen 用 null 兜底以区分"没存过"）
chrome.storage.sync.get(Object.assign({}, DEFAULTS, { openMode: null, autoOpen: null }), (v) => {
  const raw = v || {};
  const mode = resolveOpenMode(raw);
  ui.openMode.value = mode;
  ui.hoverPreview.checked = raw.hoverPreview !== false;
  ui.lang.value = raw.lang === 'en' ? 'en' : 'zh';
  ui.analysisTemplate.value = raw.analysisTemplate || '';
  ui.detailTemplate.value = raw.detailTemplate || '';
  ui.allowPrivate.checked = !!raw.allowPrivateAnalysisSource;
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

// ---- 数据源：先校验、再授权、最后保存 ----
function say(text, kind) {
  ui.msg.textContent = text || '';
  ui.msg.className = 'msg' + (kind ? ' ' + kind : '');
}

/**
 * 只收 https 公网地址。
 * 分析源由扩展后台代发请求（带 host 授权、无 CORS 约束），一旦允许 http 或内网地址，
 * 就等于把"浏览到某个代币"变成一次可控的内网探测。详情页链接同线处理，保持一致。
 */
function isPublicHostname(hostRaw) {
  const host = String(hostRaw || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return false;
  if (host.indexOf(':') !== -1) return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const p = m.slice(1).map(Number);
    if (p.some((x) => !isFinite(x) || x > 255)) return false;
    if (p[0] === 0 || p[0] === 127 || p[0] === 10) return false;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    if (p[0] === 192 && p[1] === 168) return false;
    if (p[0] === 169 && p[1] === 254) return false;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;
    if (p[0] >= 224) return false;
    return true;
  }
  return host.indexOf('.') !== -1;
}

/**
 * 返回 origin；空串返回 null（表示"没填"）；
 * 格式不对返回 undefined；协议/主机不合规返回 false（文案要分开说）。
 * allowPrivate=true（高级开关）时放宽到任意 http/https 地址；否则只收 https 公网地址。
 */
function originOf(value, needsPlaceholder, allowPrivate) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (needsPlaceholder && raw.indexOf('{ca}') === -1) return undefined;
  let u;
  try {
    u = new URL(raw.split('{ca}').join('placeholder'));
  } catch (_) { return undefined; }
  if (allowPrivate) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return u.origin;
  }
  if (u.protocol !== 'https:' || !isPublicHostname(u.hostname)) return false;
  return u.origin;
}

ui.save.addEventListener('click', async () => {
  say('');
  const allowPrivate = !!ui.allowPrivate.checked;
  const checks = [
    { value: ui.analysisTemplate.value, ph: true, name: '分析源 URL 模板' },
    { value: ui.detailTemplate.value, ph: true, name: '详情页 URL 模板' },
  ];

  for (const c of checks) {
    const got = originOf(c.value, c.ph, allowPrivate);
    if (got === undefined) {
      say(c.name + ' 填得不对：需要合法网址，且要含 {ca}', 'err');
      return;
    }
    if (got === false) {
      say(c.name + (allowPrivate
        ? ' 填得不对：需要 http(s) 网址'
        : ' 必须是 https 公网地址（内网/自建源请勾选下方高级开关）'), 'err');
      return;
    }
  }

  // 详情页只是个可点链接，不由扩展发请求，因此不必授权；
  // 分析源要由后台 fetch，必须先拿到 host 授权。
  const needed = [];
  const analysisOrigin = originOf(ui.analysisTemplate.value, true, allowPrivate);
  if (typeof analysisOrigin === 'string') needed.push(analysisOrigin);

  if (needed.length) {
    let granted = false;
    try {
      // 必须在这个点击手势里同步发起，异步 await 之后再请求会被拒
      granted = await chrome.permissions.request({ origins: needed.map((o) => o + '/*') });
    } catch (e) {
      say('授权请求失败：' + (e && e.message ? e.message : '未知错误'), 'err');
      return;
    }
    if (!granted) {
      say('你拒绝了访问授权，设置没有保存', 'err');
      return;
    }
  }

  chrome.storage.sync.set({
    analysisTemplate: ui.analysisTemplate.value.trim(),
    detailTemplate: ui.detailTemplate.value.trim(),
    allowPrivateAnalysisSource: allowPrivate,
  }, () => say('已保存，卡片会自动刷新', 'ok'));
});
