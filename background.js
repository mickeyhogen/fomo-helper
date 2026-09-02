/**
 * Fomo叙事镜 — background service worker
 *
 * 代发那些没有对 fomo.family 开放 CORS、必须由持 host_permissions 的后台来请求的源：
 *   1. DeBot 公开叙事 API   —— 卡片主体（固定公开端点，无需配置）
 *   2. 自定义分析源         —— 用户自己配的 JSON URL 模板，没配就整段不存在
 *   3. FxTwitter 公开推文正文
 *
 * 另一路（fomo 社区 thesis / 持有人）刻意不走这里：v0.5 起 content script 直接读页面
 * 已渲染的 DOM，零网络、不碰任何登录令牌，扩展后台完全不参与。
 *
 * 消息协议：
 *   ← {type:"debot-story",    ca, force?}   → {ok:true, payload:<data.history>}
 *                                           | {ok:false, error, kind:"nostory"|"network"|"mismatch"}
 *   ← {type:"analysis-doc",   ca, force?}   → {ok:true, payload:<分析文档>}
 *                                           | {ok:false, error, kind:"disabled"|"absent"|"network"|"no-permission"}
 *   ← {type:"debot-tweets",   ids[], force?}→ {ok:true, payload:[{id,text,author,url}]}
 */
'use strict';

const API_BASES = ['https://app.debot.ai', 'https://debot.ai'];
const API_PATH = '/api/v1/nitter/story/latest';
const TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 15000;
const SESSION_PREFIX = 'debot-story:';

// 自定义分析源：URL 模板来自设置，{ca} 替换成代币地址。
// 可能指向内网/自建服务，慢了不能拖住 DeBot 段，所以硬超时很短。
const ANALYSIS_TTL_MS = 60 * 1000;
const ANALYSIS_TIMEOUT_MS = 2500;
const ANALYSIS_PREFIX = 'analysis-doc:';

// FxTwitter 公开推文
const TWEET_BASE = 'https://api.fxtwitter.com/i/status/';
const TWEET_TTL_MS = 30 * 60 * 1000;
const TWEET_TIMEOUT_MS = 6000;
const TWEET_PREFIX = 'debot-tweet:';
const TWEET_MAX = 3;

const SETTING_DEFAULTS = {
  analysisTemplate: '',
  detailTemplate: '',
  // 高级·仅自用：允许 http / 内网 / 自建分析源（默认 false = 只收 https 公网地址）。
  // 只影响用户自配的分析源；DeBot / FxTwitter 永远锁死在各自的固定公网 https 端点。
  allowPrivateAnalysisSource: false,
};

let settingsMemo = null;
let settingsPending = null;
let settingsGen = 0;

/**
 * 单飞（single-flight）：同一时刻并发的多条消息共用一次 storage 读取，
 * 免得"读到一半的设置"被不同请求各看到一半。读取期间设置若被改动（generation 变了），
 * 这次结果只返回不落缓存，下一次重新读。
 */
async function getSettings() {
  if (settingsMemo) return settingsMemo;
  if (!settingsPending) {
    const gen = settingsGen;
    settingsPending = (async () => {
      let val;
      try {
        const v = await chrome.storage.sync.get(SETTING_DEFAULTS);
        val = Object.assign({}, SETTING_DEFAULTS, v || {});
      } catch (_) {
        val = Object.assign({}, SETTING_DEFAULTS);
      }
      if (gen === settingsGen) settingsMemo = val;
      return val;
    })();
    settingsPending.catch(() => {}).then(() => { settingsPending = null; });
  }
  return settingsPending;
}

try {
  chrome.storage.onChanged.addListener((_c, area) => {
    // 设置改了立刻失效，下次读新的；在途的那次读取也不许再写缓存
    if (area === 'sync') { settingsMemo = null; settingsGen++; }
  });
} catch (_) { /* 忽略 */ }

const originOf = (url) => {
  try { return new URL(url).origin; } catch (_) { return null; }
};

/**
 * 自定义分析源只允许 https 公网地址。
 *
 * 后台的 fetch 是带着 host 授权发出的，没有页面 CORS 约束。若允许 http 或内网/环回
 * 地址，"在 fomo 上看到某个 CA" 就能被变成一次由扩展代发的内网探测（SSRF），
 * 而且响应还会被渲染进卡片。宁可少一个便利，也不留这个洞。
 */
