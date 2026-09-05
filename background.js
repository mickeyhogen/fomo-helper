/*! Fomo Lens · Fomo放大镜 — © 2026 0xHogen (https://x.com/0xHogen)
 *  Source: https://github.com/mickeyhogen/fomo-helper · MIT License
 *  Derivative builds: keep this notice and the visible "By @0xHogen" attribution. */
/**
 * Fomo放大镜 — background service worker
 *
 * 代发那些没有对 fomo.family 开放 CORS、必须由持 host_permissions 的后台来请求的源：
 *   1. DeBot 公开叙事 API   —— 卡片主体（固定公开端点，无需配置）
 *   2. 自定义分析源         —— 用户自己配的 JSON URL 模板，没配就整段不存在
 *   3. FxTwitter 公开推文正文
 *
 * fomo 社区 thesis / 持有人仍由 fomo content script 直接读已渲染 DOM。v0.9.14 起，
 * xxyy 可请后台临时打开同币 fomo 页并取一份最小快照；后台不读 cookie/localStorage，
 * 不接触登录令牌，专用页取完即关。
 *
 * 消息协议：
 *   ← {type:"debot-story",    ca, force?}   → {ok:true, payload:<data.history>}
 *                                           | {ok:false, error, kind:"nostory"|"network"|"mismatch"}
 *                                           | {ok:false, error, kind:"disabled"|"absent"|"network"|"no-permission"}
 *   ← {type:"debot-tweets",   ids[], force?}→ {ok:true, payload:[{id,text,author,url}]}
 *   ← {type:"xxyy-vue-hit",   x, y}         → {ok:true, payload:{chain,ca,resolved}}
 *   ← {type:"fomo-token-data",ca, chain}     → {ok:true, payload:{holders,thesis,feed,share}}
 *                                           | {ok:false, kind:"auth_required"|"unavailable"}
 */
'use strict';

const API_BASES = ['https://app.debot.ai', 'https://debot.ai'];
const API_PATH = '/api/v1/nitter/story/latest';
const TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 15000;
const FETCH_MAX_BYTES = 2 * 1024 * 1024;   // 任何三方响应超 2MB 一律当坏包
const SESSION_PREFIX = 'debot-story:';

// FxTwitter 公开推文
const TWEET_BASE = 'https://api.fxtwitter.com/i/status/';
const TWEET_TTL_MS = 30 * 60 * 1000;
const TWEET_TIMEOUT_MS = 6000;
const TWEET_PREFIX = 'debot-tweet:';
const TWEET_MAX = 3;

const SETTING_DEFAULTS = {
  // 公开版不含「自定义分析源」：没有设置入口，后台也没有对应请求路径。
};

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
    // K3 审查 F4：上游被劫持回超大响应时别把 service worker 撑爆
    const len = Number(res.headers.get('content-length') || 0);
    if (len > FETCH_MAX_BYTES) return { stage: 'parse' };
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
  // DeBot keys EVM records by lowercase; preserve case-sensitive Solana addresses.
  fetchJson(base + API_PATH + '?ca_address=' + encodeURIComponent(cacheKey(ca)), TIMEOUT_MS);

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
// 4) DexScreener 池子/交易对（v0.8.3）
//    固定公网只读端点，与 DeBot / FxTwitter 同一信任模型：不登录、不带 cookie、
//    不受「高级·仅自用」开关影响。失败静默（头部不出 chips），绝不拖累其它段。
// ---------------------------------------------------------------------------

const PAIRS_BASE = 'https://api.dexscreener.com/latest/dex/tokens/';
const PAIRS_TTL_MS = 10 * 60 * 1000;
const PAIRS_TIMEOUT_MS = 6000;
const PAIRS_PREFIX = 'dex-pairs:';
const PAIRS_MAX = 12;   // 给前端的池子行数上限（前端再按报价资产去重取前几个 chip）

