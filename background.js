/**
 * Fomo放大镜 — background service worker
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
const TWEET_BASE = 'https://api.fxtwitter.com/i/status/';
const TWEET_TTL_MS = 30 * 60 * 1000;
const TWEET_TIMEOUT_MS = 6000;
const TWEET_PREFIX = 'debot-tweet:';
const TWEET_MAX = 3;

const SETTING_DEFAULTS = {
  // 高级·仅自用：允许 http / 内网 / 自建分析源（默认 false = 只收 https 公网地址）。
  // 只影响用户自配的分析源；DeBot / FxTwitter 永远锁死在各自的固定公网 https 端点。
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
      // 准入校验只作用于初始 URL；跟随跳转会让校验被绕过(含 https→http 降级)，故一律不跟随。
      redirect: 'error',
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
  // 公开版不含自定义分析源：保留路由存根，content.js 即便询问也只会拿到 disabled。
  'analysis-doc': async () => ({ ok: false, kind: 'disabled', error: '公开版不含分析源' }),
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