function isPublicHostname(hostRaw) {
  const host = String(hostRaw || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return false;

  // IPv6 字面量：环回 / 唯一本地 / 链路本地一律挡；其余裸 IPv6 也没有正当理由当分析源
  if (host.indexOf(':') !== -1) return false;

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const p = m.slice(1).map(Number);
    if (p.some((x) => !isFinite(x) || x > 255)) return false;
    if (p[0] === 0 || p[0] === 127 || p[0] === 10) return false;             // 本机 / 私有 A
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;              // 私有 B
    if (p[0] === 192 && p[1] === 168) return false;                          // 私有 C
    if (p[0] === 169 && p[1] === 254) return false;                          // 链路本地
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;             // CGNAT / 组网内网段
    if (p[0] >= 224) return false;                                           // 组播 / 保留
    return true;
  }

  if (host.indexOf('.') === -1) return false; // 裸主机名 = 内网短名
  return true;
}

function isPublicHttpsUrl(url) {
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;
  return isPublicHostname(u.hostname);
}

/** 开关打开时的最低准入：仍必须是 http/https，绝不放行 file:/ftp:/data: 之类。 */
function isHttpLikeUrl(url) {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch (_) { return false; }
}

/** manifest 里静态授权的源；分析源等其余地址必须走 optional_host_permissions 动态授权。 */
const STATIC_ORIGINS = API_BASES.concat(['https://api.fxtwitter.com']);

async function hasPermission(url) {
  const origin = originOf(url);
  if (!origin) return false;
  if (STATIC_ORIGINS.indexOf(origin) !== -1) return true;
  try {
    return await chrome.permissions.contains({ origins: [origin + '/*'] });
  } catch (_) { return false; }
}

/** @type {Map<string, {at:number, res:object}>} */
const memCache = new Map();

const isHex = (s) => typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/.test(s);

/**
 * 0x 地址大小写不敏感；base58 地址大小写敏感。
 * 只要有一边长得像 0x 开头，就必须两边都是合法 40 位十六进制才算相等——
 * 半截 0x 串绝不能掉进 base58 的字面比较分支里蒙混过关。
 */