async function handlePairs(msg) {
  const ca = msg && typeof msg.ca === 'string' ? msg.ca.trim() : '';
  const chain = msg && typeof msg.chain === 'string' ? msg.chain.trim().toLowerCase() : '';
  if (!ca) return { ok: false, kind: 'network' };

  const key = cacheKey(ca) + '|' + chain;
  if (!msg.force) {
    const cached = await readCache(PAIRS_PREFIX, key, PAIRS_TTL_MS);
    if (cached) return cached;
  }

  const out = await fetchJson(PAIRS_BASE + encodeURIComponent(cacheKey(ca)), PAIRS_TIMEOUT_MS);
  if (out.stage !== 'json' || !out.json || !Array.isArray(out.json.pairs)) {
    return { ok: false, kind: 'network' };   // 失败不缓存，下次自然重试
  }

  // 只留本链、且我们这只币在场的池子；对手方 = 另一侧的 symbol。
  // 字段裁剪到最小——三方响应绝不整包透传给前端。
  const rows = [];
  let scanned = 0;
  for (const p of out.json.pairs) {
    if (++scanned > 400) break;   // K3 F4：超大 pairs 数组封顶遍历
    if (!p || typeof p !== 'object') continue;
    if (chain && String(p.chainId || '').toLowerCase() !== chain) continue;
    const base = p.baseToken || {};
    const quote = p.quoteToken || {};
    let partner = null;
    if (sameCa(base.address, ca)) partner = quote;
    else if (sameCa(quote.address, ca)) partner = base;
    if (!partner) continue;
    const sym = String(partner.symbol || '').trim();
    if (!sym || sym.length > 12) continue;
    rows.push({
      quote: sym.slice(0, 12),
      dex: String(p.dexId || '').slice(0, 24),
      liqUsd: Number((p.liquidity && p.liquidity.usd) || 0) || 0,
    });
  }
  rows.sort((a, b) => b.liqUsd - a.liqUsd);
  const res = { ok: true, payload: rows.slice(0, PAIRS_MAX) };
  await writeCache(PAIRS_PREFIX, key, res);
  return res;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/**
 * v0.9.6 版本检测：查 GitHub 最新 release，6 小时缓存一次。
 * 只读公开 API、不带任何凭证；这是本扩展第 5 个外部端点，已写进隐私说明。
 */
const RELEASE_URL = 'https://api.github.com/repos/mickeyhogen/fomo-helper/releases/latest';
const VERSION_TTL_MS = 6 * 60 * 60 * 1000;   // 主人定：每 6 小时
const VERSION_CACHE_KEY = 'updateCheckCache';

/**
 * 发布说明 → 一句"这版改了什么"（悬停提示用）。
 * 实测教训：直接取第一行非空文本会拿到 "**Fixes (both reported by real users)**" 这种分节标题，
 * 对用户毫无信息。所以优先取第一条**列表项**（真正的变更条目），没有列表才退回普通正文行。
 */
function releaseGist(body) {
  const text = String(body || '');
  // 这段字要直接进用户看得见的 tooltip，Markdown 记号得清干净：粗体/行内码之外，
  // 还有链接 [文字](url)、删除线 ~~、成对下划线斜体（不碰 snake_case 里的下划线）。
  const strip = (line) => line.replace(/^\s*[-*+]\s+/, '').replace(/^[\s>#]+/, '')
    .replace(/!?\[([^\]]{1,80})\]\([^)]*\)/g, '$1')
    .replace(/~~/g, '')
    .replace(/(^|\s)_([^_\s][^_]{0,60})_(?=[\s.,;:!?)]|$)/g, '$1$2')
    .replace(/\*\*/g, '').replace(/`/g, '').trim();
  const isHeading = (raw) => /^\s*#/.test(raw) || /[:：]\s*$/.test(raw);
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {                       // 第一优先：列表项
    if (!/^\s*[-*+]\s+/.test(raw)) continue;
    const t = strip(raw);
    if (t.length >= 6 && !/^https?:\/\//i.test(t)) return t.slice(0, 110);
  }
  for (const raw of lines) {                       // 退回：非标题正文行
    const t = strip(raw);
    if (!t || t.length < 6 || /^https?:\/\//i.test(t) || isHeading(raw)) continue;
    return t.slice(0, 110);
  }
  return '';
}

async function handleVersion(msg) {
  try {
    if (!msg || !msg.force) {
      const got = await chrome.storage.local.get({ [VERSION_CACHE_KEY]: null });
      const c = got && got[VERSION_CACHE_KEY];
      if (c && typeof c.tag === 'string' && Date.now() - Number(c.at || 0) < VERSION_TTL_MS) {
        return { ok: true, payload: { tag: c.tag, url: c.url || '', link: c.link || c.url || '', gist: c.gist || '', cached: true } };
      }
    }
    const r = await fetchJson(RELEASE_URL, 8000);
    if (r.stage !== 'json' || !r.json) return { ok: false, kind: 'network' };
    const tag = String(r.json.tag_name || '').trim();
    if (!tag) return { ok: false, kind: 'network' };
    const url = String(r.json.html_url || '').trim();
    const body = String(r.json.body || '');
    // 发布说明里贴了推特链接就优先跳那条推（主人引流用）；没贴则回落 GitHub 发布页。
    // 只认 https 的 x.com / twitter.com 状态链接，别的一律不跟。
    // 句柄最长 15 位（X 的硬上限），状态号现役 19 位——收紧到 10~25 位，
    // 别让 /status/12345 这种明显不是推文的短号也被当成落点。
    const tw = body.match(/https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{10,25}(?![0-9])/);
    const link = tw ? tw[0] : url;
    const gist = releaseGist(body);
    const payload = { tag, url, link, gist, cached: false };
    try { await chrome.storage.local.set({ [VERSION_CACHE_KEY]: Object.assign({ at: Date.now() }, payload) }); } catch (_) { /* 忽略 */ }
    return { ok: true, payload };
  } catch (_) {
    return { ok: false, kind: 'network' };
  }
}

// ---------------------------------------------------------------------------
// 5) 地址反解（v0.9.9 自用·xxyy）：xxyy 会把代币 CA 302 成池子地址挂在 URL 上
//    （实测 /sol/<mint> → /sol/<pool>），DeBot/DexScreener 都按代币 CA 取数，
//    所以先拿 DexScreener 的 pairs 端点把池子反解成 baseToken 地址。
//    不是池子（查不到 pair）就当它本来就是 CA 原样返回——fomo 一律走这条捷径。
//    同信任模型：固定公网只读端点，失败静默降级。
// ---------------------------------------------------------------------------

const RESOLVE_BASE = 'https://api.dexscreener.com/latest/dex/pairs/';
const RESOLVE_TTL_MS = 10 * 60 * 1000;
const XXYY_POOL_ID_RE = /^0x[a-fA-F0-9]{64}$/i;
const resolveMem = new Map();   // 'chain|addr' → {at, ca}（service worker 存活期内存缓存）

async function handleResolveToken(msg) {
  const addr = msg && typeof msg.addr === 'string' ? msg.addr.trim() : '';
  const chain = msg && typeof msg.chain === 'string' ? msg.chain.trim().toLowerCase() : '';
  const poolId = XXYY_POOL_ID_RE.test(addr);
  if ((!XXYY_ADDR_RE.test(addr) && !poolId)
      || !['solana', 'bsc', 'ethereum', 'base', 'robinhood', 'monad'].includes(chain)) return { ok: false, kind: 'network' };
  const key = chain + '|' + (isHex(addr) || poolId ? addr.toLowerCase() : addr);
  const hit = resolveMem.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return { ok: true, payload: { ca: hit.ca } };
  let ca = addr;
  let definitive = false;   // 端点真的应答了（有 pair → 反解；没 pair → 本来就是 CA），才配被缓存
  try {
    const r = await fetchJson(RESOLVE_BASE + encodeURIComponent(chain) + '/' + encodeURIComponent(addr), PAIRS_TIMEOUT_MS);
    if (r.stage === 'json' && r.json) {
      const pairs = r.json.pair ? [r.json.pair] : (Array.isArray(r.json.pairs) ? r.json.pairs : []);
      const pair = pairs.find(p => p && p.chainId === chain && typeof p.pairAddress === 'string'
        && (poolId ? XXYY_POOL_ID_RE.test(p.pairAddress) && p.pairAddress.toLowerCase() === addr.toLowerCase()
          : sameCa(p.pairAddress, addr)));
      const base = pair && pair.baseToken && typeof pair.baseToken.address === 'string' ? pair.baseToken.address.trim() : '';
      if (XXYY_ADDR_RE.test(base)) { ca = base; definitive = true; }
      // A 32-byte pool ID cannot fall back to being a token address.
      else if (!poolId && !pairs.length && Object.prototype.hasOwnProperty.call(r.json, 'pairs')
          && (r.json.pairs === null || Array.isArray(r.json.pairs))) definitive = true;
    }
  } catch (_) { /* 网络/解析异常 → 下面按"不缓存"处理 */ }
  // v0.9.11（Kimi 审查 F1）：网络抖动时不能把"没反解成"缓存 10 分钟——否则这个池子在 SW 存活期内
  // 永远显示"未收录"。失败回 ok:false，前台按原地址开卡且不缓存，主人点 ↻ / 刷新就能重试。
  if (!definitive) return { ok: false, kind: 'network' };
  resolveMem.set(key, { at: Date.now(), ca });
  return { ok: true, payload: { ca } };
}

// ---------------------------------------------------------------------------
// 6) xxyy Vue 左栏命中（v0.9.13）
//
// content script 默认跑在 Chrome ISOLATED world，看不到页面主世界的
// #app._vnode。只把“当前坐标命中的行”交给 MAIN world 做一次只读探测，
// 再把 chain/CA/是否已反解这三个经过白名单校验的字段带回来。
// 不常驻注入 page script，不开 window message 通道，页面也拿不到扩展 API。
// ---------------------------------------------------------------------------

/**
 * 这个函数由 chrome.scripting 序列化后在 MAIN world 执行：必须完全自包含。
 * 返回值刻意裁成最小 JSON，不得把 vnode/props 或任何页面对象透传给扩展。
 */
function probeXxyyVueAtPoint(x, y) {
  const ADDR_RE = /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
  const POOL_ID_RE = /^0x[a-fA-F0-9]{64}$/i;
  const USERISH_RE = /user|wallet|profile|owner|creator|follower|account/i;
  const TOKEN_KEY_RE = /^(token(address|ca|mint)?|mint(address)?|ca|contract(address)?|basetoken(address)?)$/i;
  const POOL_KEY_RE = /^(pair(address)?|pool(address)?|amm(address)?)$/i;
  const CHAIN_IDS = { 1: 'ethereum', 56: 'bsc', 8453: 'base', 1399811149: 'solana', 4663: 'robinhood', 143: 'monad' };
  const CHAIN_NAMES = { sol: 'solana', solana: 'solana', bsc: 'bsc', bnb: 'bsc', eth: 'ethereum', ethereum: 'ethereum', base: 'base', robin: 'robinhood', robinhood: 'robinhood', monad: 'monad' };

  const own = (obj, key) => {
    try {
      const d = Object.getOwnPropertyDescriptor(obj, key);
      return d && Object.prototype.hasOwnProperty.call(d, 'value') ? d.value : undefined;
    } catch (_) { return undefined; }
  };

  const itemToHit = (item) => {
    if (!item || typeof item !== 'object') return null;
    let ca = '';
    let pool = '';
    let chain = null;
    let keys;
    try { keys = Object.keys(item).slice(0, 80); } catch (_) { return null; }
    for (const key of keys) {
      const val = own(item, key);
      if (typeof val === 'string' && (ADDR_RE.test(val) || POOL_ID_RE.test(val))) {
        if (!ca && TOKEN_KEY_RE.test(key) && ADDR_RE.test(val)) ca = val;
        else if (!pool && POOL_KEY_RE.test(key) && (ADDR_RE.test(val) || POOL_ID_RE.test(val))) pool = val;
      } else if ((typeof val === 'string' || typeof val === 'number')
          && /^(chain(id|name)?|network(id)?|allowChain|tokenChain)$/i.test(key)) {
        const slug = String(val).toLowerCase();
        chain = CHAIN_NAMES[slug] || CHAIN_IDS[slug] || chain;
      }
    }
    if (ca) return { chain, ca, resolved: true };
    if (pool) return { chain, ca: pool, resolved: false };
    return null;
  };

  const scanProps = (props) => {
    const queue = [[props, 0]];
    let visited = 0;
    while (queue.length && visited++ < 200) {
      const pair = queue.shift();
      const obj = pair[0];
      const depth = pair[1];
      if (!obj || typeof obj !== 'object') continue;
      const hit = itemToHit(obj);
      if (hit) return hit;
      if (depth >= 3) continue;
      let keys;
      try { keys = Object.keys(obj).slice(0, 40); } catch (_) { continue; }
      for (const key of keys) {
        if (USERISH_RE.test(key)) continue;
        const val = own(obj, key);
        if (val && typeof val === 'object' && !Array.isArray(val)) queue.push([val, depth + 1]);
      }
    }
    return null;
  };

  // Monitor rows carry the CA under tokenInfo.address and the chain on the event.
  // Scope generic `address` to this exact token object; never scan wallet/transfer addresses.
  const monitorToHit = (data) => {
    if (!data || typeof data !== 'object') return null;
    const transfer = Number(own(data, 'eventType')) === 1;
    const event = own(data, transfer ? 'transferData' : 'tradeData');
    const token = own(data, 'tokenInfo');
    const ca = own(data, 'tokenAddress') || own(token, 'address');
    const rawChain = own(event, 'chain') || own(data, 'chain');
    const chain = CHAIN_NAMES[String(rawChain).toLowerCase()] || CHAIN_IDS[String(rawChain)];
    if (!chain || typeof ca !== 'string' || !ADDR_RE.test(ca)) return null;
    return { chain, ca, resolved: true };
  };

  /**
   * xxyy 列表页 URL 不带链，实站的 token item 也未必带 chainId。
   * 选中链在更上层 tokens/memeMain 组件的 ctx.chainId，只读精确键名的标量值。
   */
  const chainFromAncestors = (start) => {
    let instance = start;
    for (let up = 0; up < 14 && instance; up++, instance = own(instance, 'parent')) {
      for (const bucketName of ['props', 'ctx', 'setupState', 'data']) {
        const bucket = own(instance, bucketName);
        if (!bucket || typeof bucket !== 'object') continue;
        // A widget can show a different chain from the page's global chain selector.
        for (const key of ['tokenChain', 'allowChain', 'curChain', 'defaultChainId', 'chain', 'chainId', 'chainName', 'network', 'networkId']) {
          let val = own(bucket, key);
          // Vue 的 ctx 对外暴露值是 accessor（实站 chainId 的 descriptor 只有 getter）。
          // 只对上面精确白名单的链键允许读 getter，并且读完立刻收窄到 string/number。
          if (val === undefined) { try { val = bucket[key]; } catch (_) { val = undefined; } }
          // Vue ref 只允许解一层 value，其它对象不下钻。
          if (val && typeof val === 'object') val = own(val, 'value');
          if (typeof val !== 'string' && typeof val !== 'number') continue;
          const slug = String(val).toLowerCase();
          const chain = CHAIN_NAMES[slug] || CHAIN_IDS[slug];
          if (chain) return chain;
        }
      }
    }
    return null;
  };

  let target;
  let row;
  let root;
  try {
    target = document.elementFromPoint(Number(x), Number(y));
    row = target && target.closest
      && (target.closest('.vue-recycle-scroller__item-view')
        || target.closest('.virtual-wrap [role="item"], .monitor-item, .multi-wallet-monitor-item, .row'));
    root = document.querySelector('#app');
  } catch (_) { return null; }
  if (!target || !row || !root || !root.contains(row)) return null;

  const rootVnode = own(root, '_vnode');
  if (!rootVnode) return null;

  // 目标和近邻祖先元素作为候选；找到距光标最近的 vnode 所属组件。
  const candidates = new Map();
  let node = target;
  for (let i = 0; i < 8 && node && node !== document.body; i++, node = node.parentElement) {
    candidates.set(node, i);
  }
  const seen = new Set();
  let best = null;
  let bestDistance = 99;
  let vnodeCount = 0;
  const rowInstances = new Set();
  const walk = (vnode, instance, depth) => {
    if (!vnode || typeof vnode !== 'object' || vnodeCount >= 60000 || depth > 150) return;
    if (seen.has(vnode)) return;
    seen.add(vnode);
    vnodeCount++;
    const el = own(vnode, 'el');
    // VirtualList may retain detached/empty `el` references on a row's hoisted wrappers.
    // Its live leaves still identify the component owning this exact DOM row.
    if (el && instance && rowInstances.size < 40 && row.contains(el)) rowInstances.add(instance);
    if (el && instance && candidates.has(el)) {
      const distance = candidates.get(el);
      if (distance < bestDistance) { bestDistance = distance; best = instance; }
    }
    const component = own(vnode, 'component');
    if (component) {
      walk(own(component, 'subTree'), component, depth + 1);
      return;
    }
    const suspense = own(vnode, 'suspense');
    const ssContent = own(vnode, 'ssContent');
    if (suspense && ssContent) walk(ssContent, instance, depth + 1);
    const children = own(vnode, 'children');
    if (Array.isArray(children)) {
      for (const child of children) {
        if (child && typeof child === 'object') walk(child, instance, depth + 1);
      }
    }
  };
  try { walk(rootVnode, null, 0); } catch (_) { return null; }

  let hit = null;
  let instance = best;
  // Prefer the complete event over child image/wallet tooltip props, which omit its chain.
  for (let up = 0; up < 6 && instance; up++, instance = own(instance, 'parent')) {
    const data = own(own(instance, 'props'), 'monitorData');
    if (data && typeof data === 'object') return monitorToHit(data);
  }
  instance = best;
  for (let up = 0; up < 3 && instance && !hit; up++) {
    try { hit = scanProps(own(instance, 'props')); } catch (_) { hit = null; }
    instance = own(instance, 'parent');
  }
  if (!hit) {
    for (const candidate of rowInstances) {
      const props = own(candidate, 'props');
      const monitor = own(props, 'monitorData');
      if (monitor && typeof monitor === 'object') return monitorToHit(monitor);
      const token = own(props, 'tokenData');
      if (!token || typeof token !== 'object') continue;
      hit = itemToHit(token);
      if (hit) { best = candidate; break; }
    }
  }
  if (!hit || !(ADDR_RE.test(String(hit.ca || '')) || (hit.resolved !== true && POOL_ID_RE.test(String(hit.ca || ''))))) return null;
  if (!hit.chain) hit.chain = chainFromAncestors(best);
  const allowedChains = ['solana', 'bsc', 'ethereum', 'base', 'robinhood', 'monad'];
  const chain = allowedChains.indexOf(String(hit.chain || '').toLowerCase()) !== -1
    ? String(hit.chain).toLowerCase() : null;
  return { chain, ca: String(hit.ca), resolved: hit.resolved === true };
}

const XXYY_ADDR_RE = /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

async function handleXxyyVueHit(msg, sender) {
  let source;
  try { source = new URL(String((sender && sender.url) || '')); } catch (_) { return { ok: false, kind: 'network' }; }
  if (source.protocol !== 'https:' || !['pro.xxyy.io', 'www.xxyy.io'].includes(source.hostname.toLowerCase())) {
    return { ok: false, kind: 'network' };
  }
  if (!sender.tab || !Number.isInteger(sender.tab.id) || Number(sender.frameId || 0) !== 0) {
    return { ok: false, kind: 'network' };
  }
  const x = Number(msg && msg.x);
  const y = Number(msg && msg.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 20000 || y > 20000) {
    return { ok: false, kind: 'network' };
  }
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] },
      world: 'MAIN',
      func: probeXxyyVueAtPoint,
      args: [x, y],
    });
    const hit = out && out[0] && out[0].result;
    if (!hit || !(XXYY_ADDR_RE.test(String(hit.ca || ''))
        || (hit.resolved !== true && XXYY_POOL_ID_RE.test(String(hit.ca || ''))))) return { ok: false, kind: 'network' };
    const allowedChains = ['solana', 'bsc', 'ethereum', 'base', 'robinhood', 'monad'];
    const chain = allowedChains.indexOf(String(hit.chain || '').toLowerCase()) !== -1
      ? String(hit.chain).toLowerCase() : null;
    return { ok: true, payload: { chain, ca: String(hit.ca), resolved: hit.resolved === true } };
  } catch (_) {
    return { ok: false, kind: 'network' };
  }
}

// GMGN React rows are page-world objects, just like the xxyy Vue rows above.
// Run only on demand and return a minimal token identity, never page props.
function probeGmgnReactAtPoint(x, y) {
  if (location.protocol !== 'https:' || location.hostname !== 'gmgn.ai') return null;
  const CHAINS = {sol:'solana',solana:'solana',eth:'ethereum',ethereum:'ethereum',bsc:'bsc',bnb:'bsc',base:'base',tron:'tron',blast:'blast',robinhood:'robinhood',monad:'monad',xlayer:'xlayer'};
  const normalizeChain = v => CHAINS[String(v || '').toLowerCase()] || null;
  const valid = (ca, chain) => typeof ca === 'string' && (chain === 'solana'
    ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)
    : chain === 'tron' ? /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(ca) : /^0x[a-fA-F0-9]{40}$/.test(ca));
  const own = (o,k) => {try {const d=Object.getOwnPropertyDescriptor(o,k);return d&&'value' in d?d.value:undefined;}catch(_){return undefined;}};
  const keys = o => {try{return Object.keys(o).slice(0,60);}catch(_){return [];}};
  const pageChain = normalizeChain(location.pathname.split('/')[1]) || normalizeChain(new URL(location.href).searchParams.get('chain'));
  const readProps = props => {
    const found = new Map();
    const queue = [{o:props,d:0,token:false,chain:null}];
    const seen = new Set();
    for(let n=0;queue.length&&n<120;n++){
      const {o,d,token,chain:inherited}=queue.shift();
      if(!o||typeof o!=='object'||Array.isArray(o)||seen.has(o))continue;
      seen.add(o);
      const chain=normalizeChain(own(o,'chain'))||normalizeChain(own(o,'chainName'))||normalizeChain(own(o,'chain_name'))||inherited;
      for(const k of keys(o)){
        if(/user|wallet|profile|owner|creator|account|pair|pool/i.test(k))continue;
        const v=own(o,k);
        const tokenKey=/^(token_?address|token_?ca|token_?mint|mint_?address|mint|ca|contract_?address)$/i.test(k);
        if(typeof v==='string' && (tokenKey||(token&&/^(address|ca|mint)$/i.test(k)))){
          const c=chain||pageChain;
          if(c&&valid(v,c))found.set(c+'|'+(v.startsWith('0x')?v.toLowerCase():v),{chain:c,ca:v,resolved:true});
        }
        if(d<3&&v&&typeof v==='object'&&!Array.isArray(v)&&/^(item|row|data|info|token|tokenInfo|token_info|baseToken|base_token|coin)$/i.test(k)){
          queue.push({o:v,d:d+1,token:/token|coin/i.test(k),chain});
        }
      }
    }
    return found.size===1?Array.from(found.values())[0]:null;
  };
  // React keeps two fiber trees. The DOM expando may still reference the
  // previous tree after a commit; resolve the committed branch before reading.
  const committedFiber = fiber => {
    if (!fiber) return null;
    let root = fiber;
    for (let up = 0; own(root,'return') && up < 80; up++) root = own(root,'return');
    const holder = own(root,'stateNode');
    const current = holder && own(holder,'current');
    if (current === root) return fiber;
    if (current && current === own(root,'alternate')) return own(fiber,'alternate') || null;
    return own(fiber,'alternate') ? null : fiber;
  };
  let target;
  try {target=document.elementFromPoint(x,y);}catch(_){return null;}
  if(!target||target.closest('nav,footer,[role="navigation"],[data-fomo-debot]'))return null;
  for(let el=target,up=0;el&&el!==document.body&&up<8;el=el.parentElement,up++){
    const rect=el.getBoundingClientRect();
    if(rect.height>180||rect.width>innerWidth*0.6)break;
    const propsKey=keys(el).find(k=>k.startsWith('__reactProps'));
    if(propsKey){const hit=readProps(own(el,propsKey));if(hit)return hit;}
    const fiberKey=keys(el).find(k=>k.startsWith('__reactFiber'));
    let fiber=committedFiber(fiberKey&&own(el,fiberKey));
    for(let hop=0;fiber&&hop<6;hop++,fiber=own(fiber,'return')){
      const dom=own(fiber,'stateNode');
      if(dom&&dom.nodeType===1){const r=dom.getBoundingClientRect();if(r.height>180||r.width>innerWidth*0.6)break;}
      const hit=readProps(own(fiber,'memoizedProps'));if(hit)return hit;
    }
  }
  return null;
}

async function handleGmgnReactHit(msg, sender) {
  let source;
  try{source=new URL(String(sender&&sender.url||''));}catch(_){return {ok:false,kind:'network'};}
  if(source.protocol!=='https:'||source.hostname!=='gmgn.ai'||!sender.tab||!Number.isInteger(sender.tab.id)||sender.frameId!==0)return {ok:false,kind:'network'};
  const x=Number(msg&&msg.x),y=Number(msg&&msg.y);
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>20000||y>20000)return {ok:false,kind:'network'};
  try{
    const out=await chrome.scripting.executeScript({target:{tabId:sender.tab.id,frameIds:[0]},world:'MAIN',func:probeGmgnReactAtPoint,args:[x,y]});
    const hit=out&&out[0]&&out[0].result;
    const chains=['solana','ethereum','bsc','base','tron','blast','robinhood','monad','xlayer'];
    if(!hit||!chains.includes(hit.chain)||!XXYY_ADDR_RE.test(String(hit.ca||'')))return {ok:false,kind:'network'};
    return {ok:true,payload:{chain:hit.chain,ca:String(hit.ca),resolved:true}};
  }catch(_){return {ok:false,kind:'network'};}
}

// ---------------------------------------------------------------------------
// 7) GMGN / xxyy → Fomo 登录态读取
//
// fomo 的 Holders/Thesis 数据只稳定存在于登录后渲染的页面 DOM。这里不复制登录态、
// 不读任何浏览器存储：先只读已打开的同币页，不足时开一个 inactive token tab，
// 向匹配的 content script 请求最小字段快照。只关闭自己创建的临时页；跨币取消旧任务。
// ---------------------------------------------------------------------------

const FOMO_MIRROR_WAIT_MS = 15000;
const FOMO_MIRROR_POLL_MS = 350;
const FOMO_MIRROR_MESSAGE_TIMEOUT_MS = 2500;
const FOMO_MIRROR_AUTH_GRACE_MS = 1800;  // Exact auth_required must persist this long; page loading cannot consume the grace.
const FOMO_MIRROR_TTL_MS = 60 * 1000;
const FOMO_MIRROR_AUTH_TTL_MS = 5 * 1000;
const FOMO_ROUTE_CHAIN = {
  solana: 'solana', bsc: 'bnb', ethereum: 'ethereum', base: 'base', robinhood: 'robinhood',
};
const fomoMirrorCache = new Map();
const fomoMirrorActive = new Map(); // One cancellable reader per requesting tab across both sites.

const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createInactiveTab(url) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.create({ url, active: false }, (tab) => {
        const err = chrome.runtime.lastError;
        if (err || !tab || !Number.isInteger(tab.id)) reject(new Error('tab_create_failed'));
        else resolve(tab);
      });
    } catch (_) { reject(new Error('tab_create_failed')); }
  });
}

function sendToTab(tabId, msg, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(null), Math.max(1, Number(timeoutMs) || FOMO_MIRROR_MESSAGE_TIMEOUT_MS));
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        const err = chrome.runtime.lastError;
        finish(err ? null : (resp || null));
      });
    } catch (_) { finish(null); }
  });
}

function closeMirrorTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  try { chrome.tabs.remove(tabId, () => { void chrome.runtime.lastError; }); } catch (_) { /* 已关闭 */ }
}

function validFomoMirrorSender(sender) {
  let source;
  try { source = new URL(String((sender && sender.url) || '')); } catch (_) { return false; }
  return source.protocol === 'https:' && ['gmgn.ai', 'pro.xxyy.io', 'www.xxyy.io'].includes(source.hostname.toLowerCase())
    && !!sender.tab && Number.isInteger(sender.tab.id) && Number(sender.frameId || 0) === 0;
}

function findExistingFomoTab(fomoUrl) {
  const target = new URL(fomoUrl);
  const canonical = (p) => {
    const parts = p.replace(/\/$/, '').split('/');
    if (/^0x/i.test(parts.at(-1) || '')) parts[parts.length - 1] = parts.at(-1).toLowerCase();
    return parts.join('/');
  };
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ url: 'https://fomo.family/tokens/*' }, (tabs) => {
        if (chrome.runtime.lastError) return resolve([]);
        const matching = (tabs || []).filter((t) => {
          try { return Number.isInteger(t.id) && canonical(new URL(t.url).pathname) === canonical(target.pathname); }
          catch (_) { return false; }
        });
        resolve(matching.sort((a, b) => Number(b.active) - Number(a.active)).slice(0, 4));
      });
    } catch (_) { resolve([]); }
  });
}

function readyFomoResult(job, snap, fomoUrl) {
  const result = {
    ok: true, fomoUrl,
    payload: {
      holders: Array.isArray(snap.holders) ? snap.holders : [],
      thesis: Array.isArray(snap.thesis) ? snap.thesis : [],
      thesisTotal: Number.isSafeInteger(snap.thesisTotal) && snap.thesisTotal >= 0
        && snap.thesisTotal <= 1000000 ? snap.thesisTotal : (Array.isArray(snap.thesis) ? snap.thesis.length : 0),
      feed: Array.isArray(snap.feed) ? snap.feed : [],
      share: snap.share && typeof snap.share === 'object' ? snap.share : null,
      fomoUrl,
    },
  };
  if (!job.cancelled) {
    fomoMirrorCache.set(job.key, { at: Date.now(), ttl: FOMO_MIRROR_TTL_MS, result });
    if (fomoMirrorCache.size > 100) fomoMirrorCache.clear();
  }
  return job.cancelled ? { ok: false, kind: 'superseded', fomoUrl } : result;
}

async function readFomoMirror(job, ca, chain, fomoUrl) {
  const started = Date.now();
  try {
    // Preserve the existing page's loaded holder coverage and filters. This path never
    // scrolls, clicks, navigates or closes an owner tab; only the fallback tab is owned.
    const existing = await findExistingFomoTab(fomoUrl);
    let pending = existing;
    for (let round = 0; pending.length && round < 4 && !job.cancelled; round++) {
      const next = [];
      for (const ownerTab of pending) {
        if (job.cancelled || Date.now() - started >= 4000) break;
        const resp = await sendToTab(ownerTab.id, { type: 'fomo-mirror-snapshot', ca, chain, readOnly: true }, 800);
        const snap = resp && resp.ok && resp.payload;
        if (snap && snap.status === 'ready') return readyFomoResult(job, snap, fomoUrl);
        if (snap && snap.status === 'pending') next.push(ownerTab);
      }
      pending = next;
      await waitMs(FOMO_MIRROR_POLL_MS);
    }
    if (job.cancelled) return { ok: false, kind: 'superseded', fomoUrl };
    const tab = await createInactiveTab(fomoUrl);
    job.tabId = tab.id;
    let authObservedSince = null;
    let readyObservedSince = null;
    let latestReady = null;
    if (job.cancelled) return { ok: false, kind: 'superseded', fomoUrl };

    while (!job.cancelled && Date.now() - started < FOMO_MIRROR_WAIT_MS) {
      const remaining = FOMO_MIRROR_WAIT_MS - (Date.now() - started);
      const resp = await sendToTab(tab.id, { type: 'fomo-mirror-snapshot', ca, chain },
        Math.min(FOMO_MIRROR_MESSAGE_TIMEOUT_MS, Math.max(1, remaining)));
      if (job.cancelled) return { ok: false, kind: 'superseded', fomoUrl };
      const snap = resp && resp.ok && resp.payload;
      if (snap && snap.status === 'ready') {
        // Holders can render before the market-cap strip and Thesis cells.
        // Give those fields a short bounded grace instead of caching the first partial frame.
        if (readyObservedSince === null) readyObservedSince = Date.now();
        latestReady = snap;
        if ((snap.share && Array.isArray(snap.thesis) && snap.thesis.length)
            || Date.now() - readyObservedSince >= 1800) return readyFomoResult(job, snap, fomoUrl);
      } else { latestReady = null; readyObservedSince = null; }
      if (snap && snap.status === 'auth_required') {
        if (authObservedSince === null) authObservedSince = Date.now();
        if (Date.now() - authObservedSince >= FOMO_MIRROR_AUTH_GRACE_MS) {
          const result = { ok: false, kind: 'auth_required', fomoUrl };
          fomoMirrorCache.set(job.key, { at: Date.now(), ttl: FOMO_MIRROR_AUTH_TTL_MS, result });
          return result;
        }
      } else authObservedSince = null;
      await waitMs(FOMO_MIRROR_POLL_MS);
    }
    if (!job.cancelled && latestReady) return readyFomoResult(job, latestReady, fomoUrl);
    return { ok: false, kind: job.cancelled ? 'superseded' : 'unavailable', fomoUrl };
  } catch (_) {
    return { ok: false, kind: job.cancelled ? 'superseded' : 'unavailable', fomoUrl };
  } finally {
    closeMirrorTab(job.tabId);
  }
}

async function handleFomoTokenData(msg, sender) {
  if (!validFomoMirrorSender(sender)) return { ok: false, kind: 'unavailable' };
  const ca = msg && typeof msg.ca === 'string' ? msg.ca.trim() : '';
  const chain = msg && typeof msg.chain === 'string' ? msg.chain.trim().toLowerCase() : '';
  const routeChain = FOMO_ROUTE_CHAIN[chain];
  if (!XXYY_ADDR_RE.test(ca) || !routeChain) return { ok: false, kind: 'unavailable' };
  const key = chain + '|' + cacheKey(ca);  // base58 大小写敏感；只有 0x 地址可归一小写
  const fomoUrl = 'https://fomo.family/tokens/' + routeChain + '/' + ca;

  if (!msg.force) {
    const hit = fomoMirrorCache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.result;
    if (hit) fomoMirrorCache.delete(key);
  }
  const ownerTabId = sender.tab.id;
  const active = fomoMirrorActive.get(ownerTabId);
  if (active && active.key === key && !active.cancelled) {
    return active.promise;
  }
  if (active) {
    active.cancelled = true;
    closeMirrorTab(active.tabId);
  }

  const job = { key, tabId: null, cancelled: false, promise: null };
  job.promise = readFomoMirror(job, ca, chain, fomoUrl).finally(() => {
    if (fomoMirrorActive.get(ownerTabId) === job) fomoMirrorActive.delete(ownerTabId);
  });
  fomoMirrorActive.set(ownerTabId, job);
  return job.promise;
}

const ROUTES = {
  'version-check': handleVersion,
  'debot-story': handleStory,
  // 公开版不含分析源：保留路由名只为让前端那一段安静地降级，绝不发任何请求。
  'analysis-doc': async () => ({ ok: false, kind: 'disabled' }),
  'debot-tweets': handleTweets,
  'dex-pairs': handlePairs,
  'resolve-token': handleResolveToken,
  'xxyy-vue-hit': handleXxyyVueHit,
  'gmgn-react-hit': handleGmgnReactHit,
  'fomo-token-data': handleFomoTokenData,
};

const CA_SHAPE_RE = /^[A-Za-z0-9]{1,64}$/;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // K3 审查 F1：只受理本扩展自己的 content script；其它扩展知道固定 ID 也借不到这几条代发通道
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (msg && 'ca' in msg && !CA_SHAPE_RE.test(String(msg.ca || ''))) {
    sendResponse({ ok: false, kind: 'network' });
    return false;
  }
  const fn = msg && ROUTES[msg.type];
  if (!fn) return false;
  fn(msg, sender).then(sendResponse).catch(() => {
    sendResponse({ ok: false, kind: 'network', error: '后台处理异常' });
  });
  return true; // 异步响应
});

// Chrome invalidates old content-script connections when an extension is reloaded.
// Reinstall only our isolated UI in supported top frames; preserve the page and login.
async function reconnectOpenTabs() {
  const matches = ['https://fomo.family/*', 'https://gmgn.ai/*', 'https://pro.xxyy.io/*', 'https://www.xxyy.io/*'];
  let tabs;
  try { tabs = await chrome.tabs.query({ url: matches, discarded: false }); }
  catch (_) { return; }
  await Promise.allSettled(tabs.map(async tab => {
    if (!Number.isInteger(tab.id)) return;
    const health = await sendToTab(tab.id, { type: 'lens-health' }, 800);
    if (health && health.ok) return;
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['content.js'], world: 'ISOLATED' });
  }));
}
if (chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(() => { reconnectOpenTabs().catch(() => {}); });
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => { reconnectOpenTabs().catch(() => {}); });