function sameCa(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const looksHex = /^0x/i.test(a) || /^0x/i.test(b);
  if (looksHex) return isHex(a) && isHex(b) && a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function cacheKey(ca) {
  return isHex(ca) ? ca.toLowerCase() : ca;
}

function fresh(entry, ttl) {
  return entry && typeof entry.at === 'number' && Date.now() - entry.at < ttl;
}

async function readCache(prefix, key, ttl) {
  const k = prefix + key;
  const hit = memCache.get(k);
  if (fresh(hit, ttl)) return hit.res;
  if (hit) memCache.delete(k);
  // service worker 可能已被回收，内存缓存丢失 → 回落到 session 镜像
  try {
    const store = chrome.storage && chrome.storage.session;
    if (!store) return null;
    const got = await store.get(k);
    const entry = got && got[k];
    if (fresh(entry, ttl)) {
      memCache.set(k, entry);
      return entry.res;
    }
    if (entry) await store.remove(k);
  } catch (_) { /* session 存储不可用时静默降级 */ }
  return null;
}

async function writeCache(prefix, key, res) {
  const k = prefix + key;
  const entry = { at: Date.now(), res };
  memCache.set(k, entry);
  try {
    const store = chrome.storage && chrome.storage.session;
    if (store) await store.set({ [k]: entry });
  } catch (_) { /* 忽略 */ }
}

/** 统一的带超时 JSON 取数。返回 {stage, json?, status?}，绝不抛。 */
async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      credentials: 'omit',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { stage: 'http', status: res.status };
    try {
      return { stage: 'json', json: await res.json() };
    } catch (_) {
      return { stage: 'parse' };
    }
  } catch (e) {
    return { stage: (e && e.name === 'AbortError') ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 1) DeBot 叙事
// ---------------------------------------------------------------------------

/** 判断 story 载体是否可用：三种语言至少有一个非空对象。 */
function hasUsableStory(history) {
  if (!history || typeof history !== 'object') return false;
  return ['story', 'story_en', 'story_ja'].some((k) => {
    const s = history[k];
    return s && typeof s === 'object' && Object.keys(s).length > 0;
  });
}

const fetchOnce = (base, ca) =>
  fetchJson(base + API_PATH + '?ca_address=' + encodeURIComponent(ca), TIMEOUT_MS);

async function fetchStory(ca) {
  let firstFailure = '';
  // 主域名的失败原因才有诊断价值：备用域名在多数网络下直接 403，
  // 若用最后一次失败覆盖，用户永远只看到 403，掩盖真正的故障点。
  const note = (msg) => { if (!firstFailure) firstFailure = msg; };

  for (const base of API_BASES) {
    const out = await fetchOnce(base, ca);

    if (out.stage === 'timeout') { note('请求超时（15 秒）'); continue; }
    if (out.stage === 'network') { note('网络请求失败'); continue; }
    if (out.stage === 'http') { note('DeBot 返回 HTTP ' + out.status); continue; }
    if (out.stage === 'parse') { note('响应不是合法 JSON'); continue; }

    const json = out.json;
    if (!json || typeof json !== 'object') { note('响应为空'); continue; }

    const history = json.data && json.data.history;

    if (json.code === 0 && hasUsableStory(history)) {
      if (!sameCa(history.ca_address, ca)) {
        return { ok: false, error: '响应 CA 不一致', kind: 'mismatch' };
      }
      return { ok: true, payload: history };
    }

    // API 明确回答"没有记录"：这是权威答案，不再试备用域名
    if (json.code === -1 || typeof json.error === 'string') {
      return {
        ok: false,
        kind: 'nostory',
        error: (typeof json.error === 'string' && json.error) || '未找到故事记录',
      };
    }

    // 空 {} 或形状不可用 → 落到下一个域名
    note('响应结构不可用');
  }

  return { ok: false, kind: 'network', error: firstFailure || '暂时读不到 DeBot 数据' };
}

async function handleStory(msg) {
  const ca = msg && typeof msg.ca === 'string' ? msg.ca.trim() : '';
  if (!ca) return { ok: false, kind: 'network', error: '缺少合约地址' };

  if (!msg.force) {
    const cached = await readCache(SESSION_PREFIX, cacheKey(ca), TTL_MS);
    if (cached) return cached;
  }

  const res = await fetchStory(ca);
  // 成功与"确认无叙事"都缓存；网络类失败不缓存，留给用户重试
  if (res.ok || res.kind === 'nostory') await writeCache(SESSION_PREFIX, cacheKey(ca), res);
  return res;
}

// ---------------------------------------------------------------------------
// 2) 自定义分析源（用户自配 URL 模板；没配 = 这段不存在）
// ---------------------------------------------------------------------------

/** {ca} 占位替换；0x 地址统一小写（多数静态站按小写文件名存）。 */
function buildAnalysisUrl(template, ca) {
  const t = String(template || '').trim();
  if (!t || t.indexOf('{ca}') === -1) return null;
  const key = isHex(ca) ? ca.toLowerCase() : ca;
  const url = t.split('{ca}').join(encodeURIComponent(key));
  return originOf(url) ? url : null;
}

/** 文档里的 address 必须与查询的 CA 自洽，否则等同"没有档案"——张冠李戴比没有更危险。 */
function analysisMatches(doc, ca) {
  if (!doc || typeof doc !== 'object') return false;
  const addr = doc.address || doc.ca || doc.contract_address;
  return typeof addr === 'string' && sameCa(addr, ca);
}

async function fetchAnalysis(ca) {
  const settings = await getSettings();
  const url = buildAnalysisUrl(settings.analysisTemplate, ca);
  if (!url) return { ok: false, kind: 'disabled', error: '未配置分析源' };

  // 准入校验在授权检查之前：不合格的地址一次网络请求都不许发出去。
  //   默认（开关关）：只收 https 公网地址，挡住 http/内网/环回/CGNAT/链路本地（SSRF 防线）。
  //   开关开（高级·仅自用）：放宽到任意 http/https 地址，交给用户对自己的内网源负责。
  const admitted = settings.allowPrivateAnalysisSource
    ? isHttpLikeUrl(url)
    : isPublicHttpsUrl(url);
  if (!admitted) {
    return { ok: false, kind: 'blocked', error: '分析源地址不合规' };
  }

  if (!(await hasPermission(url))) {
    return { ok: false, kind: 'no-permission', error: '未授权访问分析源，去设置里重新保存' };
  }

  const out = await fetchJson(url, ANALYSIS_TIMEOUT_MS);

  if (out.stage === 'http') {
    if (out.status === 404) return { ok: false, kind: 'absent', error: '分析源里没有这只币' };
    return { ok: false, kind: 'network', error: '分析源返回 HTTP ' + out.status };
  }
  if (out.stage === 'timeout') return { ok: false, kind: 'network', error: '分析源无响应（超时）' };
  if (out.stage === 'network') return { ok: false, kind: 'network', error: '分析源不可达' };
  if (out.stage === 'parse') return { ok: false, kind: 'network', error: '分析源返回的不是合法 JSON' };

  const doc = out.json;
  if (!doc || typeof doc !== 'object') {
    return { ok: false, kind: 'absent', error: '分析源里没有这只币' };
  }
  if (!analysisMatches(doc, ca)) {
    return { ok: false, kind: 'absent', error: '分析源里没有这只币' };
  }
  return { ok: true, payload: doc };
}

async function handleAnalysis(msg) {
  const ca = msg && typeof msg.ca === 'string' ? msg.ca.trim() : '';
  if (!ca) return { ok: false, kind: 'network', error: '缺少合约地址' };

  // 缓存键必须带上模板本身：换了分析源却还吐上一个源的旧档案，比没有缓存危险得多
  const settings = await getSettings();
  const key = cacheKey(ca) + '|' + String(settings.analysisTemplate || '');
  if (!msg.force) {
    const cached = await readCache(ANALYSIS_PREFIX, key, ANALYSIS_TTL_MS);
    if (cached) return cached;
  }
  const res = await fetchAnalysis(ca);
  if (res.ok || res.kind === 'absent') await writeCache(ANALYSIS_PREFIX, key, res);
  return res;
}

// ---------------------------------------------------------------------------
// 3) FxTwitter 来源推文正文
// ---------------------------------------------------------------------------

function normalizeTweet(id, json) {
  const t = json && json.tweet;
  if (!t || typeof t !== 'object') return null;
  const text = typeof t.text === 'string' ? t.text : (typeof t.raw_text === 'string' ? t.raw_text : '');
  if (!text.trim()) return null;
  const a = t.author || {};
  return {
    id,
    text,
    author: (typeof a.screen_name === 'string' && a.screen_name)
      || (typeof a.name === 'string' && a.name) || '',
    authorName: typeof a.name === 'string' ? a.name : '',
    // 不信第三方返回的 url 字段，一律改写成规范形式（同一条推文永远同一个链接）
    url: 'https://x.com/i/status/' + encodeURIComponent(id),
  };
}

async function fetchTweet(id, force) {
  if (!force) {
    const cached = await readCache(TWEET_PREFIX, id, TWEET_TTL_MS);
    if (cached !== null && cached !== undefined) return cached;
  }
  const out = await fetchJson(TWEET_BASE + encodeURIComponent(id), TWEET_TIMEOUT_MS);
  // 单条推文失败（删帖 404、私密、超时）一律静默跳过，缓存 null 免得反复重试
  const tweet = out.stage === 'json' ? normalizeTweet(id, out.json) : null;
  if (out.stage === 'json' || out.stage === 'http') await writeCache(TWEET_PREFIX, id, tweet);
  return tweet;
}

async function handleTweets(msg) {
  const ids = Array.isArray(msg && msg.ids)
    ? msg.ids.filter((x) => typeof x === 'string' && /^[0-9]{5,25}$/.test(x)).slice(0, TWEET_MAX)
    : [];
  if (!ids.length) return { ok: true, payload: [] };
  const settled = await Promise.all(ids.map((id) => fetchTweet(id, !!msg.force).catch(() => null)));
  return { ok: true, payload: settled.filter(Boolean) };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const ROUTES = {
  'debot-story': handleStory,
  'analysis-doc': handleAnalysis,
  'debot-tweets': handleTweets,
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = msg && ROUTES[msg.type];
  if (!fn) return false;
  fn(msg).then(sendResponse).catch(() => {
    sendResponse({ ok: false, kind: 'network', error: '后台处理异常' });
  });
  return true; // 异步响应
});
