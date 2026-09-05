/*! Fomo Lens · Fomo放大镜 — © 2026 0xHogen (https://x.com/0xHogen)
 *  Source: https://github.com/mickeyhogen/fomo-helper · MIT License
 *  Derivative builds: keep this notice and the visible "By @0xHogen" attribution. */
/**
 * Fomo放大镜 — content script
 *
 * 在 fomo.family 上监听"当前聚焦的代币"（URL 变化 / 左栏悬停），
 * 通过 background 拉 DeBot 叙事，渲染到一个 closed ShadowRoot 卡片里。
 *
 * 安全约定：所有来自 API 的文本一律 textContent 落地，绝不 innerHTML。
 */
'use strict';

(() => {
  // 测试钩子：只有测试夹具能在注入前置位这个标志。
  // 线上 content script 跑在 isolated world，页面 JS 够不到这个全局，无法伪造。
  const TEST = globalThis.__FOMO_DEBOT_TEST__ === true;

  // Reconnecting an updated extension replaces only its UI, never the page.
  if (!TEST && !['fomo.family', 'gmgn.ai', 'pro.xxyy.io', 'www.xxyy.io'].includes(location.hostname)) return;
  const extensionId = TEST ? 'test' : chrome.runtime.id;
  const INSTANCE_KEY = '__fomoLensInstance';
  const previous = globalThis[INSTANCE_KEY];
  if (previous) {
    let alive = false;
    try { alive = previous.alive(); } catch (_) { /* Old extension context may be invalid. */ }
    if (alive) return;
    try { previous.dispose(); } catch (_) { /* Reconnection must survive legacy cleanup failures. */ }
  }
  const DISPOSE_EVENT = 'fomo-lens-dispose-' + extensionId;
  document.dispatchEvent(new Event(DISPOSE_EVENT));
  let disposed = false;
  const lifecycle = new AbortController();
  const timeouts = new Set(), intervals = new Set(), chromeListeners = [];
  const setTimeout = (fn, ms, ...args) => {
    const id = globalThis.setTimeout(() => { timeouts.delete(id); if (!disposed) fn(...args); }, ms);
    timeouts.add(id);
    return id;
  };
  const clearTimeout = id => { timeouts.delete(id); globalThis.clearTimeout(id); };
  const setInterval = (fn, ms) => {
    const id = globalThis.setInterval(() => { if (!disposed) fn(); }, ms);
    intervals.add(id);
    return id;
  };
  function listen(target, type, fn, options) {
    const opts = typeof options === 'boolean' ? { capture: options } : (options || {});
    target.addEventListener(type, fn, { ...opts, signal: lifecycle.signal });
  }
  function listenChrome(event, fn) { event.addListener(fn); chromeListeners.push([event, fn]); }
  function dispose() {
    if (disposed) return;
    disposed = true;
    state.seq++;
    stopScrapers();
    lifecycle.abort();
    for (const id of timeouts) globalThis.clearTimeout(id);
    for (const id of intervals) globalThis.clearInterval(id);
    timeouts.clear(); intervals.clear();
    for (const [event, fn] of chromeListeners) { try { event.removeListener(fn); } catch (_) {} }
    if (host) host.remove();
  }

  // ---------- 站点适配器（v0.9.9 自用：主人常驻 xxyy）----------
  // 叙事/Meta 页签按 CA 取数，本就站点无关；站点差异收敛在这张表里：
  //   tokenPathRe  — 代币页路径 → {chain, ca}（捕获组 1=链 2=CA）
  //   chainMap     — 路径链 slug → DexScreener chainId（fomo 的 robinhood 两边同名，不用映射）
  //   tokenLinkSel — 点击换币快路径认的链接形状（anchorToken 仍会用 tokenPathRe 严格复验）
  //   scrape       — 当前页直接读取 fomo DOM
  //   fomoMirror   — 当前页没有持仓表时，通过后台临时 fomo 页复用登录态读取同一份数据
  //   hover        — 左栏悬停预览（LEFT_ZONE_RATIO/fiber 探针都按 fomo 版式调的，别的站先关）
  // ⚠️ 公开版阉割线：非 fomo 站点靠 manifest matches 卡住（公开 manifest 只有 fomo.family，
  // SYNC 脚本自检把关），这张表进公开版也只是死代码。
  const SITES = {
    'fomo.family': {
      id: 'fomo',
      tokenPathRe: /^\/tokens\/([^/]+)\/([A-Za-z0-9]{20,64})\/?$/,
      tokenLinkSel: 'a[href*="/tokens/"]',
      chainMap: null,
      scrape: true,
      hover: true,
    },
    'pro.xxyy.io': {
      id: 'xxyy',
      // 链 slug 白名单 = 2026-09-04 宿主 Chrome 实测：sol/bsc/eth/base 是真代币页，
      // tron/blast 会被站方 302 回 /meme（不支持）。xxyy 加新链 → 这里加一个 slug 即可。
      // v0.9.12：+robin（xxyy 的 Robinhood 链 slug，观测台 XXYY 短链 pro.xxyy.io/robin/<CA> 同源；主人截图里选的就是这条链）
      tokenPathRe: /^\/(sol|bsc|eth|base|robin)\/(0x[a-fA-F0-9]{64}|[A-Za-z0-9]{20,64})\/?$/i,
      tokenLinkSel: 'a[href*="/sol/"], a[href*="/bsc/"], a[href*="/eth/"], a[href*="/base/"], a[href*="/robin/"]',
      chainMap: { sol: 'solana', eth: 'ethereum', robin: 'robinhood' },
      scrape: false,
      fomoMirror: true,
      // v0.9.12（主人：「我需要的也是左边悬停然后就弹框」）：左栏 收藏/趋势/新币 的行**不是链接**、站是 Vue 3
      // 生产版（元素上不挂组件实例），所以走第三套解析——从 #app._vnode 走 vnode 树找到行所属组件，
      // 读 props.item.tokenAddress（实测字段名）。左栏比 fomo 宽（1512 宽窗口 ≈530px），悬停区放宽。
      hover: 'vue',
      hoverZone: 0.65,
      vueRoot: '#app',
      rowSel: '.vue-recycle-scroller__item-view, .row',   // 虚拟列表外壳优先；内层 .row 会随复用重建
      // 实测（PEPE/CATE/BRETT 三链核验）：xxyy 把代币 CA 302 成池子地址挂在 URL 上，
      // 所以取数前必须过一道 DexScreener pairs 反解（background 'resolve-token'）——悬停预览同样过这道。
      resolveAddr: true,
    },
    // v0.9.11（自用·独立分支）：gmgn。2026-09-05 台湾出口 headless 实测代币页
    // /sol/token/<CA>?activityTag=kol —— URL 直接挂代币 CA（不像 xxyy 是池子），?tab=dev_token 之类
    // 只是页签参数，parsePath 会剥掉 query。主人常驻的是左栏「Wallet Tracker → 追踪/Track」列表：
    // 行若是 <a href="/sol/token/…"> 就能悬停预览 + 点击秒切；行不是链接也没关系——它自己会
    // pushState 换 URL，250ms 轮询照样跟上。界面中英文都不影响：整条链路只认 URL 和链接 href。
    'gmgn.ai': {
      id: 'gmgn',
      fomoMirror: true,
      // 链 slug = gmgn 公开路由（sol/bsc/eth/base/tron/blast）+ 观测台在用的 robinhood；多列无害，只用来认代币页
      tokenPathRe: /^\/(sol|bsc|eth|base|tron|blast|robinhood|monad|xlayer)\/token\/([A-Za-z0-9]{20,64})\/?$/i,
      tokenLinkSel: 'a[href*="/token/"]',
      chainMap: { sol: 'solana', eth: 'ethereum' },
      scrape: false,
      hover: 'gmgn-react', // DOM links first; non-link React rows use a bounded MAIN-world probe.
      hoverZone: 0.5,    // 左栏 Wallet Tracker ≈ 460px，悬停区放宽到半屏
      resolveAddr: false,
    },
  };
  // Both official hosts offer the old and new layouts; the account tier selects the host.
  SITES['www.xxyy.io'] = SITES['pro.xxyy.io'];
  const SITE = SITES[String(location.hostname || '').toLowerCase()] || SITES['fomo.family'];
  const HAS_FOMO_DATA = SITE.scrape || SITE.fomoMirror;
  // v0.9.11：卡片位置 / 尺寸 / 圆钮位置按站点分开记——三个站版式完全不同，在 gmgn 拖到合适的位置
  // 不该把 fomo 的也带跑。fomo 沿用老键名（老用户的记忆不丢），别的站加 @站点 后缀。
  const SK = SITE.id === 'fomo'
    ? { pos: 'cardPos', size: 'cardSize', launcher: 'launcherPos' }
    : { pos: 'cardPos@' + SITE.id, size: 'cardSize@' + SITE.id, launcher: 'launcherPos@' + SITE.id };
  const TOKEN_PATH_RE = SITE.tokenPathRe;
  const ADDR_RE = /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
  const XXYY_POOL_ID_RE = /^0x[a-fA-F0-9]{64}$/i;
  const isXxyyPoolRef = (ref) => SITE.id === 'xxyy' && typeof ref === 'string' && XXYY_POOL_ID_RE.test(ref);
  // fiber 探针：这些键名下面挂的地址是"人"，不是币 —— 整棵子树跳过
  const USERISH_RE = /user|wallet|profile|owner|creator|follower|account/i;
  // 只有自己或直接父键像"币"，才认这个地址
  const TOKENISH_RE = /token|ca|contract|pair|coin|mint|address/i;

  // 悬停停留门槛（v0.7 主人反馈：350ms 太灵敏，鼠标横穿列表就乱弹）。
  // 语义 = 指针必须"停在同一行"这么久才加载预览；中途移到别的行会重新计时，
  // 所以快速划过一串行不会触发任何一次加载。只管左栏悬停预览，
  // URL/点击进代币页的自动展示与此无关。调这一个数就能改灵敏度。
  const HOVER_DEBOUNCE_MS = 600;
  const HOVER_HIDE_MS = 400;
  const XXYY_PROBE_RETRY_MS = 90;
  const XXYY_PROBE_MAX_ATTEMPTS = 3;
  const LEFT_ZONE_RATIO = 0.38;
  // v0.7：800ms 轮询会让主人在新币页上先看到上一只币的卡片近 1 秒。
  // 提到 250ms，并配合"发现换币立刻清场"（见 onUrlMaybeChanged / onDocClick）。
  const URL_POLL_MS = 250;
  const LOC_EVENT = 'fomo-debot-locationchange';

  // v0.7.2：autoOpen 布尔升级成 openMode 三档。
  //   'compact' = 自动弹出但精简（只展开 起源+评级理由，其余全部收起，卡片短）
  //   'full'    = 自动弹出且全部展开（v0.7.1 的老行为）
  //   'off'     = 不自动弹出，只有点右下角"叙"钮 / 悬停预览才现身
  const OPEN_MODES = ['compact', 'full', 'off'];
  const DEFAULTS = {
    openMode: 'compact',
    hoverPreview: true,
    lang: 'zh',
    updateCheck: true,      // v0.9.6：每 6 小时查一次 GitHub 最新版（可关）
    // 公开版：不含自定义分析源，相关设置键一概不读（K3 审查 F5）
  };

  /**
   * openMode 归一 + 迁移：显式存了合法 openMode 就用它；否则回落到老的 autoOpen 布尔
   * （true→'compact'，false→'off'）；都没有 → 默认 'compact'。
   * 读取时解析即迁移，不必强制回写 storage。
   */
  function resolveOpenMode(v) {
    const m = v && v.openMode;
    if (OPEN_MODES.indexOf(m) !== -1) return m;
    if (v && v.autoOpen === false) return 'off';
    if (v && v.autoOpen === true) return 'compact';
    return 'compact';
  }
  const autoOpenEnabled = () => settings.openMode !== 'off';

  let settings = Object.assign({}, DEFAULTS);

  // ---------- v0.9 UI 本地化 ----------
  // 卡片壳（标题/按钮/灰字/提示）随「中/EN」一起切；DeBot 正文另有 story/story_en 双语。
  const I18N = {
    zh: {
      copyCa: '复制合约地址', pin: '固定卡片', langBtn: '切换译文语言', refresh: '重新抓取', close: '关闭',
      dragHint: '拖动移动卡片；双击回到默认大小和位置', docked: '已回到默认大小和位置',
      displayBtn: '调节亮度和透明度', brightness: '亮度', opacity: '透明度',
      updateReady: '有新版', updateHint: '点开 GitHub 发布页下载新版；解压覆盖同一文件夹后回扩展页点 ↻',
      resizeHint: '拖动调整卡片大小（会记住）',
      preview: '预览', launcher: '重新打开 Fomo Lens', launcherHint: '点击恢复当前代币 · 拖动移位', copied: '已复制',
      notToken: '当前页面不是代币页', loadingName: '载入中…', nostoryName: '未收录代币', errorName: '读取失败',
      source: '↗ 来源', resolvingToken: '正在识别当前代币…', resolveTokenFailed: '暂时无法识别这个池子的代币，点击 ↻ 重试', loadingStory: '正在读取 DeBot 叙事…', emptyStory: '这条叙事记录里没有可展示的内容',
      nostory: 'DeBot 还没有这只币的叙事记录', openDebot: '在 DeBot 打开 ↗', retry: '重试',
      secOrigin: '起源', secRating: '评级理由', secSpread: '传播', secDev: '开发者',
      fCeleb: '名人背书', fViews: '最高浏览', fLikes: '最高点赞', fComments: '最高评论', fCommunity: '社区参与', fNegative: '负面事件',
      fIdentity: '身份', fAddress: '地址分析',
      tabMeta: 'Meta', tabThesis: 'Thesis', tabHolders: 'Holders',
      sortLikes: '按赞', sortTime: '最新 ≥2赞',
      readingHolders: '读取页面持仓表…', readingTable: '读取持仓表…',
      scrollHolders: '把页面的 Holders 表滚动到可见即可显示持仓', scrollTable: '把页面的 Holders 表滚动到可见即可显示',
      noThesis: '持有人里暂时没有写 thesis 的',
      friendsOn: '页面开着 Friends only 筛选——关闭它才能显示全部数据', friendsMaybe: '（若开着 Friends only 筛选，需关闭才有全量数据）',
      bottomTab: '把 fomo 下方面板切到「Holders」标签才有数据（现在停在别的标签）',
      translated: '页面被浏览器翻译了（Chrome 网页翻译会改掉表格文字）——点地址栏翻译图标选「显示原文」，再刷新', diag: '诊断', diagTitle: '生成一段排查信息并复制，发给作者即可', diagCopied: '诊断信息已复制', diagShown: '诊断信息见下方',
      feedNoLikes: '评论流里暂时没有 ≥2 赞的发言', feedMissing: '最新档读的是 fomo 自家的 Thesis 评论流——把它打开一次让它渲染出来，再回来看',
      capNewest: '只显示最新的前 ', capLikes: '只显示点赞最高的前 ', capTail: ' 条（共 ', capEnd: ' 条）',
      cost: '成本 ', held: '持有 ', more: ' 展开', less: ' 收起',
      tweets: '叙事来源推文', tweetsN: '（', tweetsNEnd: ' 条）', loading: '读取中…', openTweet: '打开推文 ↗', moreTweets: '更多来源推文（',
      pairsTitle: '流动性池报价资产（按流动性排序）',
      // v0.9.10：Fomo 持仓占比（口径同「风向」：fomo 用户合计持仓 ÷ 市值）
      shareLabel: 'Fomo 持仓', shareTotal: '合计 ', shareMc: ' / 市值 ', shareCover: '榜内 ',
      shareTip: 'fomo 用户合计持仓 ÷ 市值（口径同「风向」）。页面的 Holders 表只渲染前 N 行，所以这是下界（≥），真实值只会更高。经验阈值：★ ≥15% · ★★ ≥20%。市值取不到或对不上时整行不显示。',
      fomoReading: '正在从 fomo 读取 Thesis / Holders / 持仓…',
      fomoLogin: '需要先登录 fomo，才能读取 Thesis、Holders 和 Fomo 持仓。',
      fomoLoginAction: '去登录 fomo ↗',
      fomoUnavailable: '暂时没从 fomo 读到这只币的数据；请先打开 fomo 确认已登录，再回来点 ↻ 重试。',
      fomoOpenAction: '在 fomo 打开 ↗',
      fomoNoHolders: 'fomo 暂时没有显示这只币的持有人数据',
      trPreparing: '正在准备本地翻译（首次需下载语言包）…', trDownloading: '正在下载语言包 ', trAbsent: '此浏览器无内置翻译，只能切中/英原文',
      trHint: '中=译成中文 · EN=显示原文（Chrome 本地翻译，数据不出浏览器）', trBusy: '翻译中…',
      errDebot: '这段暂时读不到', errTweets: '来源推文暂时读不到',
      reconnecting: '连接中断，正在重试…', contextLost: '扩展连接已失效，请刷新本页重新连接。', reloadPage: '刷新页面',
      aiLoading: 'AI 判断读取中…', ai: 'AI 判断', memeHook: 'meme点', techFlags: '技术 / 红旗', updatedAt: '更新于 ', fullReport: '查看完整分析 ↗',
      stale: '（分析时点快照，市值类数字以当时为准）', tier: ' 档',
      justNow: '刚刚', minAgo: ' 分钟前', hourAgo: ' 小时前', dayAgo: ' 天前', monthAgo: ' 个月前',
    },
    en: {
      copyCa: 'Copy contract address', pin: 'Pin card', langBtn: 'Switch language', refresh: 'Refresh', close: 'Close',
      dragHint: 'Drag to move; double-click to reset size and position', docked: 'Back to default size and position',
      displayBtn: 'Brightness & opacity', brightness: 'Brightness', opacity: 'Opacity',
      updateReady: 'Update', updateHint: 'Open the GitHub releases page; unzip over the same folder, then hit ↻ on the extensions page',
      resizeHint: 'Drag to resize (remembered)',
      preview: 'preview', launcher: 'Reopen Fomo Lens', launcherHint: 'Open current token · Drag to move', copied: 'Copied',
      notToken: 'Not a token page', loadingName: 'Loading…', nostoryName: 'Not covered', errorName: 'Failed to load',
      source: '↗ source', resolvingToken: 'Identifying this token…', resolveTokenFailed: 'Could not identify the token in this pool. Press ↻ to retry.', loadingStory: 'Loading DeBot narrative…', emptyStory: 'Nothing to show in this narrative record',
      nostory: 'DeBot has no narrative for this token yet', openDebot: 'Open on DeBot ↗', retry: 'Retry',
      secOrigin: 'Origin', secRating: 'Rating rationale', secSpread: 'Spread', secDev: 'Developer',
      fCeleb: 'Celebrity backing', fViews: 'Top views', fLikes: 'Top likes', fComments: 'Top comments', fCommunity: 'Community', fNegative: 'Negative events',
      fIdentity: 'Identity', fAddress: 'Address analysis',
      tabMeta: 'Meta', tabThesis: 'Thesis', tabHolders: 'Holders',
      sortLikes: 'By likes', sortTime: 'Newest ≥2 likes',
      readingHolders: 'Reading the Holders table…', readingTable: 'Reading the Holders table…',
      scrollHolders: 'Scroll the Holders table into view to load positions', scrollTable: 'Scroll the Holders table into view to load',
      noThesis: 'No holder has written a thesis yet',
      friendsOn: '“Friends only” is on — turn it off to see everyone', friendsMaybe: ' (if “Friends only” is on, turn it off for the full list)',
      bottomTab: 'Switch fomo’s bottom panel to the “Holders” tab (it’s on another tab now)',
      translated: 'This page is being translated by the browser, which rewrites the table text — choose “Show original” in the address-bar translate icon, then refresh', diag: 'Diagnose', diagTitle: 'Build a short report and copy it — paste it to the author', diagCopied: 'Diagnostic copied', diagShown: 'Diagnostic shown below',
      feedNoLikes: 'No thesis with ≥2 likes in the feed yet', feedMissing: 'Newest reads fomo’s own Thesis feed — open that tab once so it renders, then come back',
      capNewest: 'Showing the newest ', capLikes: 'Showing the top ', capTail: ' (of ', capEnd: ')',
      cost: 'cost ', held: 'held ', more: ' more', less: ' less',
      tweets: 'Source tweets', tweetsN: ' (', tweetsNEnd: ')', loading: 'Loading…', openTweet: 'Open tweet ↗', moreTweets: 'More source tweets (',
      pairsTitle: 'Pool quote assets (by liquidity)',
      shareLabel: 'fomo share', shareTotal: 'total ', shareMc: ' / MC ', shareCover: 'top ',
      shareTip: 'Total fomo-user holdings ÷ market cap (same yardstick as Windvane). The Holders table only renders the top N rows, so this is a floor (≥) — the true value is higher. Rule of thumb: ★ ≥15% · ★★ ≥20%. Hidden when the market cap cannot be read or does not add up.',
      fomoReading: 'Reading Thesis, Holders and fomo share from fomo…',
      fomoLogin: 'Log in to fomo first to read Thesis, Holders and fomo share.',
      fomoLoginAction: 'Log in to fomo ↗',
      fomoUnavailable: 'Could not read this token from fomo yet. Open fomo, make sure you are logged in, then return and refresh.',
      fomoOpenAction: 'Open on fomo ↗',
      fomoNoHolders: 'fomo is not showing holder data for this token yet',
      trPreparing: 'Preparing local translation (first run downloads a language pack)…', trDownloading: 'Downloading language pack ', trAbsent: 'This browser has no built-in translation; only 中/EN originals',
      trHint: '中 = translate to Chinese · EN = originals (Chrome on-device translation, nothing leaves the browser)', trBusy: 'Translating…',
      errDebot: 'Temporarily unavailable', errTweets: 'Source tweets temporarily unavailable',
      reconnecting: 'Connection interrupted. Retrying…', contextLost: 'The extension connection has expired. Reload this page to reconnect.', reloadPage: 'Reload page',
      aiLoading: 'Loading AI verdict…', ai: 'AI verdict', memeHook: 'meme hook', techFlags: 'Tech / red flags', updatedAt: 'Updated ', fullReport: 'Full analysis ↗',
      stale: '(snapshot at analysis time; market-cap figures may be stale)', tier: ' tier',
      justNow: 'just now', minAgo: ' min ago', hourAgo: ' h ago', dayAgo: ' d ago', monthAgo: ' mo ago',
    },
  };
  const tr = (k) => {
    const L = settings.lang === 'en' ? I18N.en : I18N.zh;
    return (k in L) ? L[k] : (I18N.zh[k] || k);
  };

  const STALE_MS = 48 * 60 * 60 * 1000;

  // 默认停靠：贴着左侧面板右缘，压在图表区上方，
  // 但不遮住上面的代币信息条，也不吃掉下面的 Holders 表。
  const DOCK_GAP = 8;
  const DOCK_TOP_OFFSET = 130;
  const DOCK_MIN_TOP = 190;
  const DOCK_BOTTOM_RESERVE = 140;
  const DOCK_FALLBACK = { left: 312, top: 200 };
  const RESIZE_MIN_W = 280;   // 再窄标签栏就挤了
  const RESIZE_MIN_H = 220;

  // v0.5：fomo 的 /hodlers/* API 已被 Cloudflare 挡掉（对程序化请求一律 403），
  // 改为直接读页面里 fomo React 已经渲染好的 DOM，零网络、绕开鉴权与风控。
  // 卡片空间有限：DeBot 段保持完整，其余段一律"精选不穷举"
  const SCRAPE_WATCH_MS = 25000; // DOM 观察者存活时长（表格常常十几秒后才渲染）
  // v0.7.1：自动弹卡时先等 fomo 自己渲染完，别抢在人家 React 前面弹到一片黑上。
  // 上限到点就照弹（宁可早出也不能不出），三个数都是可调的。
  const PAGE_READY_MAX_MS = 1500;   // 最多等这么久
  const PAGE_READY_POLL_MS = 120;   // 每隔这么久看一眼页面好没好
  const PAGE_READY_MIN_TEXT = 500;  // 正文字数超过这个就算"页面有东西了\"
  const HOLDER_SHOW = 6;      // 持有人榜取前 6（v0.7 主人要求）
  const THESIS_TAB_SHOW = 30; // v0.8：观点独立成 tab 后不再只取前 2，上限只防极端长表
  const THESIS_CLAMP = 150;   // ≈3 行
  const TWEET_SHOW = 1;       // 推文只直出 1 条，其余收进 details
  const TWEET_CLAMP = 110;    // ≈2 行
  const MEME_CLAMP = 120;     // meme 点：一句话笑话，超了给展开
  // ---------- fomo 界面 6 语种锚点（v0.9.6，词表抠自 fomo 自己的 Lingui 语言包，非猜测） ----------
  // 主人朋友 scar：fomo 账号语言=中文时页面全是"交易者/持仓/盈亏/平均持仓/仅看好友"，英文锚点一个都对不上。
  // 拉丁词加 \b 词界，CJK 直接子串；每个词组合成一个联合正则，下面所有解析点统一用它。
  const L10N = {
    hold:        ['avg\\.?\\s*hold', '平均持仓', '平均保有', 'Ø\\s*Haltedauer', 'de media por posición', 'Détention moy\\.'],
    trader:      ['Traders?', '交易者', 'トレーダー'],
    position:    ['Positions?', '持仓', 'ポジション', 'Positionen', 'Posici(?:ón|ones)'],
    pnl:         ['PnL', '盈亏', '損益'],
    entry:       ['Avg\\.?\\s*entry', '平均买入价', '平均買値', 'Ø\\s*Einstieg', 'Entrada prom\\.?', 'Moy\\.\\s*entrée'],
    thesis:      ['Thesis', '观点', '考察', 'These', 'Tesis', 'Thèse'],
    holders:     ['Holders', '持有者', '保有者', 'Halter', 'Détenteurs'],
    swaps:       ['Swaps', '交易', '取引'],
    friendsOnly: ['Friends\\s*only', '仅看好友', '友達のみ', 'Nur Freunde', 'Solo amigos', 'Amis uniquement'],
    thesisOnly:  ['Thesis\\s*only', '仅看观点', '考察のみ', 'Nur Thesen', 'Solo tesis', 'Thèses uniquement'],
    alerts:      ['Alerts', '通知', 'Alertas', 'Alertes'],
    marketCap:   ['Market\\s*cap', '市值', '時価総額', 'Marktkap\\.', 'Cap\\. de mercado', 'Capitalisation'],
    justNow:     ['just now', '刚刚', 'たった今', 'Gerade eben', 'Justo ahora', 'À l’instant', 'À l\'instant'],
  };
  // 拉丁词才加词界（CJK 没有词界，加了必然失配）。首字符判定覆盖整个 Latin-1/扩展区，
  // 别再逐个变音字母白名单——漏一个（Ü/Ä/ß）就是一门语言瞎掉。
  const isLatin = (w) => /^[A-Za-z\\\\]/.test(w) || /^[À-ɏ]/.test(w);
  // v0.9.8 scar：原来词界用 \b，而 \b 只认 ASCII \w —— 词首是 Ø/À、词尾是 \. 时，\b 反过来
  // 要求相邻字符**必须**是 ASCII 字母数字，于是 "Ø Haltedauer"/"Ø Einstieg"/"Marktkap."/
  // "Détention moy." 这些德法锚点永远匹配不上（v0.9.5~0.9.7 德法界面实际是瞎的，zh/ja 测试
  // 覆盖不到）。改成"两侧不得紧邻 ASCII 字母数字"的前后瞻：词界判定与词本身的首尾字符解耦，
  // 既照旧挡住 Synthesis / Traderss 这类词内误命中，又不再误杀非 ASCII 边缘。
  const NO_ADJ_L = '(?<![A-Za-z0-9])';
  const NO_ADJ_R = '(?![A-Za-z0-9])';
  const alt = (list, exact) => '(?:' + list.map((w) => (isLatin(w) && !exact ? NO_ADJ_L + w + NO_ADJ_R : w)).join('|') + ')';
  const rx = (key, flags, exact) => new RegExp(alt(L10N[key], exact), flags || '');
  // 时长/相对时间单位：en(mo|d|h|m|s|w) + 中(天|小时|分钟|秒|周|个月) + 日(日|時間|分|秒|週|ヶ月) + 德(Tag|Tage|Std\.|Min\.|Mon\.) + 西/法(h|min|j|d|mes|meses|mois)
  // ⚠️ 顺序即语义：正则选择分支从左到右先到先得，**长单位必须排在单字母类 [dhmsw] 前面**，
  // 否则 "4 Std." 会被 s 吃成 "4 S"、"4min" 会被 m 吃成 "4m"（DUR_RUN 不带 $ 锚点，
  // 截短了照样算整体匹配成功，于是德法时长显示成 "2 Tage 4 S"）。改这行前先想清楚这条。
  const DUR_UNIT = '(?:小时|分钟|个月|時間|ヶ月|Tage?|Std\\.?|Min\\.?|Mon\\.?|mes(?:es)?|mois|min|mo|天|秒|周|日|分|週|j|[dhmsw])';
  // 上限 6 段（"2 Tage 4 Std. 30 Min." 撑死 3 段）：把嵌套量词的回溯规模钉死，
  // 免得哪天页面塞进一长串数字时在正则里空转。
  const DUR_RUN = '(?:\\d+\\s*' + DUR_UNIT + '\\s*){1,6}';
  const SCRAPE_HOLD_RE = rx('hold', 'i');            // 持仓行的锚点文案（联合）
  const SCRAPE_HOLD_G = rx('hold', 'gi');
  // 无词界版：只用于扫 textContent（相邻单元格会被拼死，"…MEADGodØ Haltedauer" 这种
  // 前面紧贴字母的情况带词界必然漏）。对着 innerText 判定时一律用上面带词界的版本。
  const SCRAPE_HOLD_LOOSE = rx('hold', 'i', true);
  const SCRAPE_HOLD_LOOSE_G = rx('hold', 'gi', true);
  // "2d 4h avg. hold"（英）或 "平均持仓 22小时4分钟"（中/日/德/法，锚点在前）
  const HOLD_DUR_RE = new RegExp('(' + DUR_RUN + ')\\s*' + alt(L10N.hold) + '|' + alt(L10N.hold) + '\\s*[:：]?\\s*(' + DUR_RUN + ')', 'i');
  const URL_IN_TEXT_RE = /https:\/\/[^\s<>"'）)】]+/g;

  // verdict.label → 颜色档
  const LABEL_TONE = {
    skip: 'bad', no_chase: 'bad',
    observe: 'warn',
    pullback_plan: 'good', tiny_starter_only: 'good',
  };
  const LABEL_TEXT = {
    skip: 'skip', no_chase: 'no_chase', observe: 'observe',
    pullback_plan: 'pullback_plan', tiny_starter_only: 'tiny_starter_only',
  };

  // ---------- 运行态 ----------
  let host = null;         // shadow 宿主
  let grip = null;         // 右下角尺寸手柄
  let shadow = null;       // closed ShadowRoot
  let card = null;         // 卡片根节点
  let launcher = null;     // 圆钮（v0.9.6 可拖动）
  let launcherPos = null;  // {left, top} —— 拖过就记住
  let launcherAnchor = null; // Last visible close button; automatic placement is never saved as a drag.
  let launcherWasDragged = false;
  let lastClosedToken = null;
  let storyAttempt = 0, storyRetryTimer = null;
  let displayBrightness = 100;  // 亮度 50–150（friend 功能移植）
  let displayOpacity = 100;     // 透明度 35–100
  let updateInfo = null;        // {tag, url, newer:boolean} —— 版本检测结果
  let leftPanelHow = 'never';   // rect|fallback|error|never —— 左栏排除这道防线的实际状态（进 diag）
  let els = null;          // 卡片内常用节点引用
  let savedPos = null;     // {left, top}
  let savedSize = null;    // {w, h} —— 拖过尺寸就记住（v0.9.3）

  // 四个数据源各自独立成段、独立到达、独立渲染：
  // 任何一个慢或挂，都不许拖住其它段（尤其自配分析源不许拖住 DeBot）。
  const blank = () => ({ status: 'idle', data: null, error: null });
  const state = {
    open: false,
    ca: null,            // 当前卡片展示的 CA
    chain: null,         // 展示用链 slug
    srcAddr: null,       // v0.9.10：URL 上原本挂的地址（xxyy 是池子地址，反解后与 ca 不同）
    mode: 'url',         // 'url' | 'preview'
    pinned: false,
    compact: true,       // 本次展示是否精简布局（compact 模式或悬停预览恒为 true）
    // v0.8：卡片顶部三个标签页（跟 fomo 自家 tab 的用法一致）。
    // 'narrative' 叙事（默认）| 'views' 观点（持有人 thesis，按点赞排）| 'holders' 持仓者
    tab: 'narrative',
    thesisSort: 'likes',  // v0.8.7：'likes' 按赞（默认）| 'time' 最新（≥2赞且配到时间的）；换币不重置
    tweetsOpen: false,   // 来源推文段是否展开
    status: 'idle',      // DeBot 段状态（对外兼容字段）
    history: null,       // DeBot data.history
    error: null,         // v0.6 起恒为 null：错误文案一律由 FRIENDLY 决定，不落原始串
    errorKind: null,     // 仅供诊断，不参与任何渲染
    seq: 0,              // 请求序号，防竞态
    analysis: blank(),   // 自定义分析源判断
    holders: blank(),    // 从页面 DOM 抓的持仓表
    thesis: blank(),     // 从页面 Holders 表抓的 thesis
    scrapeFp: { holders: '', thesis: '' },  // 抓取指纹：没变就不重渲染
    pairs: blank(),      // DexScreener 池子交易对（头部 chips）
    tweets: blank(),     // 来源推文
  };

  let urlToken = null;     // {chain, ca} 来自当前 URL
  let hoverTimer = null;
  let hideTimer = null;
  let previewRow = null;   // 触发预览的那一行
  // v0.7.3 悬停停留：dwell 计时必须"钉在同一行"上，行内微小移动不得重置。
  // 记住当前计时器针对的那一行（DOM 容器）+ 解析出的 CA，以及最新的 target/坐标
  //（计时到点时用最新的 target 再解析一次，位置漂了也认得出）。
  let hoverPendingRow = null;
  let hoverPendingCa = null;
  let hoverPendingChain = null;
  let hoverPendingTarget = null;
  let hoverPendingX = 0;
  let hoverPendingY = 0;
  let hoverProbeSeq = 0;   // xxyy MAIN-world 探针的过期令牌；换行/离开后旧回包不许开卡

  // ---------- 工具 ----------
  const isHex = (s) => typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/.test(s);

  /** 一边像 0x 开头就必须两边都是合法 40 位十六进制，半截 0x 串不许落进字面比较。 */
  function sameCa(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const looksHex = /^0x/i.test(a) || /^0x/i.test(b);
    if (looksHex) return isHex(a) && isHex(b) && a.toLowerCase() === b.toLowerCase();
    return a === b;
  }

  function sameToken(a, b) {
    if (!a || !b) return !a && !b;
    return String(a.chain || '').toLowerCase() === String(b.chain || '').toLowerCase()
      && sameTokenRef(a.ca, b.ca);
  }

  // V4 pool IDs are route references, never token CAs or Fomo data identities.
  function sameTokenRef(a, b) {
    return sameCa(a, b) || (isXxyyPoolRef(a) && isXxyyPoolRef(b) && a.toLowerCase() === b.toLowerCase());
  }

  function isCurrentToken(hit) {
    if (!hit || String(hit.chain || '').toLowerCase() !== String(state.chain || '').toLowerCase()) return false;
    return sameCa(hit.ca, state.ca) || sameTokenRef(hit.ca, state.srcAddr);
  }

  function shortCa(ca) {
    if (typeof ca !== 'string' || ca.length < 12) return ca || '';
    return ca.slice(0, 6) + '…' + ca.slice(-4);
  }

  function nonEmpty(s) {
    return typeof s === 'string' && s.trim() !== '';
  }

  // DeBot 有时不返回空串，而是返回字面占位词，或"暂无…数据"这类整句无内容陈述。
  // 这些都等同于"没有内容"——但只在整段就是一句无数据陈述时才判空，绝不误伤
  // 正文中间带"无"的真实句子（如"团队匿名无背书但有回购"）。
  const PLACEHOLDERS = ['none', 'n/a', 'na', '暂无', '无', 'nothing', '未发现', '无明显', '-', '—'];
  // 整句无数据陈述：以这些词开头（且整段较短）
  const NODATA_PREFIX_RE = /^(暂无|未发现|尚无|未知|无明显|没有明显|没有相关|无相关)/;
  const NODATA_WORD_RE = /^无.{0,8}(数据|记录|信息|报告|证据|披露)/;
  const isPlaceholder = (str) => {
    const t = String(str == null ? '' : str).trim();
    if (!t) return true;
    if (PLACEHOLDERS.indexOf(t.toLowerCase()) !== -1) return true;
    // 只有整段就是"没有内容"时才算空；长句一律当作真内容
    if (t.length <= 30) {
      if (NODATA_PREFIX_RE.test(t)) return true;   // 暂无…/未发现…/未知…
      if (NODATA_WORD_RE.test(t)) return true;      // 无XX数据/记录…
      if (/规模未知[。.]?$/.test(t)) return true;    // …规模未知。
      if (/^无[。.\s]*$/.test(t)) return true;      // 无 / 无。
    }
    return false;
  };

  /** 真正有内容：非空、且不是占位词。 */
  const hasContent = (str) => nonEmpty(str) && !isPlaceholder(str);

  // 开发者信息只在"值得一提"时才显示：要么是风险，要么是强信号。
  const DEV_NOTEWORTHY = new RegExp([
    // 风险
    '诈骗', '挪用', '跑路', 'rug', '前科', '黑历史', '抛售', '出货', '砸盘', '警惕', '风险',
    'scam', 'fraud', 'dump', 'misappropriat', 'exploit',
    // 强信号
    '回购', '销毁', '锁仓', '买回', '转移所有权', '放弃所有权', '实名', 'doxx',
    'renounce', 'buyback', 'burn', 'lock', 'team wallet',
    'repurchase', 'destroy', 'transferred ownership',
  ].join('|'), 'i');

  const devWorthShowing = (str) => hasContent(str) && DEV_NOTEWORTHY.test(str);

  /**
   * "个人模式" = 用户配了自己的分析源。
   * 只有这种人才看得到 DeBot 的星级——分数主观，公开版不展示；评级理由两版都给。
   */
  const personalMode = () => nonEmpty(settings.analysisTemplate);

  /**
   * v0.6 铁律：任何一段取数/抓取失败，卡片上只出现下面这几句固定灰字。
   * 后台的原始 error 串、内部 kind（network/nostory/absent/no-permission…）
   * 一律不许出现在界面上——用户不需要看我们的内部词汇。
   */
  // 只有这两种失败值得单独说一句（主人点两下就能修）；其余一律一句灰字
  const ANALYSIS_ERR = { 'no-permission': 'noPermission', blocked: 'blocked' };
  const FRIENDLY = {
    get debot() { return tr('errDebot'); },
    get analysis() { return tr('errDebot'); },
    noPermission: '未授权访问分析源，去设置里重新保存',
    blocked: '分析源必须是 https 公网地址（不支持内网/本地地址）',
    absent: '分析源里还没有这只币',
    get tweets() { return tr('errTweets'); },
  };

  function safeHttps(url) {
    return typeof url === 'string' && /^https:\/\//i.test(url.trim()) ? url.trim() : null;
  }

  function relTime(iso) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return tr('justNow');
    if (s < 3600) return Math.floor(s / 60) + tr('minAgo');
    if (s < 86400) return Math.floor(s / 3600) + tr('hourAgo');
    if (s < 2592000) return Math.floor(s / 86400) + tr('dayAgo');
    return Math.floor(s / 2592000) + tr('monthAgo');
  }

  function absTime(iso) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return '';
    try { return new Date(t).toLocaleString('zh-CN'); } catch (_) { return iso; }
  }

  function debotUrl(chain, ca) {
    const slug = chain || (urlToken && urlToken.chain) || 'robinhood';
    return 'https://debot.ai/token/' + encodeURIComponent(slug) + '/' + encodeURIComponent(ca);
  }

  /** 极简 DOM 构造器；文本一律走 textContent。 */
  function h(tag, opts, kids) {
    const el = document.createElement(tag);
    if (opts) {
      if (opts.cls) el.className = opts.cls;
      if (nonEmpty(opts.text)) el.textContent = opts.text;
      if (opts.title) el.setAttribute('title', opts.title);
      if (opts.href) el.setAttribute('href', opts.href);
      if (opts.attrs) for (const k in opts.attrs) el.setAttribute(k, opts.attrs[k]);
      if (opts.on) for (const k in opts.on) listen(el, k, opts.on[k]);
    }
    if (kids) for (const kid of kids) if (kid) el.appendChild(kid);
    return el;
  }

  // ---------- 设置 ----------
  function loadSettings(cb) {
    try {
      // 同时把老的 autoOpen 也取回来，供 resolveOpenMode 做迁移判定
      // （openMode 用 null 兜底，才能区分"没存过"与"存了 compact"）。
      chrome.storage.sync.get(Object.assign({}, DEFAULTS, { openMode: null, autoOpen: null }), (v) => {
        if (disposed) return;
        const s = Object.assign({}, DEFAULTS, v || {});
        s.openMode = resolveOpenMode(v || {});
        delete s.autoOpen;
        settings = s;
        // A manual-mode launcher may already exist before async settings arrive.
        paintStaticI18n();
        if (cb) cb();
      });
    } catch (_) { if (cb) cb(); }
    try {
      chrome.storage.local.get({ [SK.pos]: null, [SK.size]: null, [SK.launcher]: null,
        displayBrightness: 100, displayOpacity: 100, translatorReady: false }, (v) => {
        if (disposed) return;
        const sz = v && v[SK.size];
        const ps = v && v[SK.pos];
        const lp = v && v[SK.launcher];
        if (sz && validSize(sz)) {   // K3 #8：NaN/负数/天文数字一律当没存过
          savedSize = { w: sz.w, h: sz.h };
          if (card) applySize();
        }
        if (ps && Number.isFinite(ps.left) && Number.isFinite(ps.top)) {   // Gickey D4
          savedPos = { left: ps.left, top: ps.top };
          if (card) applyPos();
        }
        if (lp && Number.isFinite(lp.left) && Number.isFinite(lp.top)) {
          launcherPos = { left: lp.left, top: lp.top };
          if (launcher) applyLauncherPos();
        }
        displayBrightness = Math.min(150, Math.max(50, Number(v && v.displayBrightness) || 100));
        displayOpacity = Math.min(100, Math.max(35, Number(v && v.displayOpacity) || 100));
        if (card) applyDisplayAppearance();
        checkUpdate();
        // 语言包此前下过 → 以后不必再点"译"，自动开。
        // 这个回调可能晚于首屏渲染，所以到货后重跑一次自动判定。
        translation.autoFlag = !!(v && v.translatorReady);
        if (translation.autoFlag && !translation.on) {
          translation.autoTried = false;
          translation.autoEnable();
        }
      });
    } catch (_) { /* 忽略 */ }
  }

  function watchSettings() {
    try {
      listenChrome(chrome.storage.onChanged, (changes, area) => {
        if (disposed) return;
        if (area === 'local' && changes) {   // v0.9.6：popup 设置项/卡片 ☀ 改亮度透明度 → 双向同步
          let disp = false;
          if ('displayBrightness' in changes) { displayBrightness = Math.min(150, Math.max(50, Number(changes.displayBrightness.newValue) || 100)); disp = true; }
          if ('displayOpacity' in changes) { displayOpacity = Math.min(100, Math.max(35, Number(changes.displayOpacity.newValue) || 100)); disp = true; }
          if (disp) applyDisplayAppearance();
          return;
        }
        if (area !== 'sync' || !changes) return;
        let langChanged = false;
        let sourceChanged = false;
        let openModeChanged = false;
        for (const k in changes) {
          if (k in DEFAULTS) {
            settings[k] = changes[k].newValue;
            if (k === 'lang') langChanged = true;
            if (k === 'updateCheck') checkUpdate();
            if (k === 'openMode') openModeChanged = true;
            if (k === 'analysisTemplate' || k === 'detailTemplate'
              || k === 'allowPrivateAnalysisSource') sourceChanged = true;
          } else if (k === 'autoOpen' && !('openMode' in changes)) {
            // 老客户端/迁移前只改了 autoOpen → 映射到 openMode
            settings.openMode = resolveOpenMode({ autoOpen: changes[k].newValue });
            openModeChanged = true;
          }
        }
        if (langChanged) {
          paintStaticI18n();
          if (state.status === 'ready') applyLangChange();
        }
        // openMode 即时生效：重排当前已开的卡片（compact/full 折叠态随之变化）
        if (openModeChanged && state.open && state.ca && !sourceChanged) {
          load(state.ca, state.chain, state.mode, false);
        }
        // 数据源设置即时生效：重新拉当前卡片
        if (sourceChanged && state.open && state.ca) {
          load(state.ca, state.chain, state.mode, true);
        }
      });
    } catch (_) { /* 忽略 */ }
  }

  function persistLang(lang) {
    settings.lang = lang;
    try { chrome.storage.sync.set({ lang }); } catch (_) { /* 忽略 */ }
  }

  // ---------- 后台通信 ----------
  function sendMsg(msg, cb) {
    if (disposed) return;
    let finished = false;
    const finish = resp => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (!disposed) cb(resp);
    };
    // Includes both 15s DeBot origins; a lost callback must not strand the card.
    const timer = setTimeout(() => finish({ ok: false, kind: 'message_timeout' }), 35000);
    const failure = () => {
      let connected = false;
      try { connected = !!chrome.runtime.id; } catch (_) {}
      return { ok: false, kind: connected || TEST ? 'connection' : 'context_invalidated' };
    };
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) { finish(failure()); return; }
        finish(resp || { ok: false, kind: 'connection' });
      });
    } catch (_) {
      finish(failure());
    }
  }

  const requestPairs = (ca, chain, force, cb) =>
    sendMsg({ type: 'dex-pairs', ca, chain: chain || '', force: !!force }, cb);
  const requestStory = (ca, force, cb) =>
    sendMsg({ type: 'debot-story', ca, force: !!force }, cb);
  const requestAnalysis = (ca, force, cb) =>
    sendMsg({ type: 'analysis-doc', ca, force: !!force }, cb);
  const requestTweets = (ids, force, cb) =>
    sendMsg({ type: 'debot-tweets', ids, force: !!force }, cb);
  // v0.9.10（自用·xxyy）：URL 上挂的是池子地址时，先让后台经 DexScreener 反解成代币 CA
  const requestResolve = (addr, chain, cb) =>
    sendMsg({ type: 'resolve-token', addr, chain: chain || '' }, cb);
  // v0.9.13：xxyy 的 Vue vnode 只存在页面 MAIN world；后台只返回坐标所在行的最小化 chain/CA。
  const requestXxyyVueHit = (x, y, cb) =>
    sendMsg({ type: 'xxyy-vue-hit', x: Number(x), y: Number(y) }, cb);
  // v0.9.14：xxyy 自己没有 Thesis/Holders 表；后台临时打开同币 fomo 页，复用用户现有登录态读取 DOM。
  const requestFomoTokenData = (ca, chain, force, cb) =>
    sendMsg({ type: 'fomo-token-data', ca, chain: chain || '', force: !!force }, cb);

  // ---------- 样式 ----------
  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.card, .launcher {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
               "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 13px; line-height: 1.55; color: #e6e7ea;
}
.card {
  position: fixed; top: 72px; right: 16px;
  width: min(360px, 92vw); max-height: 78vh;
  display: flex; flex-direction: column;
  background: #111214; border: 1px solid #26282c; border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,.55);
  z-index: 2147483000; overflow: hidden;
}
.card.preview { border-color: #ffb454; box-shadow: 0 12px 40px rgba(0,0,0,.55), 0 0 0 1px rgba(255,180,84,.35); }
.hdr { padding: 6px 10px; border-bottom: 1px solid #1e2024; cursor: grab; user-select: none; background: #131417; }
.hdr.dragging { cursor: grabbing; }
/* v0.8：顶部标签栏（叙事 / 观点 / 持仓者），样式对齐 fomo 自家 tab：当前页白字+下划线 */
.tabs { display: flex; align-items: stretch; gap: 2px; padding: 0 8px;
        background: #131417; border-bottom: 1px solid #1e2024; flex: 0 0 auto; }
.tab { background: none; border: none; border-bottom: 2px solid transparent;
       color: #9aa0aa; font-size: 12px; font-weight: 600; letter-spacing: .3px;
       padding: 7px 10px 5px; cursor: pointer;
       display: flex; align-items: center; gap: 5px; }
.tab:hover { color: #d3d6dc; }
.tab.on { color: #fff; border-bottom-color: #fff; }
.tcount { font-size: 10px; font-weight: 400; color: #6a6e76; background: #1a1c20;
          border-radius: 999px; padding: 0 5px; line-height: 1.5; }
.tab.on .tcount { color: #cfd2d8; }
.tcount:empty { display: none; }
.pane[hidden] { display: none !important; }
/* v0.7：左边"这是什么币"，右边一组图标钮；地址收进复制钮，星级另起一行 */
.hdr-top { display: flex; align-items: center; gap: 7px; min-width: 0; flex-wrap: nowrap; }
.hdr-acts { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.hdr-stars { margin-top: 3px; }
/* v0.9.10：Fomo 持仓占比横栏（头部下方、与头部同色；算不出就整条不长） */
.share-bar { padding: 3px 10px 4px; background: #131417; border-bottom: 1px solid #1e2024; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: 11px; color: #9aa0aa; cursor: grab; user-select: none; }
.share-pct { font-size: 12px; font-weight: 700; color: #cfd2d8; }
.share-pct.buy { color: #6fd8ab; }
.share-pct.strong { color: #40c48c; }
.share-tag { font-size: 10px; line-height: 1.3; border-radius: 999px; padding: 0 6px; border: 1px solid; }
.share-tag.buy { color: #6fd8ab; border-color: rgba(64,196,140,.45); background: rgba(64,196,140,.10); }
.share-tag.strong { color: #40c48c; border-color: rgba(64,196,140,.7); background: rgba(64,196,140,.18); }
.share-sub { color: #62666e; }
.name { font-size: 14px; font-weight: 600; color: #fff; letter-spacing: .2px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        max-width: 150px; flex: 0 1 auto; }
.spacer { flex: 1 1 auto; }
.btn { background: #1a1c20; border: 1px solid #26282c; color: #a8acb4; cursor: pointer;
       border-radius: 6px; padding: 2px 7px; font-size: 11px; line-height: 1.6; }
.btn:hover { color: #fff; border-color: #3a3d44; background: #202329; }
.btn.x { padding: 2px 8px; font-size: 14px; line-height: 1.2; }
.btn.icon { padding: 2px 6px; font-size: 12px; line-height: 1.5; }
.btn.copy { font-size: 11px; }
/* 中/EN 双档：当前档高亮，主人一眼看出在切什么 */
.btn.lang { padding: 2px 6px; letter-spacing: .3px; }
.lg { color: #6a6e76; font-size: 10px; }
.lg.on { color: #fff; font-weight: 600; }
/* 首次点「中」下载语言包时，切换钮上一闪而过的"翻译中…"瞬态（不再另起提示条） */
.lg.busy { color: #8fbaff; font-weight: 600; }
.lgsep { color: #3a3d44; font-size: 10px; margin: 0 1px; }
.stars { letter-spacing: 1px; font-size: 12px; color: #4a4d54; flex: 0 0 auto; white-space: nowrap; }
.stars:empty { display: none; }
.star.on { color: #ffc451; }
.chip { font-size: 11px; color: #9aa0aa; background: #1a1c20; border: 1px solid #26282c;
        border-radius: 999px; padding: 1px 8px; flex: 0 1 auto; max-width: 92px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip.pv { color: #ffb454; border-color: rgba(255,180,84,.4); background: rgba(255,180,84,.08); }
/* v0.8.3：类型 chip 右侧的池子交易对 chips（DexScreener），挤不下就整组裁切 */
.pairs { display: flex; align-items: center; gap: 3px; flex: 0 1 auto; min-width: 0; overflow: hidden; }
/* v0.9.6：段标题行支持右侧挂件（副池 chips） */
details > summary:has(.sum-t) { display: flex; align-items: center; gap: 6px; }
.sum-t { flex: 0 0 auto; }
.sum-sp { flex: 1 1 auto; }
.pairs-solo { display: flex; justify-content: flex-end; margin: 0 0 6px; }
.pairchip { font-size: 10px; color: #8fbaff; background: rgba(91,156,255,.08);
            border: 1px solid rgba(91,156,255,.25); border-radius: 999px; padding: 0 6px;
            white-space: nowrap; line-height: 1.6; flex: 0 0 auto; }
.pairchip.more { color: #6a6e76; background: #1a1c20; border-color: #26282c; }
/* v0.8.7：Thesis 页排序切换（按赞 / 最新） */
.sortrow { display: flex; gap: 4px; margin: 1px 0 6px; }
.sbtn { background: none; border: 1px solid #26282c; color: #7f8590; cursor: pointer;
        border-radius: 999px; padding: 1px 9px; font-size: 11px; line-height: 1.6; }
.sbtn:hover { color: #d3d6dc; border-color: #3a3d44; }
.sbtn.on { color: #fff; border-color: #4a4d54; background: #1a1c20; }
/* v0.8.9：页尾署名 */
.byfoot { flex: 0 0 auto; text-align: right; font-size: 10px; color: #4a4d54;
          padding: 3px 20px 5px 12px; border-top: 1px solid #1e2024; letter-spacing: .3px; }
/* v0.9.3：右下角尺寸手柄。默认几乎看不见，悬停/拖动时才亮——不抢卡片本身的视觉 */
.grip { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
        cursor: nwse-resize; z-index: 3; opacity: .35; }
.grip::after { content: ''; position: absolute; right: 3px; bottom: 3px; width: 7px; height: 7px;
               border-right: 2px solid #6a6e76; border-bottom: 2px solid #6a6e76; border-radius: 0 0 2px 0; }
.grip:hover, .card.resizing .grip { opacity: 1; }
/* v0.9.4 诊断：空态下一个不起眼的小字按钮，点开一小块等宽报告 */
.diag-btn { display: inline-block; margin: 6px 0 0; padding: 0; background: none; border: none;
            color: #4a4d54; font-size: 11px; cursor: pointer; text-decoration: underline dotted; }
.diag-btn:hover { color: #9aa0aa; }
.diag { margin: 6px 0 0; padding: 6px 8px; background: #0c0d0f; border: 1px solid #1e2024; border-radius: 6px;
        color: #8a8f99; font-size: 10.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-all;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; user-select: text; }
.card.resizing { user-select: none; }
.byfoot { display: flex; align-items: center; gap: 4px; }
.byfoot-sp { flex: 1 1 auto; }
.byfoot a { color: #6a6e76; text-decoration: none; }
.upd { order: -1; margin-right: auto; color: #ffb454 !important; font-weight: 600; }
.upd:hover { color: #ffd08a !important; text-decoration: underline; }
.byfoot a:hover { color: #9aa0aa; text-decoration: underline; }
.body {
  /* v0.7.3：页脚整段移除后，正文底 padding 补到 10px，最后一段收口不贴边 */
  padding: 10px 12px 10px; overflow-y: auto; overflow-x: hidden; flex: 1 1 auto;
  /* 各段陆续到达时，靠滚动锚定保住主人正在读的那一行，不许跳 */
  overflow-anchor: auto;
}
/* 评级理由：排到第二位后仍保留蓝色高亮——它是这一段里唯一的"判断" */
.rating { background: rgba(91,156,255,.07); border: 1px solid rgba(91,156,255,.22);
          border-left: 3px solid #5b9cff; border-radius: 8px; padding: 8px 10px;
          margin: 0 0 11px; }
.rating > summary { color: #8fbaff; }
.rating .txt { color: #dfe6f5; }
/* DeBot 四段统一节奏：段间 11px，收起的段自然更紧凑 */
details { margin: 0 0 11px; }
.slot > details:last-child { margin-bottom: 4px; }
summary { cursor: pointer; font-size: 12px; font-weight: 600; color: #9aa0aa;
          list-style: none; outline: none; padding: 2px 0; }
summary::-webkit-details-marker { display: none; }
summary::before { content: "▾ "; color: #565a62; font-size: 10px; }
details:not([open]) > summary::before { content: "▸ "; }
.txt { color: #d3d6dc; white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 3px;
       line-height: 1.65; }
/* v0.6：字段行标签 chip 与正文不再糊在一起 */
.item { margin-top: 9px; line-height: 1.65; }
.lbl { display: inline-block; font-size: 11px; color: #7f8590; background: #1a1c20;
       border: 1px solid #24262a; border-radius: 4px; padding: 1px 7px;
       margin-right: 9px; margin-bottom: 2px; vertical-align: 1px; letter-spacing: .3px; }
.item > .txt { display: inline; }
.ref { color: #5b9cff; text-decoration: none; font-size: 11px; margin-left: 5px; white-space: nowrap; }
.ref:hover { text-decoration: underline; }
.state { padding: 22px 14px; text-align: center; color: #8b8f98; }
.state .em { color: #d3d6dc; display: block; margin-bottom: 10px; }
.spin { width: 18px; height: 18px; margin: 0 auto 10px; border-radius: 50%;
        border: 2px solid #2a2d33; border-top-color: #5b9cff; animation: sp .8s linear infinite; }
@keyframes sp { to { transform: rotate(360deg); } }
.launcher {
  position: fixed; right: 12px; top: 44vh; width: 116px; height: 40px; padding: 0 12px;
  display: flex; align-items: center; justify-content: center; gap: 10px; border-radius: 20px;
  background: linear-gradient(135deg, #1e2e3b, #111a23); border: 1px solid #4c718f;
  color: #baddf7; cursor: pointer; z-index: 2147483647; user-select: none; touch-action: none;
  box-shadow: 0 4px 16px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.08);
  transition: border-color .16s, background .16s, box-shadow .16s, color .16s;
}
.launcher:hover, .launcher:focus-visible { color: #dcefff; border-color: #80baff;
  box-shadow: 0 5px 22px rgba(0,0,0,.5), 0 0 0 3px rgba(104,176,255,.12); }
.launcher:focus-visible { outline: 2px solid #a9d6ff; outline-offset: 3px; }
.launcher-label { font-size: 12px; font-weight: 600; letter-spacing: .1px; white-space: nowrap; pointer-events: none; }
.launcher.just-closed { animation: lens-arrive .22s ease-out; }
.launcher.dragging { cursor: grabbing; border-color: #a9d6ff; }
@keyframes lens-arrive { from { opacity: 0; transform: translateX(8px); } to { opacity: 1; transform: translateX(0); } }
.lens-mark { width: 14px; height: 14px; flex: 0 0 14px; box-sizing: border-box; border: 2px solid currentColor;
  border-radius: 50%; position: relative; margin: -3px 3px 0 0; pointer-events: none; }
.lens-mark::after { content: ''; position: absolute; width: 7px; height: 2px;
  background: currentColor; border-radius: 2px; right: -6px; bottom: -3px; transform: rotate(45deg); }
.launcher-tip { position: absolute; right: calc(100% + 10px); top: 50%; transform: translateY(-50%);
  padding: 9px 12px; background: #19212b; border: 1px solid #354658; border-radius: 10px;
  white-space: nowrap; text-align: left; color: #e2edf8; box-shadow: 0 4px 16px rgba(0,0,0,.35);
  opacity: 0; visibility: hidden; pointer-events: none; transition: opacity .16s; }
.launcher-tip strong { display: block; font-size: 12px; font-weight: 500; }
.launcher-tip small { display: block; margin-top: 3px; color: #8fa4b8; font-size: 10px; }
.launcher.tip-right .launcher-tip { left: calc(100% + 10px); right: auto; }
.launcher.tip-below .launcher-tip { position: fixed; left: 50%; right: auto; top: auto;
  bottom: 16px; transform: translateX(-50%); max-width: calc(100vw - 24px); white-space: normal; }
.launcher:hover .launcher-tip, .launcher:focus-visible .launcher-tip { opacity: 1; visibility: visible; }
.launcher.dragging .launcher-tip { opacity: 0; visibility: hidden; }
@media (max-width: 520px) { .launcher-tip, .launcher.tip-right .launcher-tip {
  position: fixed; left: 50%; right: auto; top: auto; bottom: 16px; transform: translateX(-50%);
  max-width: calc(100vw - 24px); white-space: normal;
} }
@media (prefers-reduced-motion: reduce) { .launcher, .launcher.just-closed, .launcher-tip { transition: none; animation: none; } }
/* v0.9.6 亮度/透明度面板 */
.display-panel { flex: 0 0 auto; background: #131417; border-bottom: 1px solid #1e2024;
                padding: 8px 12px; display: flex; flex-direction: column; gap: 8px; }
.display-panel label { display: flex; align-items: center; gap: 8px; font-size: 11px; color: #9aa0aa; }
.display-lbl { flex: 0 0 40px; }
.display-range { flex: 1 1 auto; accent-color: #5b9cff; }
.display-val { flex: 0 0 38px; text-align: right; color: #cfd2d8; font-variant-numeric: tabular-nums; }
.toast { position: fixed; right: 18px; bottom: 64px; background: #17181c; color: #cfd2d8;
         border: 1px solid #2c2f35; border-radius: 8px; padding: 6px 10px; font-size: 12px;
         z-index: 2147483001; }
[hidden] { display: none !important; }

/* ---------- v0.2 新增段 ---------- */
.slot { display: block; }
.sec { margin-bottom: 12px; }
.sechead { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; flex-wrap: wrap; }
.sectitle { font-size: 12px; font-weight: 600; color: #9aa0aa; }
/* v0.8：Thesis / KOL 的可折叠段（.collap-*）随标签页化整段移除——观点/持仓者各占一个 tab */
.grey { color: #7f8590; font-size: 12px; padding: 2px 0; }
.muted { color: #7f8590; font-size: 12px; margin-top: 6px; }

/* AI 判断段：与 DeBot 段视觉上必须一眼分得开 */
.analysis {
  background: rgba(64,196,140,.06); border: 1px solid rgba(64,196,140,.22);
  border-left: 3px solid #40c48c; border-radius: 8px; padding: 9px 10px; margin-bottom: 12px;
}
.analysis.stale { opacity: .82; }
.analysis .sectitle { color: #6fd8ab; }
.oneliner { color: #eaf6f1; font-weight: 500; margin: 2px 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.badges { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 7px; }
.badge { font-size: 11px; border-radius: 999px; padding: 1px 8px; border: 1px solid; cursor: default; }
.badge.good { color: #6fd8ab; border-color: rgba(64,196,140,.45); background: rgba(64,196,140,.10); }
.badge.warn { color: #ffc451; border-color: rgba(255,196,81,.45); background: rgba(255,196,81,.10); }
.badge.bad  { color: #ff7b72; border-color: rgba(255,123,114,.45); background: rgba(255,123,114,.10); }
.badge.score { color: #cfd2d8; border-color: #33363c; background: #1a1c20; }
.kv { margin-top: 5px; overflow-wrap: anywhere; }
.kv .k { color: #7f8590; font-size: 11px; margin-right: 5px; }
.kv .v { color: #d3d6dc; }
.memehook { margin-top: 6px; margin-bottom: 7px; }
.memehook .rtext { display: inline; color: #cdd8d3; }
.memehook .k { color: #6fd8ab; }
.bz { margin-top: 8px; border-top: 1px dashed rgba(64,196,140,.28); padding-top: 7px; }
.bz .kv .k { display: inline-block; min-width: 62px; color: #6fd8ab; }
.flags { color: #ff7b72; }
.ok-line { color: #6fd8ab; }
.dmeta { margin-top: 8px; font-size: 11px; color: #7f8590;
         display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.dmeta a { color: #6fd8ab; text-decoration: none; }
.dmeta a:hover { text-decoration: underline; }

/* thesis / 推文 行 */
.row-item { border-top: 1px solid #1e2024; padding: 8px 0 2px; }
.row-item:first-of-type { border-top: none; }
.share-sum { font-size: 11px; color: #8a8f99; padding: 2px 0 6px; margin-bottom: 4px; border-bottom: 1px solid #1e2024; }
.share-sum .share-pct { font-size: 11px; }
.rhead { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; margin-bottom: 3px; }
.rauthor { color: #cfd2d8; font-weight: 600; font-size: 12px; }
.rval { color: #6fd8ab; font-size: 11px; }
.rcost { color: #9aa0aa; font-size: 11px; }
.sep { color: #4a4d54; font-size: 11px; }
.pnl { font-size: 11px; font-weight: 600; }
.pnl.pos { color: #40c48c; }
.pnl.neg { color: #ff7b72; }
.rtime { color: #62666e; font-size: 11px; }
.rlikes { color: #7f8590; font-size: 11px; }
.rtext { color: #d3d6dc; white-space: pre-wrap; overflow-wrap: anywhere; }
.rtext a { color: #5b9cff; text-decoration: none; }
.rtext a:hover { text-decoration: underline; }
.more { background: none; border: none; color: #5b9cff; font-size: 11px;
        cursor: pointer; padding: 2px 0; }
.chiplink { display: inline-block; margin: 3px 5px 0 0; font-size: 11px; color: #5b9cff;
            text-decoration: none; background: #1a1c20; border: 1px solid #26282c;
            border-radius: 5px; padding: 0 6px; }
.chiplink:hover { color: #fff; border-color: #3a3d44; }
.rsub { color: #8b8f98; font-size: 11px; margin-top: 2px; }
.devchip { font-size: 10px; color: #ffc451; border: 1px solid rgba(255,196,81,.45);
           background: rgba(255,196,81,.10); border-radius: 4px; padding: 0 4px; }
.rlink { color: #5b9cff; text-decoration: none; font-size: 11px; }
.rlink:hover { text-decoration: underline; }
details.tweets { margin-bottom: 12px; }
details.tweets > summary { color: #9aa0aa; }
.more-block { margin-top: 6px; }
.more-block > summary, .bzfull > summary { font-size: 11px; font-weight: 400; color: #7f8590; }
.bzfull { margin-top: 6px; margin-bottom: 0; }
.bzfull > summary::before { color: #6fd8ab; }
`;

  // ---------- 卡片骨架 ----------
  function ensureUi() {
    if (disposed || shadow) return;
    for (const old of document.querySelectorAll('[data-fomo-debot]')) {
      if (!old.dataset.fomoExtension || old.dataset.fomoExtension === extensionId) old.remove();
    }
    host = document.createElement('div');
    host.setAttribute('data-fomo-debot', '');
    host.dataset.fomoExtension = extensionId;
    // 宿主本身不占位，避免影响页面布局
    host.style.cssText = 'all:initial;position:static;';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    // --- 卡片 ---
    const name = h('span', { cls: 'name' });
    // v0.7：头部不再摊开长长的合约地址，换成一个复制图标钮
    const caBtn = h('button', {
      cls: 'btn icon copy', text: '📋', attrs: { type: 'button' },
      title: tr('copyCa'), on: { click: copyCa },
    });
    const pinBtn = h('button', {
      cls: 'btn pin', text: '📌', attrs: { type: 'button' }, title: tr('pin'),
      on: { click: () => { state.pinned = true; state.mode = 'url'; cancelHide(); paintChrome(); } },
    });
    // v0.7：光一个 "EN" 主人看不懂在切什么 → 做成 中/EN 双档，高亮当前档。
    // v0.7.3：这个钮升格为「唯一的翻译开关」——切到「中」= 需要时下载语言包并翻译，
    // 「翻译中…」瞬态就借这个钮显示（langBusy），不再另起段内提示条/译按钮。
    const langZh = h('span', { cls: 'lg', text: '中' });
    const langEn = h('span', { cls: 'lg', text: 'EN' });
    const langSep = h('span', { cls: 'lgsep', text: '/' });
    const langBusy = h('span', { cls: 'lg busy', text: tr('trBusy') });
    langBusy.hidden = true;
    const langBtn = h('button', {
      cls: 'btn lang', attrs: { type: 'button' }, title: tr('langBtn'),
      on: { click: toggleLang },
    }, [langZh, langSep, langEn, langBusy]);
    const displayBtn = h('button', {
      cls: 'btn icon', text: '☀', attrs: { type: 'button' }, title: tr('displayBtn'),
      on: { click: (e) => { e.stopPropagation(); displayPanel.hidden = !displayPanel.hidden; } },
    });
    const brightnessVal = h('span', { cls: 'display-val', text: displayBrightness + '%' });
    const opacityVal = h('span', { cls: 'display-val', text: displayOpacity + '%' });
    const brightnessInput = h('input', { cls: 'display-range', attrs: { type: 'range', min: '50', max: '150', step: '5', value: String(displayBrightness) } });
    const opacityInput = h('input', { cls: 'display-range', attrs: { type: 'range', min: '35', max: '100', step: '5', value: String(displayOpacity) } });
    const displayPanel = h('div', { cls: 'display-panel' }, [
      h('label', {}, [h('span', { cls: 'display-lbl', text: tr('brightness') }), brightnessInput, brightnessVal]),
      h('label', {}, [h('span', { cls: 'display-lbl', text: tr('opacity') }), opacityInput, opacityVal]),
    ]);
    displayPanel.hidden = true;
    listen(brightnessInput, 'input', () => updateDisplayAppearance(brightnessInput.value, opacityInput.value));
    listen(opacityInput, 'input', () => updateDisplayAppearance(brightnessInput.value, opacityInput.value));
    const refreshBtn = h('button', {
      cls: 'btn icon', text: '↻', attrs: { type: 'button' }, title: tr('refresh'),
      on: { click: () => { if (state.ca) {
        if (SITE.resolveAddr && state.srcAddr && (state.resolving || state.resolveFailed)) {
          openToken({ca:state.srcAddr,chain:state.chain}, state.mode, true);
        } else { load(state.ca, state.chain, state.mode, true); rescanNow(true); }
      } } },
    });
    const closeBtn = h('button', {
      cls: 'btn x', text: '×', attrs: { type: 'button' }, title: tr('close'),
      on: { click: () => closeCard() },
    });

    // v0.7 布局：左边是"这是什么币"（名字 + 类型 + 预览角标），
    // 右边一组图标钮（复制/固定/中EN/重抓/关闭），星级另起一行不跟着挤。
    const stars = h('span', { cls: 'stars' });
    // v0.8.6：叙事类型 chip（项目类/人物类/事件类）撤掉腾位置给副池 chips（主人：不够位置了）；
    // 类型信息收进名字的悬停提示，不丢。
    const pairsWrap = h('span', { cls: 'pairs' });
    pairsWrap.hidden = true;
    const pvChip = h('span', { cls: 'chip pv', text: tr('preview') });
    const hdrTop = h('div', { cls: 'hdr-top' }, [name, pvChip,
      h('span', { cls: 'spacer' }),
      h('div', { cls: 'hdr-acts' }, [caBtn, pinBtn, langBtn, displayBtn, refreshBtn, closeBtn])]);
    const starRow = h('div', { cls: 'hdr-stars' }, [stars]);
    starRow.hidden = true;
    const hdr = h('div', { cls: 'hdr' }, [hdrTop, starRow]);
    listen(hdr, 'mousedown', onDragStart);
    // v0.9.2：拖过的位置会持久化（cardPos），主人实测卡片"跑到 K 线图中间"就是拖过一次之后回不来——
    // 双击头部空白处清掉记忆位置、回到默认停靠。
    listen(hdr, 'dblclick', onHeaderDblClick);
    // v0.9.10：Fomo 持仓占比独占一条横栏，紧贴头部下方（主人要"一眼看到"，不必切到 Holders 页）。
    // 不塞进 .hdr——头部"单行 ≤40px"是 v0.6 定下的瘦身线（步骤 2b 守着）；横栏与头部同色，
    // 视觉上就是头部第二行，也一样能拖、能双击归位。算不出就整条收掉。
    const shareRow = h('div', { cls: 'share-bar' });
    shareRow.hidden = true;
    listen(shareRow, 'mousedown', onDragStart);
    listen(shareRow, 'dblclick', onHeaderDblClick);

    // v0.8：顶部标签栏（跟 fomo 自家的 tab 一个用法）。
    // 叙事（默认）= DeBot 叙事 + AI 判断 + 来源推文；观点 = 持有人 thesis（按点赞排）；
    // 持仓者 = KOL 持仓。五个 slot 仍各自独立填充——渲染不看标签页是否可见，
    // 切过去内容已经在了。
    const slotDebot = h('div', { cls: 'slot slot-debot' });
    // v0.8.9 主人定的 Meta 页顺序：起源/评级理由 → AI 判断 → 来源推文 → 传播/开发者
    const slotDebotTail = h('div', { cls: 'slot slot-debot-tail' });
    const slotThesis = h('div', { cls: 'slot slot-thesis' });
    const slotAnalysis = h('div', { cls: 'slot slot-analysis' });
    const slotKol = h('div', { cls: 'slot slot-kol' });
    const slotTweets = h('div', { cls: 'slot slot-tweets' });
    const paneNarrative = h('div', { cls: 'pane pane-narrative' },
      [slotDebot, slotAnalysis, slotTweets, slotDebotTail]);
    const paneViews = h('div', { cls: 'pane pane-views' }, [slotThesis]);
    const paneHolders = h('div', { cls: 'pane pane-holders' }, [slotKol]);
    paneViews.hidden = true;
    paneHolders.hidden = true;

    const tabBtns = [];
    // fomo 直接读当前页；xxyy 通过登录态镜像读同币 fomo 页。两者都展示完整三页。
    const tabDefs = HAS_FOMO_DATA ? [
      ['narrative', 'tabMeta'], ['views', 'tabThesis'], ['holders', 'tabHolders'],
    ] : [['narrative', 'tabMeta']];
    for (const [key, label] of tabDefs) {
      const count = h('span', { cls: 'tcount' });
      const btn = h('button', {
        cls: 'tab' + (key === 'narrative' ? ' on' : ''), attrs: { type: 'button' },
        on: { click: () => switchTab(key) },
      }, [h('span', { cls: 'tlabel', text: tr(label) }), count]);
      btn.dataset.tab = key;
      tabBtns.push(btn);
    }
    const tabs = h('div', { cls: 'tabs' }, tabBtns);

    const body = h('div', { cls: 'body' }, [paneNarrative, paneViews, paneHolders]);
    // v0.8.9：页尾只有一行署名（v0.7.3 撤掉的信息页脚不回来）。
    const byfoot = h('div', { cls: 'byfoot' }, [
      h('span', { cls: 'byfoot-sp' }),
      h('span', { text: 'By ' }),
      h('a', { text: '@0xHogen', href: 'https://x.com/0xHogen',
        attrs: { target: '_blank', rel: 'noopener noreferrer', title: 'Fomo Lens · Fomo放大镜 — by @0xHogen' } }),
    ]);
    grip = h('div', { cls: 'grip', title: tr('resizeHint') });
    listen(grip, 'mousedown', onResizeStart);
    card = h('div', { cls: 'card' }, [hdr, shareRow, displayPanel, tabs, body, byfoot, grip]);
    card.hidden = true;
    listen(card, 'mouseenter', () => { cancelHide(); rescanNow(); });
    listen(card, 'mouseleave', () => { if (state.mode === 'preview') scheduleHide(); });

    // --- 圆钮 ---
    launcher = h('button', {
      cls: 'launcher', attrs: { type: 'button', 'aria-label': tr('launcher'), 'aria-expanded': 'false' },
      on: { click: onLauncherClick },
    }, [h('span', { cls: 'lens-mark', attrs: { 'aria-hidden': 'true' } }),
      h('span', { cls: 'launcher-label', text: 'Fomo Lens', attrs: { 'aria-hidden': 'true' } }),
      h('span', { cls: 'launcher-tip', attrs: { 'aria-hidden': 'true' } }, [
        h('strong', { text: tr('launcher') }), h('small', { text: tr('launcherHint') }),
      ]),
    ]);
    listen(launcher, 'pointerdown', onLauncherDragStart);

    shadow.appendChild(card);
    shadow.appendChild(launcher);
    document.documentElement.appendChild(host);

    els = { name, caBtn, pinBtn, langBtn, refreshBtn, closeBtn, langZh, langEn, langSep, langBusy, stars, starRow,
            pairsWrap, pvChip, hdr, body, tabBtns, displayBtn, displayPanel, byfoot, shareRow,
            brightnessInput, opacityInput, brightnessVal, opacityVal,
            paneNarrative, paneViews, paneHolders,
            slotDebot, slotDebotTail, slotThesis, slotAnalysis, slotKol, slotTweets };
    applySize();   // 记住过的尺寸先贴上；内部会调 applyPos 定位（v0.9.3）
    applyLauncherPos();
    applyDisplayAppearance();
  }

  /**
   * 找左侧 Alerts/Tokens/Leaderboard/Feed 那个面板。
   * 以 "Alerts" 标签为锚往上爬，取第一个够大的容器当面板本体。
   */
  function findLeftPanel() {
    if (SITE.id === 'gmgn') {
      // Real GMGN uses a div-based WalletTrack pane, including before login.
      // Its width is resizable; a fixed x=440 can cover the rightmost row cells.
      const tracker = document.querySelector('[data-sentry-component="WalletTrack"]');
      if (tracker) {
        const r = tracker.getBoundingClientRect();
        if (r.left >= 0 && r.left < 100 && r.width >= 200 && r.width <= innerWidth * 0.55 && r.height >= 120) return r;
      }
      const starts = [...document.querySelectorAll('[role="tab"][id$="-tab-tracking"]'), previewRow,
        ...document.querySelectorAll('aside,[role="complementary"],a[href*="/token/"]')].filter(Boolean);
      for (const start of starts.slice(0, 80)) {
        for (let el = start, up = 0; el && el !== document.body && up < 12; up++, el = el.parentElement) {
          const r = el.getBoundingClientRect();
          if (r.left >= 0 && r.left < 100 && r.width >= 200 && r.width <= innerWidth * 0.55 && r.height >= 300) return r;
        }
      }
      return null;
    }
    try {
      // 只在"按钮/标签/链接"里找锚，绝不遍历 div——读大 div 的 textContent
      // 会拿到整页文本，成千上万次就是自爆。锚元素文本很短，安全。
      let anchor = null;
      const cands = document.querySelectorAll('button, [role="tab"], a, span');
      for (const el of cands) {
        const t = el.textContent || '';
        if (t.length <= 12 && rx('alerts', '', true).test(t.trim()) && new RegExp('^' + alt(L10N.alerts, true) + '$').test(t.trim())) { anchor = el; break; }
      }
      if (!anchor) return null;
      let node = anchor;
      for (let i = 0; i < 12 && node; i++, node = node.parentElement) {
        const r = node.getBoundingClientRect();
        if (r.height > 400 && r.width > 200) return r;
      }
    } catch (_) { /* 找不到就用兜底坐标，绝不抛 */ }
    return null;
  }

  function dockedPos() {
    try {
      const panel = findLeftPanel();
      if (panel) {
        return {
          left: Math.round(panel.right + DOCK_GAP),
          top: Math.round(Math.max(panel.top + DOCK_TOP_OFFSET, DOCK_MIN_TOP)),
        };
      }
    } catch (_) { /* 落到兜底 */ }
    return { left: SITE.id === 'gmgn' ? 440 : DOCK_FALLBACK.left, top: DOCK_FALLBACK.top };
  }

  let gmgnDockGeometry = '';
  function refreshGmgnDock() {
    if (SITE.id !== 'gmgn' || !card || card.hidden || savedPos) return;
    const panel = document.querySelector('[data-sentry-component="WalletTrack"]');
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const geometry = [r.left, r.right, r.top, r.height, innerWidth, innerHeight].join('|');
    if (geometry === gmgnDockGeometry) return;
    gmgnDockGeometry = geometry;
    applyPos();
  }

  /**
   * fomo 页面到底渲染出来了没有。命中任意一条即认为"页面有东西了"：
   *   ① 左栏面板（Alerts/Tokens/Leaderboard/Feed 那个 tab 栏）已经在了
   *   ② 正文已经有实质文字量
   *   ③ 代币信息条已经画出来（Market cap 是那条上的固定字样）
   * 判不出来一律当"还没好"，交给上限兜底。
   */
  function pageReady() {
    try {
      if (findLeftPanel()) return true;
      const t = document.body ? (document.body.innerText || '') : '';
      if (t.length > PAGE_READY_MIN_TEXT) return true;
      if (rx('marketCap', 'i').test(t)) return true;
    } catch (_) { /* 判不出就当没好 */ }
    return false;
  }

  function showCardNow() {
    if (!card) return;
    card.hidden = false;
    if (launcher) { launcher.hidden = true; launcher.classList.remove('just-closed'); launcher.setAttribute('aria-expanded', 'true'); }
    applyPos(); // 面板可能刚渲染出来，这时候算停靠位才准
  }

  /**
   * 自动弹出路径专用：页面就绪（或等够 1.5s）再让卡片出场。
   * 取数不等——DeBot 那一路在后台照跑，卡片一现身数据就已经在了。
   */
  let revealTimer = null;
  function clearReveal() {
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
  }

  function revealWhenPageReady(seq) {
    clearReveal();
    const startedAt = Date.now();
    const tick = () => {
      revealTimer = null;
      if (seq !== state.seq || !state.open) return;   // 已被新的一次 load 取代 / 卡片关了
      if (pageReady() || Date.now() - startedAt >= PAGE_READY_MAX_MS) {
        showCardNow();
        rescanNow(true);   // 页面刚就绪，立刻按新 DOM 补扫一遍
        return;
      }
      revealTimer = setTimeout(tick, PAGE_READY_POLL_MS);
    };
    tick();
  }

  /** 用户拖过就永远听用户的；没拖过才每次重算停靠位。定位失败绝不连累开卡。 */
  function applyPos() {
    if (!card) return;
    try {
      const dragged = savedPos && typeof savedPos.left === 'number';
      const pos = dragged ? savedPos : dockedPos();
      const maxL = Math.max(0, window.innerWidth - 80);
      const maxT = Math.max(0, window.innerHeight - 60);
      const left = Math.min(Math.max(0, pos.left), maxL);
      const top = Math.min(Math.max(0, pos.top), maxT);
      card.style.left = left + 'px';
      card.style.top = top + 'px';
      card.style.right = 'auto';
      // 给下方 Holders 表留出空间。用户自定过尺寸时不再压高度——那是他自己拉的（v0.9.3）
      if (validSize(savedSize)) {
        card.style.maxHeight = 'none';
      } else {
        const room = Math.max(160, window.innerHeight - top - DOCK_BOTTOM_RESERVE);
        card.style.maxHeight = 'min(58vh, ' + room + 'px)';
      }
    } catch (_) {
      // 极端情况下退回一个安全的默认位置
      try {
        card.style.left = DOCK_FALLBACK.left + 'px';
        card.style.top = DOCK_FALLBACK.top + 'px';
        card.style.right = 'auto';
      } catch (_2) { /* 忽略 */ }
    }
  }

  // ---------- 拖拽 ----------
  function onDragStart(e) {
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('button, a')) return;
    const rect = card.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    els.hdr.classList.add('dragging');
    cancelHide();

    const move = (ev) => {
      const left = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 60);
      const top = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 40);
      card.style.left = left + 'px';
      card.style.top = top + 'px';
      card.style.right = 'auto';
      savedPos = { left, top };
    };
    const up = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      els.hdr.classList.remove('dragging');
      try { chrome.storage.local.set({ [SK.pos]: savedPos }); } catch (_) { /* 忽略 */ }
    };
    listen(window, 'mousemove', move, true);
    listen(window, 'mouseup', up, true);
    e.preventDefault();
  }

  /** 把记住的尺寸贴回卡片；没记过就还原成默认（宽度靠 CSS，高度交回 applyPos 的上限逻辑）。 */
  function validSize(sz) {
    return !!sz && Number.isFinite(sz.w) && Number.isFinite(sz.h)
      && sz.w >= RESIZE_MIN_W && sz.h >= RESIZE_MIN_H && sz.w <= 4000 && sz.h <= 4000;
  }

  function applySize() {
    if (!card) return;
    if (validSize(savedSize)) {
      // K3 #7：换了小屏幕/缩了窗口，记住的尺寸要钳在视口内，否则手柄跑到屏幕外没法拉回来
      const rect = card.getBoundingClientRect();
      const left = Number.isFinite(rect.left) ? rect.left : 0;
      const top = Number.isFinite(rect.top) ? rect.top : 0;
      const w = Math.max(RESIZE_MIN_W, Math.min(savedSize.w, window.innerWidth - left - 8));
      const h = Math.max(RESIZE_MIN_H, Math.min(savedSize.h, window.innerHeight - top - 8));
      card.style.width = w + 'px';
      card.style.height = h + 'px';
    } else {
      card.style.width = '';
      card.style.height = '';
    }
    applyPos();   // maxHeight 归 applyPos 管，两边保持一致
  }

  /**
   * 右下角手柄拖尺寸。与拖动位置同款：过程中直接改 inline 样式，松手才写 storage。
   * 下限保证卡片不会被拉到看不清；上限不超出视口。
   */
  function onResizeStart(e) {
    if (e.button !== 0 || !card) return;
    e.preventDefault();
    e.stopPropagation();          // 别让它冒泡成"点卡外/拖头部"
    const rect = card.getBoundingClientRect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const w0 = rect.width;
    const h0 = rect.height;
    card.classList.add('resizing');
    card.style.maxHeight = 'none';
    cancelHide();

    const move = (ev) => {
      const w = Math.min(Math.max(RESIZE_MIN_W, w0 + (ev.clientX - x0)), window.innerWidth - rect.left - 8);
      const h = Math.min(Math.max(RESIZE_MIN_H, h0 + (ev.clientY - y0)), window.innerHeight - rect.top - 8);
      card.style.width = Math.round(w) + 'px';
      card.style.height = Math.round(h) + 'px';
      savedSize = { w: Math.round(w), h: Math.round(h) };
    };
    const up = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      window.removeEventListener('blur', up);
      card.classList.remove('resizing');
      try { chrome.storage.local.set({ [SK.size]: savedSize }); } catch (_) { /* 忽略 */ }
    };
    listen(window, 'mousemove', move, true);
    listen(window, 'mouseup', up, true);
    listen(window, 'blur', up, { once: true });   // K3 #11：拖出浏览器窗口松手收不到 mouseup
  }

  function onHeaderDblClick(e) {
    if (e.target && e.target.closest && e.target.closest('button, a')) return;
    resetDock();
  }

  /** 清掉拖动记忆，回到默认停靠位（storage 里的 cardPos 一并删除）。 */
  function resetDock() {
    savedPos = null;
    savedSize = null;
    try { chrome.storage.local.remove([SK.pos, SK.size]); } catch (_) { /* 忽略 */ }
    applySize();   // 内部会调 applyPos，位置与尺寸一起归位
    toast(tr('docked'));
  }

  // ---------- 版本检测（v0.9.6，主人定：每 6 小时、默认开） ----------
  function localVersion() {
    try { return String(chrome.runtime.getManifest().version || '0'); } catch (_) { return '0'; }
  }

  /** 版本号比较：a<b 返回 -1。只认数字段，"v" 前缀与后缀（如 0.9.5.3）都容得下。 */
  function cmpVersion(a, b) {
    // 先砍掉 -beta / +build 后缀再比：GitHub 的 releases/latest 本来就不给预发布，但真手滚了
    // 一个 v0.9.8-beta.2，旧写法会把它切成 [0,9,8,2]，凭空多出一段就判成"比正式版新"。
    const seg = (v) => String(v).replace(/^v/i, '').split(/[-+]/)[0].split('.').map((x) => parseInt(x, 10) || 0);
    const pa = seg(a);
    const pb = seg(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  function checkUpdate() {
    if (disposed) return;
    if (!settings.updateCheck) { updateInfo = null; renderUpdateNotice(); return; }
    sendMsg({ type: 'version-check' }, (resp) => {
      if (!settings.updateCheck || !resp || !resp.ok || !resp.payload || !resp.payload.tag) return;
      const tag = resp.payload.tag;
      updateInfo = { tag, url: resp.payload.link || resp.payload.url || RELEASE_PAGE,
        gist: resp.payload.gist || '', newer: cmpVersion(localVersion(), tag) < 0 };
      renderUpdateNotice();
    });
  }

  const RELEASE_PAGE = 'https://github.com/mickeyhogen/fomo-helper/releases/latest';

  /** 有新版就在页尾左侧挂一行小字；没有就清掉。不弹窗、不挡内容。 */
  function renderUpdateNotice() {
    if (!els || !els.byfoot) return;
    const old = els.byfoot.querySelector('.upd');
    if (old) old.remove();
    if (!updateInfo || !updateInfo.newer) return;
    // 这个 href 来自发布说明正文（后台已只认 https 的 x.com/twitter.com 状态链接）。
    // 纵深防御：渲染前再验一次协议，后台哪天改松了也落不到 javascript:/data: 上。
    const safeUrl = /^https:\/\//i.test(String(updateInfo.url || '')) ? updateInfo.url : RELEASE_PAGE;
    const a = h('a', {
      cls: 'upd', text: tr('updateReady') + ' ' + updateInfo.tag + ' ↗',
      href: safeUrl,
      attrs: { target: '_blank', rel: 'noopener noreferrer' },
      title: (updateInfo.gist ? updateInfo.gist + '\n\n' : '') + tr('updateHint'),
    });
    els.byfoot.insertBefore(a, els.byfoot.firstChild);
  }

  // ---------- 诊断（v0.9.4：远程排查用，空态时才出现） ----------
  function buildDiag() {
    const d = {};
    try { d.ver = chrome.runtime.getManifest().version; } catch (_) { d.ver = '?'; }
    d.site = SITE.id;
    // v0.9.11：站点适配排查——悬停策略 + 页面上能认成代币的链接数（gmgn 左栏「追踪」行是不是链接，看这个数就知道）
    d.hover = SITE.hover === true ? 'fomo' : (SITE.hover || 'off');
    if (SITE.vueRoot) {
      d.vueProbe = TEST ? 'direct-test' : 'background-main';
      // 只有主世界测试夹具能直读 _vnode；真扩展的 isolated world 读不到是正常现象。
      if (TEST) { try { const r = document.querySelector(SITE.vueRoot); d.vueRoot = !!(r && r._vnode); } catch (_) { d.vueRoot = 'err'; } }
    }
    try { d.tokenAnchors = Array.from(document.querySelectorAll(SITE.tokenLinkSel)).filter((a) => anchorToken(a)).length; } catch (_) { d.tokenAnchors = -1; }
    // Gickey D6：page 只给路由模板；完整 CA 不进报告（token 字段已截断）
    d.page = location.pathname.replace(/0x[0-9a-fA-F]{6,}|[1-9A-HJ-NP-Za-km-z]{28,}/g, '…');
    d.token = urlToken ? (urlToken.chain + '/' + String(urlToken.ca).slice(0, 8) + '…') : 'none';
    d.viewport = window.innerWidth + 'x' + window.innerHeight;
    let bodyText = '';
    try { bodyText = document.body ? (document.body.innerText || '') : ''; } catch (_) {}
    d.pageText = bodyText.length;
    d.holdAnchors = (bodyText.match(SCRAPE_HOLD_G) || []).length;
    try { d.holderRows = collectHolderRows().length; } catch (_) { d.holderRows = -1; }
    // v0.9.10：持仓占比三件套——市值来源、fomo 持有人总数、当前算出的占比（远程排查"为什么没显示"）
    try { const mc = readMarketCap(); d.mc = mc ? (mc.src + ':' + Math.round(mc.usd)) : 'none'; } catch (_) { d.mc = 'err'; }
    try { d.fomoHolders = fomoHolderTotal(); } catch (_) { d.fomoHolders = null; }
    d.share = (state.holders && state.holders.share)
      ? (state.holders.share.pct + '%|' + state.holders.share.counted + '/' + state.holders.share.total + '|' + state.holders.share.tier)
      : ('none:' + (shareReject || '-'));
    try { d.thesisCol = !!findThesisColumn(); } catch (_) { d.thesisCol = null; }
    d.bottomTab = fomoBottomTab();
    d.friendsOnly = friendsOnlyActive();
    d.translated = pageTranslated();
    d.leftPanel = leftPanelHow;   // rect=认出左栏 / fallback=靠几何兜底 / error=防线挂了
    d.htmlClass = String(document.documentElement.className || '').slice(0, 40) || '-';
    d.pageLang = document.documentElement.lang || '-';   // fomo 自己的界面语言（Lingui 会写到 <html lang>）
    d.cjk = (bodyText.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    // 表区附近 100 字样本：锚点全没时，看一眼就知道文案变成了什么语言
    try {
      const i = bodyText.search(new RegExp(alt(L10N.holders) + '|' + alt(L10N.trader) + '|' + alt(L10N.position)));
      d.sample = (i >= 0 ? bodyText.slice(i, i + 100) : bodyText.slice(0, 100)).replace(/\s+/g, ' ');
    } catch (_) { d.sample = ''; }
    d.holders = state.holders && state.holders.status;
    d.thesis = state.thesis && state.thesis.status;
    d.lastScan = lastScanAt ? Math.round((Date.now() - lastScanAt) / 1000) + 's' : 'never';
    d.observer = scrapeObserver ? 'on' : 'off';
    d.lang = settings.lang;
    d.ua = (navigator.userAgent.match(/(Chrome|Edg|Brave)\/[\d.]+/) || [''])[0];
    return d;
  }

  function diagText(d) {
    return [
      'Fomo放大镜 diag v' + d.ver,
      'page=' + d.page + ' token=' + d.token + ' vp=' + d.viewport + ' ua=' + d.ua + ' lang=' + d.lang,
      'text=' + d.pageText + ' holdAnchors=' + d.holdAnchors
        + ' holderRows=' + d.holderRows + ' thesisCol=' + d.thesisCol,
      'bottomTab=' + d.bottomTab + ' friendsOnly=' + d.friendsOnly + ' translated=' + d.translated
        + ' html=' + d.htmlClass + ' pageLang=' + d.pageLang + ' cjk=' + d.cjk,
      'holders=' + d.holders + ' thesis=' + d.thesis + ' lastScan=' + d.lastScan + ' observer=' + d.observer,
      'sample=' + d.sample,
    ].join('\n');
  }

  function diagButton() {
    return h('button', {
      cls: 'diag-btn', text: tr('diag'), attrs: { type: 'button' }, title: tr('diagTitle'),
      on: { click: (e) => { e.stopPropagation(); showDiag(e.currentTarget); } },
    });
  }

  function showDiag(btn) {
    const d = buildDiag();
    const text = diagText(d);
    const parent = btn && btn.parentElement;
    if (parent) {
      const old = parent.querySelector('.diag');
      if (old) old.remove();
      const box = h('pre', { cls: 'diag', text: text });
      parent.insertBefore(box, btn.nextSibling);
    }
    try {
      navigator.clipboard.writeText(text).then(() => toast(tr('diagCopied')), () => toast(tr('diagShown')));
    } catch (_) { toast(tr('diagShown')); }
  }

  /**
   * 滚动救援（v0.9.4）：观察者 25s 后撤了，用户这时才把 Holders 表滚出来 → 没人重扫。
   * 空态期间监听一下滚动（捕获阶段，fomo 的滚动容器不是 window），节流 1.5s。
   */
  function onScrollMaybeRescan() {
    if (!state.open || !state.ca) return;
    const hEmpty = state.holders && state.holders.status === 'empty';
    const tEmpty = state.thesis && state.thesis.status === 'empty';
    if (!hEmpty && !tEmpty) return;
    // K3 #4：这些空态是"稳定且正确"的，再扫也不会变——别每 1.5s 全页走一遍
    const st = state.thesis || {};
    if (st.holdersPresent === true) return;                 // 表在、只是没人写 thesis
    if (st.friendsOnly === true || (state.holders && state.holders.friendsOnly === true)) return;
    if (st.bottomTab && st.bottomTab !== 'holders') return; // 表被别的标签顶掉，滚动救不了（点标签走 #3）
    // Gickey D2：观察器还活着就交给它（DOM 一变它会扫）；只有它退场后才由滚动兜底，
    // 且只做一次单扫（trailing debounce 600ms），不重启整套 watcher——否则 25s 退场被无限顺延。
    if (scrapeObserver) return;
    if (scrollRescanTimer) clearTimeout(scrollRescanTimer);
    scrollRescanTimer = setTimeout(() => {
      scrollRescanTimer = null;
      if (!state.open || !state.ca) return;
      try { scanScrapers(state.seq, state.ca, state.chain); } catch (_) { /* 忽略 */ }
    }, 600);
  }
  let scrollRescanTimer = null;

  // ---------- 交互 ----------
  function copyCa() {
    if (!state.ca) return;
    try {
      navigator.clipboard.writeText(state.ca).then(() => toast(tr('copied')), () => {});
    } catch (_) { /* 忽略 */ }
  }

  function toast(msg) {
    if (!shadow) return;
    const t = h('div', { cls: 'toast', text: msg });
    shadow.appendChild(t);
    setTimeout(() => { try { shadow.removeChild(t); } catch (_) {} }, 1600);
  }

  function toggleLang() {
    const next = settings.lang === 'en' ? 'zh' : 'en';
    persistLang(next);
    applyLangChange();
    // v0.7.3：这个 中/EN 钮是唯一的翻译开关。切到「中」这一下点击 = Chrome 要的
    // 那个用户手势——若语言包还没就绪，就在这一下触发下载并翻译；成功后落盘
    // translatorReady，以后每张卡自动翻，无需再点。切「EN」= 显示原文。
    if (next !== 'en') translation.enableFromGesture();
  }

  /** 中英切换后：DeBot 换语言版本，thesis/推文段按新语言决定要不要自动翻。 */
  /** 卡片壳上的静态文案（标签/按钮提示/预览角标）：建卡时设置可能还没到，每次 paintChrome 都刷一遍。 */
  function paintStaticI18n() {
    if (!els) return;
    for (const b of els.tabBtns) {
      const lb = b.querySelector('.tlabel');
      if (lb) lb.textContent = tr({ narrative: 'tabMeta', views: 'tabThesis', holders: 'tabHolders' }[b.dataset.tab]);
    }
    els.caBtn.setAttribute('title', tr('copyCa'));
    els.pinBtn.setAttribute('title', tr('pin'));
    els.langBtn.setAttribute('title', tr('langBtn'));
    els.refreshBtn.setAttribute('title', tr('refresh'));
    els.closeBtn.setAttribute('title', tr('close'));
    els.hdr.setAttribute('title', tr('dragHint'));
    els.langBusy.textContent = tr('trBusy');
    els.pvChip.textContent = tr('preview');
    if (grip) grip.setAttribute('title', tr('resizeHint'));
    if (els.displayBtn) els.displayBtn.setAttribute('title', tr('displayBtn'));
    if (launcher) {
      launcher.setAttribute('aria-label', tr('launcher'));
      launcher.querySelector('strong').textContent = tr('launcher');
      launcher.querySelector('small').textContent = tr('launcherHint');
      if (!launcher.hidden) applyLauncherPos();
    }
  }

  function applyLangChange() {
    // v0.9：UI 壳随语言整体重绘（标签文案/段标题/灰字/按钮提示），正文段各自重画
    paintStaticI18n();
    translation.langChanged();
    paintHeader();
    renderPairs();
    renderDebot();
    renderAnalysis();
    renderThesis();
    renderKol();
    renderTweets();
  }


  function onLauncherClick(e) {
    // Touch taps activate on pointerup; ignore the optional compatibility click.
    if (e.pointerType === 'touch') return;
    if (launcherWasDragged && e.detail !== 0) { launcherWasDragged = false; return; }
    launcherWasDragged = false;
    const current = parsePath(location.pathname);
    if (current) { urlToken = current; openFromUrl(current); }
    else if (lastClosedToken) openToken(lastClosedToken, 'manual');
    else toast(tr('notToken'));
    // An explicit click should reveal immediately, even while a route or data is loading.
    if (state.open) { clearReveal(); showCardNow(); rescanNow(true); }
  }

  /** 手动位置优先；未拖过时留在刚关闭的卡片处，完整钳在视口内。 */
  function applyLauncherPos() {
    if (!launcher) return;
    const width = launcher.offsetWidth || 116, height = launcher.offsetHeight || 40;
    const maxL = Math.max(8, window.innerWidth - width - 8);
    const maxT = Math.max(8, window.innerHeight - height - 8);
    const pos = launcherPos || (launcherAnchor && {
      left: launcherAnchor.right - width, top: launcherAnchor.centerY - height / 2,
    });
    if (!pos) {
      launcher.style.left = ''; launcher.style.top = Math.min(maxT, Math.max(8, Math.round(innerHeight * .44))) + 'px';
      launcher.style.right = '12px'; launcher.style.bottom = 'auto';
    } else {
      pos.left = Math.min(Math.max(8, pos.left), maxL);
      pos.top = Math.min(Math.max(8, pos.top), maxT);
      launcher.style.left = pos.left + 'px';
      launcher.style.top = pos.top + 'px';
      launcher.style.right = 'auto';
      launcher.style.bottom = 'auto';
    }
    launcher.classList.remove('tip-right', 'tip-below');
    const tipWidth = launcher.querySelector('.launcher-tip').offsetWidth || 240;
    const left = launcher.getBoundingClientRect().left;
    const fitsLeft = left >= tipWidth + 12;
    const fitsRight = innerWidth - left - width >= tipWidth + 12;
    launcher.classList.toggle('tip-right', !fitsLeft && fitsRight);
    launcher.classList.toggle('tip-below', !fitsLeft && !fitsRight);
  }

  function onLauncherDragStart(e) {
    if (e.button !== 0 || !e.isPrimary || !launcher) return;
    launcherWasDragged = false;
    const rect = launcher.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY, left0 = rect.left, top0 = rect.top;
    let moved = false;
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 4) moved = true;
      if (!moved) return;
      launcher.classList.add('dragging');
      launcherPos = {
        left: left0 + ev.clientX - x0,
        top: top0 + ev.clientY - y0,
      };
      applyLauncherPos();
    };
    const up = (ev) => {
      if (ev.pointerId !== undefined && ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', up);
      launcher.classList.remove('dragging');
      launcherWasDragged = moved && ev.type === 'pointerup';
      if (moved) { try { chrome.storage.local.set({ [SK.launcher]: launcherPos }); } catch (_) { /* 忽略 */ } }
      if (!moved && e.pointerType === 'touch' && ev.type === 'pointerup') onLauncherClick({ detail: 0 });
    };
    listen(window, 'pointermove', move, true);
    listen(window, 'pointerup', up, true);
    listen(window, 'pointercancel', up, true);
    listen(window, 'blur', up, { once: true });
    // Pointer capture keeps a touch drag attached to the small control.
    try { launcher.setPointerCapture(e.pointerId); } catch (_) { /* Detached pointer. */ }
  }

  /** 应用亮度/透明度到卡片，并把滑块 UI 同步到当前值。 */
  function applyDisplayAppearance() {
    if (card) {
      card.style.filter = displayBrightness === 100 ? '' : 'brightness(' + displayBrightness + '%)';
      card.style.opacity = displayOpacity === 100 ? '' : String(displayOpacity / 100);
    }
    if (els && els.brightnessInput) {
      els.brightnessInput.value = String(displayBrightness);
      els.opacityInput.value = String(displayOpacity);
      els.brightnessVal.textContent = displayBrightness + '%';
      els.opacityVal.textContent = displayOpacity + '%';
    }
  }

  function updateDisplayAppearance(brightness, opacity) {
    displayBrightness = Math.min(150, Math.max(50, Number(brightness) || 100));
    displayOpacity = Math.min(100, Math.max(35, Number(opacity) || 100));
    applyDisplayAppearance();
    persistDisplayAppearance();
  }

  /** 拖一次滑块能打出几十个 input 事件；视觉即时生效，落盘攒 200ms 再写一次。 */
  let displayPersistTimer = null;
  function persistDisplayAppearance() {
    if (displayPersistTimer) clearTimeout(displayPersistTimer);
    displayPersistTimer = setTimeout(() => {
      displayPersistTimer = null;
      try { chrome.storage.local.set({ displayBrightness, displayOpacity }); } catch (_) { /* 忽略 */ }
    }, 200);
  }

  function closeCard() {
    // Capture before hiding: the first reopen entry stays under the close gesture.
    // Repeated closes follow the card until the owner explicitly drags the entry.
    if (card && !card.hidden && !launcherPos && els) {
      const r = els.closeBtn.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) launcherAnchor = { right: r.right, centerY: r.top + r.height / 2 };
    }
    if (state.ca) lastClosedToken = { ca: state.srcAddr || state.ca, chain: state.chain };
    cancelStoryRetry();
    cancelHoverDwell();
    resolveSeq.url++;
    resolveSeq.preview++;
    state.seq++;
    state.open = false;
    state.pinned = false;
    state.ca = null;
    previewRow = null;
    cancelHide();
    clearReveal();
    stopScrapers();
    if (card) card.hidden = true;
    if (launcher) {
      launcher.hidden = false;
      launcher.setAttribute('aria-expanded', 'false');
      launcher.classList.add('just-closed');
      applyLauncherPos();
    }
  }

  function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(() => {
      if (state.mode !== 'preview' || state.pinned) return;
      previewRow = null;
      // 预览退场：URL 本身是代币页且开着自动弹出时，回到该币的卡片，而不是整卡消失
      if (urlToken && autoOpenEnabled()) openFromUrl(urlToken);
      else closeCard();
    }, HOVER_HIDE_MS);
  }

  function cancelHide() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  function cancelHoverDwell() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    hoverProbeSeq++;
    hoverPendingRow = null;
    hoverPendingCa = null;
    hoverPendingChain = null;
    hoverPendingTarget = null;
    hoverPendingX = 0;
    hoverPendingY = 0;
  }

  // ---------- 载入 + 渲染 ----------
  const mirrorText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  /** 后台只会回 fomo content script 生成的最小快照；前台仍做一次字段/长度收口。 */
  function normalizeMirrorHolder(row) {
    if (!row || typeof row !== 'object') return null;
    const out = {
      handle: mirrorText(row.handle, 32), positionUsd: mirrorText(row.positionUsd, 32),
      avgEntry: mirrorText(row.avgEntry, 32), pnl: mirrorText(row.pnl, 32),
      pnlPos: row.pnlPos === true ? true : (row.pnlPos === false ? false : null),
      avgHold: mirrorText(row.avgHold, 40),
    };
    return out.positionUsd || out.pnl ? out : null;
  }

  function normalizeMirrorThesis(row) {
    if (!row || typeof row !== 'object') return null;
    const text = mirrorText(row.text, 4000);
    if (!text) return null;
    const likes = Math.max(0, Math.min(1000000, Number(row.likes) || 0));
    const age = row.ageMin == null ? NaN : Number(row.ageMin);
    return {
      handle: mirrorText(row.handle, 32), symbol: '', text,
      url: safeHttps(row.url) || '', likes: Math.floor(likes),
      time: mirrorText(row.time, 40), ageMin: Number.isFinite(age) && age >= 0 ? age : null,
      positionUsd: mirrorText(row.positionUsd, 32), pnl: mirrorText(row.pnl, 32),
      pnlPos: row.pnlPos === true ? true : (row.pnlPos === false ? false : null),
    };
  }

  function normalizeMirrorShare(sh) {
    const clean = snapshotFomoShare(sh);
    if (!clean) return null;
    // Fomo uses the unrounded ratio for stars, then rounds only the displayed percentage.
    const pct = clean.sumUsd / clean.mcUsd * 100;
    return {
      ...clean,
      tier: pct >= SHARE_STRONG_PCT ? 'strong' : (pct >= SHARE_BUY_PCT ? 'buy' : 'low'),
    };
  }

  /** 只接受后台构造的 fomo token 链接；登录 CTA 不允许被变成任意外链。 */
  function safeFomoPayloadUrl(raw, tokenOnly) {
    try {
      const u = new URL(String(raw || ''));
      if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'fomo.family') return '';
      if (tokenOnly && !/^\/tokens\/[a-z0-9_-]+\/[A-Za-z0-9]{20,64}\/?$/i.test(u.pathname)) return '';
      return u.href;
    } catch (_) { return ''; }
  }

  function applyFomoMirrorResponse(seq, resp) {
    if (seq !== state.seq) return;
    const fomoUrl = safeFomoPayloadUrl(resp && (resp.fomoUrl || (resp.payload && resp.payload.fomoUrl)), true);
    if (resp && resp.ok && resp.payload && typeof resp.payload === 'object') {
      const holders = (Array.isArray(resp.payload.holders) ? resp.payload.holders : [])
        .slice(0, HOLDER_SHOW).map(normalizeMirrorHolder).filter(Boolean);
      const thesis = (Array.isArray(resp.payload.thesis) ? resp.payload.thesis : [])
        .slice(0, THESIS_TAB_SHOW).map(normalizeMirrorThesis).filter(Boolean);
      const total = resp.payload.thesisTotal;
      const totalCount = Number.isSafeInteger(total) && total >= thesis.length && total <= 1000000
        ? total : thesis.length;
      const feed = (Array.isArray(resp.payload.feed) ? resp.payload.feed : [])
        .slice(0, 60).map(normalizeMirrorThesis).filter(Boolean);
      const share = normalizeMirrorShare(resp.payload.share);
      state.holders = holders.length
        ? { status: 'ready', data: holders, error: null, share, source: 'fomo-mirror', fomoUrl }
        : { status: 'empty', data: null, error: null, share: null, source: 'fomo-mirror', fomoUrl };
      state.thesis = thesis.length
        ? { status: 'ready', data: thesis, totalCount, error: null, holdersPresent: holders.length > 0, feed, source: 'fomo-mirror', fomoUrl }
        : { status: 'empty', data: null, error: null, holdersPresent: holders.length > 0, feed, source: 'fomo-mirror', fomoUrl };
    } else {
      const kind = resp && resp.kind === 'auth_required' ? 'auth_required' : 'unavailable';
      state.holders = { status: kind, data: null, error: null, source: 'fomo-mirror', fomoUrl };
      state.thesis = { status: kind, data: null, error: null, source: 'fomo-mirror', fomoUrl };
    }
    renderKol();
    renderThesis();
  }

  /**
   * 四个源并行发车，各自到达各自渲染。
   * 关键纪律：自配分析源(2.5s 硬超时)与 fomo 取数都不得延后 DeBot 段的显示。
   */
  function load(ca, chain, mode, force, resolving = false) {
    if (disposed) return;
    cancelStoryRetry();
    ensureUi();
    cancelHide();
    state.ca = ca;
    state.chain = chain || null;
    state.mode = mode;
    if (mode === 'url') state.pinned = false;
    // 精简布局：悬停预览恒精简；否则看 openMode（compact 精简，full/off 手动开都全展开）。
    // v0.8 起精简只管叙事页内部（传播/开发者/来源推文的默认展开态）；
    // 观点/持仓者各占一个标签页，不再有段级折叠。
    state.compact = (mode === 'preview') || settings.openMode === 'compact';
    state.tab = 'narrative';   // 每次开卡/换币都回到默认「叙事」页
    state.tweetsOpen = !state.compact;
    state.open = true;
    state.status = 'loading';
    state.resolving = resolving;
    state.history = null;
    state.error = null;
    state.errorKind = null;
    const analysisOn = nonEmpty(settings.analysisTemplate);
    state.analysis = { status: analysisOn ? 'loading' : 'disabled', data: null, error: null };
    state.holders = { status: 'scanning', data: null, error: null };
    state.thesis = { status: 'scanning', data: null, error: null };
    state.scrapeFp = { holders: '', thesis: '' };   // 换币必重画，指纹清零
    state.pairs = { status: 'loading', data: null, error: null };
    state.tweets = { status: 'idle', data: null, error: null };
    const seq = ++state.seq;

    // 卡片已经在屏幕上（换币）或是悬停预览（页面显然早就加载好了）→ 立刻显示；
    // 只有"自动弹出的第一次现身"才等页面渲染，免得弹在一片黑上。
    const wasVisible = !card.hidden;
    if (wasVisible || mode === 'preview') {
      clearReveal();
      showCardNow();
    } else {
      revealWhenPageReady(seq);
    }
    translation.reset();
    if (translation.cache.size > 800) translation.cache.clear();   // K3 F3：跨代币缓存封顶

    paintChrome();
    paintHeader();
    renderPairs();
    renderDebot();
    renderThesis();
    renderAnalysis();
    renderKol();
    renderTweets();

    // Render while resolving a pool, before any token-specific data request.
    if (resolving) return;

    // 0) 池子交易对（DexScreener 公开只读；失败静默，头部就是没有 chips 而已）
    requestPairs(ca, chain, force, (resp) => {
      if (seq !== state.seq) return;
      state.pairs = (resp && resp.ok && Array.isArray(resp.payload))
        ? { status: 'ready', data: resp.payload, error: null }
        : { status: 'error', data: null, error: null };
      renderPairs();
    });

    // 1) DeBot 叙事（主体）
    loadNarrative(seq, ca, chain, force);

    // 2) 自定义分析源（可选；失败即降级成一行灰字，绝不拖累其它段）
    if (analysisOn) {
      requestAnalysis(ca, force, (resp) => {
        if (seq !== state.seq) return;
        if (resp && resp.ok) {
          state.analysis = { status: 'ready', data: resp.payload, error: null };
        } else {
          const kind = (resp && resp.kind) || 'network';
          state.analysis = {
            status: (kind === 'absent' || kind === 'disabled') ? kind : 'error',
            data: null,
            error: null,      // 原始错误串到此为止，不进 DOM
            kind,             // 只用来在固定文案里二选一
          };
        }
        paintHeader();
        renderAnalysis();
      });
    }

    // 3) fomo 当前页直接扫 DOM；xxyy 从临时 fomo 页取同样的最小快照。
    if (SITE.scrape) startScrapers(seq, ca, chain);
    else if (SITE.fomoMirror) {
      requestFomoTokenData(ca, chain, force, (resp) => applyFomoMirrorResponse(seq, resp));
    }
  }

  function cancelStoryRetry() {
    storyAttempt++;
    if (storyRetryTimer) clearTimeout(storyRetryTimer);
    storyRetryTimer = null;
  }

  function loadNarrative(seq, ca, chain, force, retries = 1) {
    const attempt = ++storyAttempt;
    requestStory(ca, force, resp => {
      if (disposed || !state.open || seq !== state.seq || attempt !== storyAttempt) return;
      const kind = (resp && resp.kind) || 'network';
      if ((!resp || !resp.ok) && retries > 0 && ['network', 'connection', 'message_timeout'].includes(kind)) {
        state.status = 'loading';
        renderDebot();
        const text = els.slotDebot.querySelector('.state');
        if (text) text.textContent = tr('reconnecting');
        storyRetryTimer = setTimeout(() => {
          storyRetryTimer = null;
          if (seq === state.seq && attempt === storyAttempt && state.open) loadNarrative(seq, ca, chain, true, retries - 1);
        }, 1000);
        return;
      }
      state.status = resp && resp.ok ? 'ready' : (kind === 'nostory' ? 'nostory' : 'error');
      state.history = resp && resp.ok ? resp.payload : null;
      state.error = null;
      state.errorKind = resp && resp.ok ? null : kind;
      paintChrome(); paintHeader(); renderDebot();
      loadTweets(seq, force);
      scanScrapers(seq, ca, chain);
    });
  }

  function retryNarrative() {
    if (!state.ca || !state.open || state.status === 'loading') return;
    cancelStoryRetry();
    state.status = 'loading'; state.errorKind = null;
    paintHeader(); renderDebot();
    loadNarrative(state.seq, state.ca, state.chain, true);
  }

  /** DeBot 的 source_tweets 到手后才能取推文正文。 */
  function loadTweets(seq, force) {
    const hist = state.history;
    const ids = hist && Array.isArray(hist.source_tweets)
      ? hist.source_tweets.filter((x) => typeof x === 'string').slice(0, 3) : [];
    if (!ids.length) {
      state.tweets = { status: 'empty', data: null, error: null };
      renderTweets();
      return;
    }
    state.tweets = { status: 'loading', data: null, error: null };
    renderTweets();
    requestTweets(ids, force, (resp) => {
      if (seq !== state.seq) return;
      const list = (resp && resp.ok && Array.isArray(resp.payload)) ? resp.payload : [];
      state.tweets = { status: list.length ? 'ready' : 'error', data: list, error: null };
      renderTweets();
    });
  }

  /** 头部/边框等与数据无关的外观。 */
  function paintChrome() {
    if (!card) return;
    const preview = state.mode === 'preview' && !state.pinned;
    card.classList.toggle('preview', preview);
    els.pvChip.hidden = !preview;
    els.pinBtn.hidden = !preview;
    els.caBtn.hidden = !state.ca;   // 没有地址就没什么可复制的
    paintStaticI18n();
    paintTabs();
  }

  // ---------- v0.8 标签页 ----------
  /** 当前标签高亮 + 只显示对应 pane。数据渲染不经过这里——五个 slot 永远都在填。 */
  function paintTabs() {
    if (!els) return;
    for (const b of els.tabBtns) b.classList.toggle('on', b.dataset.tab === state.tab);
    els.paneNarrative.hidden = state.tab !== 'narrative';
    els.paneViews.hidden = state.tab !== 'views';
    els.paneHolders.hidden = state.tab !== 'holders';
  }

  function switchTab(key) {
    if (state.tab === key) return;
    state.tab = key;
    paintTabs();
    if (els && els.body) els.body.scrollTop = 0;
    // 切到 观点/持仓者 且那页还没抓到数据时才顺手重扫（Holders 表往往是主人此刻才滚出来的）；
    // 已有数据的切换纯属阅读，不为它做全页扫描/强制 layout（K3 审查建议）。
    if (key !== 'narrative') {
      const st = key === 'views' ? state.thesis : state.holders;
      const feedMissing = key === 'views' && state.thesisSort === 'time'
        && !(st && Array.isArray(st.feed) && st.feed.length);
      if (!st || st.status !== 'ready' || feedMissing) rescanNow();
    }
  }

  // ---------- v0.8.3 池子交易对 chips ----------
  const PAIR_SHOW = 4;   // 头部最多摆几个报价资产 chip，其余收进 +N 与 tooltip

  function fmtUsd(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
    return '$' + Math.round(v);
  }

  // 主流报价资产（主池）：每只币都有，不占 chip 位（主人 2026-09-02：只要 $TSLA 这类副池）。
  // 全量池子仍留在 tooltip 里做参考。
  const PAIR_STD_QUOTES = ['ETH', 'WETH', 'USDG', 'USDC', 'USDT', 'DAI', 'WBTC', 'BTC'];

  /** 类型 chip 右侧：这只币的**副池**交易对（剔除 ETH/稳定币主池，按流动性排序）。 */
  function renderPairs() {
    if (!els) return;
    const wrap = els.pairsWrap;
    wrap.textContent = '';
    const rows = (state.pairs.status === 'ready' && Array.isArray(state.pairs.data))
      ? state.pairs.data : [];
    const syms = [];
    for (const r of rows) {
      let sym = String((r && r.quote) || '').trim().toUpperCase().replace(/^\$+/, '');
      if (!sym || sym.length > 12) continue;
      if (sym === 'WETH') sym = 'ETH';
      if (PAIR_STD_QUOTES.indexOf(sym) !== -1) continue;   // 主池不占位
      if (syms.indexOf(sym) === -1) syms.push(sym);
    }
    const show = syms.slice(0, PAIR_SHOW);
    wrap.hidden = !show.length;
    if (!show.length) return;
    // 起源段不存在时（没叙事/读取失败）chips 会没爹——兜底挂到 Meta 页顶部一行
    if (!wrap.isConnected && els.slotDebot) {
      let solo = els.slotDebot.querySelector('.pairs-solo');
      if (!solo) {
        solo = h('div', { cls: 'pairs-solo' });
        els.slotDebot.insertBefore(solo, els.slotDebot.firstChild);
      }
      solo.appendChild(wrap);
    }
    for (const s of show) wrap.appendChild(h('span', { cls: 'pairchip', text: '$' + s }));
    if (syms.length > show.length) {
      wrap.appendChild(h('span', { cls: 'pairchip more', text: '+' + (syms.length - show.length) }));
    }
    wrap.setAttribute('title', tr('pairsTitle') + '\n' + rows.slice(0, 8)
      .map((r) => '$' + String((r && r.quote) || '?').toUpperCase()
        + ' · ' + ((r && r.dex) || '?') + ' · ' + fmtUsd(r && r.liqUsd)).join('\n'));
  }

  /** 观点/持仓者 标签上的条数角标；null/0 = 不显示。 */
  function setTabCount(key, n) {
    if (!els) return;
    for (const b of els.tabBtns) {
      if (b.dataset.tab !== key) continue;
      const c = b.querySelector('.tcount');
      if (c) c.textContent = n ? String(n) : '';
    }
  }

  /**
   * 中/EN 钮该不该露：DeBot 有中英两版可切，或有可翻译的 thesis/推文正文
   *（且浏览器有本地翻译能力）。任一成立即露出——它是唯一的翻译开关。
   */
  function langBtnShouldShow() {
    const hist = state.history;
    const hasZh = !!(hist && hist.story && Object.keys(hist.story).length);
    const hasEn = !!(hist && hist.story_en && Object.keys(hist.story_en).length);
    if (hasZh && hasEn) return true;
    if (translation.probeSync() === 'absent') return false;
    return translation.segs.some((s) => worthTranslating(s.original));
  }

  /** thesis/推文渲染后 segs 才齐，回来校准一次中/EN 钮的可见性。 */
  function refreshLangBtn() {
    if (els && els.langBtn) els.langBtn.hidden = !langBtnShouldShow();
  }

  /**
   * 头部只依赖"任意已到达的源"：DeBot 有名字用 DeBot 的，
   * DeBot 挂了但分析源有文档，就用文档里的 symbol，别让头部空着。
   */
  function paintHeader() {
    if (!els) return;
    const hist = state.history;
    const dos = state.analysis.data;
    const lang = settings.lang === 'en' ? 'en' : 'zh';
    const story = hist ? pickStory(hist, lang) : null;

    let name = '';
    if (hist && nonEmpty(hist.name)) name = hist.name;
    else if (story && nonEmpty(story.project_name)) name = story.project_name;
    else if (dos && nonEmpty(dos.symbol)) name = dos.symbol;
    else if (state.status === 'loading') name = tr('loadingName');
    else if (state.status === 'nostory') name = tr('nostoryName');
    else if (state.status === 'error') name = tr('errorName');
    els.name.textContent = name || shortCa(state.ca);

    // v0.7.3：中/EN 钮既切 DeBot 双语版本，又是唯一的翻译开关。所以它在
    // 「DeBot 有中英两版」或「有可翻译的 thesis/推文正文（且浏览器能翻）」任一成立时都要露出，
    // 否则单语代币会连翻译入口都没有。segs 在 thesis/推文渲染后才齐，那两处会再校准一次。
    els.langBtn.hidden = !langBtnShouldShow();
    els.langZh.className = lang === 'en' ? 'lg' : 'lg on';
    els.langEn.className = lang === 'en' ? 'lg on' : 'lg';

    const score = story ? Math.round(Number(story.rating && story.rating.score)) : NaN;
    els.stars.textContent = '';
    if (personalMode() && isFinite(score) && score > 0) {
      for (let i = 1; i <= 5; i++) {
        els.stars.appendChild(h('span', {
          cls: i <= score ? 'star on' : 'star', text: i <= score ? '★' : '☆',
        }));
      }
    }
    // 星级只在个人模式出现；没有星就整行收掉，不留空白
    els.starRow.hidden = !els.stars.childNodes.length;

    // v0.8.6：叙事类型不再占头部空间，悬停名字可见
    try {
      els.name.title = (story && nonEmpty(story.narrative_type)) ? story.narrative_type.trim() : '';
    } catch (_) { /* 忽略 */ }
  }

  function pickStory(hist, lang) {
    const order = lang === 'en'
      ? ['story_en', 'story', 'story_ja']
      : ['story', 'story_en', 'story_ja'];
    for (const k of order) {
      const s = hist && hist[k];
      if (s && typeof s === 'object' && Object.keys(s).length) return s;
    }
    return null;
  }

  /** {text, ref} → 一行；空文本返回 null。 */
  function fieldNode(label, obj) {
    if (!obj || typeof obj !== 'object' || !hasContent(obj.text)) return null;
    const row = h('div', { cls: 'item' });
    if (label) row.appendChild(h('span', { cls: 'lbl', text: label }));
    row.appendChild(h('span', { cls: 'txt', text: obj.text.trim() }));
    const ref = safeHttps(obj.ref);
    if (ref) {
      row.appendChild(h('a', {
        cls: 'ref', text: tr('source'), href: ref, title: ref,
        attrs: { target: '_blank', rel: 'noopener noreferrer' },
      }));
    }
    return row;
  }

  /**
   * v0.6：DeBot 段内容一条不少，但默认展开状态分层——
   * 结论先露出（评级理由/起源默认展开），细节收起（传播/开发者点开即看）。
   */
  function sectionNode(title, kids, cls, collapsed, rightNode) {
    const real = (kids || []).filter(Boolean);
    if (!real.length) return null;
    const attrs = collapsed ? {} : { open: '' };
    // v0.9.6：rightNode 挂在 summary 右端（副池 chips 从拥挤的头部挪到「起源」这一行）
    const sum = rightNode
      ? h('summary', {}, [h('span', { cls: 'sum-t', text: title }), h('span', { cls: 'sum-sp' }), rightNode])
      : h('summary', { text: title });
    const d = h('details', { cls: cls || '', attrs }, [sum].concat(real));
    return d;
  }

  // （v0.8：原 makeCollapsible 可折叠段随标签页化移除——观点/持仓者各占一个 tab，
  //   不再需要段级折叠。）

  /** DeBot 叙事段：v0.1 的完整渲染原样保留，只是改写进自己的 slot。 */
  function renderDebot() {
    if (!els) return;
    const body = els.slotDebot;
    const tail = els.slotDebotTail;
    tail.textContent = '';
    if (renderUnresolvedPool(body)) return;

    if (state.status === 'loading') {
      body.textContent = '';
      body.appendChild(h('div', { cls: 'state' }, [
        h('div', { cls: 'spin' }),
        h('span', { text: tr(state.resolving ? 'resolvingToken' : 'loadingStory') }),
      ]));
      return;
    }
    if (state.status === 'nostory') return renderEmptyState();
    if (state.status === 'error') return renderErrorState();

    const hist = state.history || {};
    const lang = settings.lang === 'en' ? 'en' : 'zh';
    const story = pickStory(hist, lang);
    if (!story) return renderEmptyState();

    // --- 正文（v0.8.9 拆两截：起源/评级理由在推文上方，传播/开发者在推文下方）---
    body.textContent = '';
    const add = (node) => { if (node) body.appendChild(node); };
    const addTail = (node) => { if (node) tail.appendChild(node); };

    // v0.7 阅读顺序（主人定）：起源 → 评级理由 → 传播 → 开发者。
    // 先回答"这币是什么"，再给"该怎么看它"，最后才是可选的细节。

    // 起源（默认展开）
    const bg = story.background || {};
    add(sectionNode(tr('secOrigin'), [fieldNode('', bg.origin)], '', false, els.pairsWrap));

    // 评级理由（默认展开）。位置排在起源之后，但仍保留蓝色高亮框——
    // 它是全段唯一的"判断"，视觉权重不能因为排第二就掉下去。
    // 被个人模式挡住的只有头部那排星星——分数是主观的，理由不是。
    const rating = story.rating || {};
    if (hasContent(rating.reason)) {
      add(sectionNode(tr('secRating'),
        [h('div', { cls: 'txt', text: rating.reason.trim() })], 'rating'));
    }

    // 传播（六项全是占位词时，sectionNode 会让整段消失）。
    // 精简布局默认收起；full 布局跟着"全部展开"一起摊开。
    const dist = story.distribution || {};
    addTail(sectionNode(tr('secSpread'), [
      fieldNode(tr('fCeleb'), dist.celebrity_support),
      fieldNode(tr('fViews'), dist.max_views),
      fieldNode(tr('fLikes'), dist.max_likes),
      fieldNode(tr('fComments'), dist.max_comments),
      fieldNode(tr('fCommunity'), dist.community_participation),
      fieldNode(tr('fNegative'), dist.negative_incidents),
    ], '', state.compact));

    // 开发者：只有命中风险/强信号关键词的文字行才占版面；两行都不命中 → 整段不出现。
    // （v0.5 起不再显示 fomo 开发者战绩——那需要被 CF 挡掉的 API，开源版拿不到。）
    const dev = story.developer_info || {};
    addTail(sectionNode(tr('secDev'), [
      devWorthShowing(dev.identity && dev.identity.text) ? fieldNode(tr('fIdentity'), dev.identity) : null,
      devWorthShowing(dev.address_analysis && dev.address_analysis.text)
        ? fieldNode(tr('fAddress'), dev.address_analysis) : null,
    ], '', state.compact));

    if (!body.childNodes.length && !tail.childNodes.length) {
      body.appendChild(h('div', { cls: 'state' },
        [h('span', { text: tr('emptyStory') })]));
    }
  }

  function renderEmptyState() {
    els.slotDebot.textContent = '';
    els.slotDebotTail.textContent = '';
    els.slotDebot.appendChild(h('div', { cls: 'state' }, [
      h('span', { cls: 'em', text: tr('nostory') }),
      h('a', {
        cls: 'ref', text: tr('openDebot'), href: debotUrl(state.chain, state.ca),
        attrs: { target: '_blank', rel: 'noopener noreferrer' },
      }),
    ]));
  }

  function renderErrorState() {
    const invalid = state.errorKind === 'context_invalidated';
    els.slotDebot.textContent = '';
    els.slotDebotTail.textContent = '';
    els.slotDebot.appendChild(h('div', { cls: 'state' }, [
      h('span', { cls: 'em', text: invalid ? tr('contextLost') : FRIENDLY.debot }),
      h('button', {
        cls: 'btn', text: tr(invalid ? 'reloadPage' : 'retry'), attrs: { type: 'button' },
        on: { click: () => { if (invalid) location.reload(); else retryNarrative(); } },
      }),
    ]));
  }

  // ---------- 文本工具：链接化 + 翻译登记 ----------
  /**
   * 把正文里的 https:// 链接变成可点锚点，其余片段包成 .tseg 供翻译替换。
   * 全程 textContent，绝不 innerHTML —— v0.1 的安全不变式在这里同样成立。
   */
  function linkifyInto(parent, text, register) {
    const str = String(text == null ? '' : text);
    URL_IN_TEXT_RE.lastIndex = 0;
    let last = 0;
    let m;
    while ((m = URL_IN_TEXT_RE.exec(str)) !== null) {
      if (m.index > last) addSeg(parent, str.slice(last, m.index), register);
      const url = m[0];
      parent.appendChild(h('a', {
        text: url, href: url, title: url,
        attrs: { target: '_blank', rel: 'noopener noreferrer' },
      }));
      last = m.index + url.length;
      if (URL_IN_TEXT_RE.lastIndex === m.index) URL_IN_TEXT_RE.lastIndex++; // 防零宽死循环
    }
    if (last < str.length) addSeg(parent, str.slice(last), register);
  }

  function addSeg(parent, text, register) {
    const span = h('span', { cls: 'tseg', text });
    parent.appendChild(span);
    if (register) translation.register(span, text);
  }

  function cjkRatio(str) {
    const t = String(str || '');
    if (!t.length) return 1;
    const m = t.match(/[㐀-鿿豈-﫿぀-ヿ]/g);
    return m ? m.length / t.length : 0;
  }

  /** 已经基本是中日文的段落不翻，省得把中文再"翻"一遍。 */
  const worthTranslating = (str) => String(str || '').trim().length > 1 && cjkRatio(str) < 0.2;

  // ---------- Chrome 内置本地翻译 ----------
  //
  // v0.7.3：翻译只剩「头部 中/EN 钮」这一个开关，段内不再有译按钮/提示条。
  //   lang='中' + availability = available / downloaded  → 每张卡自动翻，零点击
  //   lang='中' + storage.local.translatorReady 存过     → 同样自动试创建（无手势也放行）
  //   lang='中' + availability = downloadable/downloading → 先显示原文、不打扰；主人第一次
  //                                                          点「中」= Chrome 要的用户手势，
  //                                                          这一下下载语言包、钮上闪「翻译中…」，
  //                                                          成功后 translatorReady 落盘 → 永久自动
  //   浏览器没有 Translator                              → 原文照常显示，不提示也不报错
  // DeBot 段本来就有中文版，永远不进翻译登记；已是中文的 thesis 也会被 CJK 比例挡掉。
  const translation = {
    inst: null,
    // unknown|absent|idle|needgesture|preparing|ready|failed
    status: 'unknown',
    on: false,
    userOff: false,      // 主人手动切回"原"（EN），本次代币内别再自动翻回去
    autoFlag: false,     // 语言包此前已就绪（storage.local.translatorReady）
    autoTried: false,
    progress: null,
    cache: new Map(),    // 原文 → 译文（跨代币复用）
    segs: [],

    /** 每次换币重新登记节点；翻译实例与缓存保留。 */
    reset() { this.segs = []; this.userOff = false; },


    /**
     * 抓取器每次重扫都整段重建 DOM，旧节点断连后仍留在 segs 里——applyOne 有
     * isConnected 守卫不会写错地方，但列表会无界增长（v0.8 观点页全量后每轮 +几十条）。
     * 便宜的兜底：翻译前和列表偏大时清一次死段。
     */
    prune() {
      this.segs = this.segs.filter((s) => {
        try { return s && s.el && s.el.isConnected; } catch (_) { return false; }
      });
    },

    register(el, text) {
      const seg = { el, original: text };
      if (this.segs.length > 400) this.prune();
      this.segs.push(seg);
      if (!this.on) return;
      // 抓取器每次重扫都会重建这些节点。缓存里已有译文就同步写回，
      // 否则主人会看到"中文闪回英文再变中文"。
      const cached = this.cache.get(text);
      if (cached) {
        try { el.textContent = cached; } catch (_) { /* 忽略 */ }
        return;
      }
      if (this.status === 'ready') this.applyOne(seg);
    },

    /** 同步判定"这浏览器到底有没有这个 API"。 */
    probeSync() {
      if (this.status === 'unknown') {
        this.status = (typeof Translator === 'undefined') ? 'absent' : 'idle';
      }
      return this.status;
    },

    /**
     * 唯一的翻译状态出口：把 preparing 的「翻译中…」瞬态画到头部 中/EN 钮上，
     * 其余状态恢复正常的 中/EN 双档。段内不再有任何译按钮/提示条。
     */
    paintToggle() {
      if (!els || !els.langBtn) return;
      const busy = (this.status === 'preparing');
      if (els.langBusy) els.langBusy.hidden = !busy;
      if (els.langZh) els.langZh.hidden = busy;
      if (els.langEn) els.langEn.hidden = busy;
      if (els.langSep) els.langSep.hidden = busy;
      if (busy) {
        els.langBtn.setAttribute('title', this.progress == null
          ? tr('trPreparing')
          : tr('trDownloading') + this.progress + '%');
      } else if (this.status === 'absent') {
        els.langBtn.setAttribute('title', tr('trAbsent'));
      } else {
        els.langBtn.setAttribute('title', tr('trHint'));
      }
    },

    async availability() {
      if (typeof Translator === 'undefined') return 'absent';
      try {
        return await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'zh' });
      } catch (_) { return 'absent'; }
    },

    /**
     * 创建翻译实例。userGesture=true 表示这次调用来自点「中」，允许触发语言包下载。
     * 无手势时只有"语言包已就绪"或"以前下过(autoFlag)"才敢创建；被浏览器以
     * NotAllowedError 拒掉不算故障，静默退回 needgesture，等主人下次点「中」即可。
     */
    async ensure(userGesture) {
      if (this.inst) return this.inst;
      if (this.probeSync() === 'absent') { this.paintToggle(); return null; }
      const avail = await this.availability();
      if (avail === 'absent') { this.status = 'absent'; this.paintToggle(); return null; }
      if (avail === 'unavailable') { this.status = 'failed'; this.paintToggle(); return null; }
      const ready = (avail === 'available' || avail === 'downloaded');
      if (!userGesture && !ready && !this.autoFlag) {
        // 语言包没就绪又没手势：安静地显示原文，不打扰主人（不再弹提示条）
        this.status = 'needgesture';
        this.paintToggle();
        return null;
      }

      this.status = 'preparing';
      this.paintToggle();
      try {
        const self = this;
        this.inst = await Translator.create({
          sourceLanguage: 'en',
          targetLanguage: 'zh',
          monitor(m) {
            try {
              m.addEventListener('downloadprogress', (e) => {
                if (e && typeof e.loaded === 'number') {
                  self.progress = Math.round(e.loaded * 100);
                  self.paintToggle();
                }
              });
            } catch (_) { /* 没有进度事件就算了 */ }
          },
        });
        this.status = 'ready';
        this.autoFlag = true;
        // 关键：成功创建即落盘，之后每张卡/每个 session 自动翻，第一次点「中」永不再来
        try { chrome.storage.local.set({ translatorReady: true }); } catch (_) { /* 忽略 */ }
      } catch (e) {
        // NotAllowedError = 缺用户手势：不是故障，静默退回 needgesture
        this.status = (e && e.name === 'NotAllowedError') ? 'needgesture' : 'failed';
        this.inst = null;
      }
      this.paintToggle();
      return this.inst;
    },

    /**
     * 主人点「中」这一下（用户手势）：需要就下载语言包并开翻。
     * 是唯一会触发下载的入口，所以「翻译中…」瞬态只可能在这里出现。
     */
    async enableFromGesture() {
      if (settings.lang === 'en') return;
      if (this.on) return;
      if (this.probeSync() === 'absent') { this.paintToggle(); return; }
      this.userOff = false;
      const inst = await this.ensure(true);
      if (!inst) { this.paintToggle(); return; }
      if (settings.lang === 'en' || this.userOff) { this.paintToggle(); return; }
      this.on = true;
      this.paintToggle();
      this.applyAll();
    },

    showOriginals() {
      for (const seg of this.segs) {
        try { if (seg.el.isConnected) seg.el.textContent = seg.original; } catch (_) { /* 忽略 */ }
      }
    },

    /** 语言设置变化：切 EN → 立刻回原文；切「中」→ 重新走一次自动判定（点击的手势路径由 toggleLang 另走）。 */
    langChanged() {
      if (settings.lang === 'en') {
        if (this.on) { this.on = false; this.showOriginals(); }
        this.userOff = true;   // 主人明确选了 EN 原文，本次代币内别再自动翻回去
        this.paintToggle();
        return;
      }
      this.userOff = false;
      this.autoTried = false;
      this.paintToggle();
    },

    /**
     * 每次渲染完调用：中文模式 + 语言包已就绪（或以前下过）时自动开翻，零点击。
     * 没有 Translator / 主人选了 EN 原文 / 语言包还没就绪 → 静默什么都不做（等主人点「中」）。
     */
    autoEnable() {
      this.paintToggle();
      if (settings.lang === 'en') return;
      if (this.userOff) return;
      if (this.on) return;                 // 新登记的段由 register() 直接补翻
      if (this.probeSync() === 'absent') return;
      if (this.autoTried) return;
      this.autoTried = true;
      this.autoRun();
    },

    async autoRun() {
      const inst = await this.ensure(false);
      if (!inst) { this.paintToggle(); return; }  // ensure 已把 needgesture/failed 状态设好
      if (settings.lang === 'en' || this.userOff) { this.paintToggle(); return; }
      this.on = true;
      this.paintToggle();
      this.applyAll();
    },

    applyAll() { this.prune(); for (const seg of this.segs) this.applyOne(seg); },

    async applyOne(seg) {
      if (!this.inst || !this.on || !seg || !worthTranslating(seg.original)) return;
      let out = this.cache.get(seg.original);
      if (out === undefined) {
        try { out = await this.inst.translate(seg.original); } catch (_) { out = null; }
        if (out) this.cache.set(seg.original, out);
      }
      try {
        if (out && this.on && seg.el.isConnected) seg.el.textContent = out;
      } catch (_) { /* 忽略 */ }
    },
  };

  // ---------- DOM 抓取（读页面已渲染好的内容，零网络） ----------
  //
  // fomo 用哈希化的 CSS 类名，绝不能靠 class 选择器；这里全部基于文本特征。
  // 两个抓取器都必须防御：抓不到就显示一行灰字，永远不报错。

  /**
   * \u6293\u53d6\u8def\u5f84\u7684\u53d6\u6587\u672c\u51fd\u6570\uff08v0.8.2\uff0c2026-09-02 \u7ebf\u4e0a\u5b9e\u8bc1\u91cd\u5199\uff09\uff1a
   * \u4e0d\u80fd\u7528 innerText\u2014\u2014Chrome \u7684 innerText \u5728 flex/inline \u5144\u5f1f\u5355\u5143\u683c\u4e4b\u95f4**\u4e0d\u8865\u4efb\u4f55\u5206\u9694\u7b26**\uff0c
   * fomo \u7684\u884c\u6070\u662f flex \u5e03\u5c40\uff0c\u4e8e\u662f\u6574\u884c\u9ecf\u6210"231You can\u2026"\uff08\u70b9\u8d5e\u6570\u5265\u4e0d\u6389 \u2192 \u5168\u90e8 0 \u8d5e\u3001\u6392\u5e8f\u5931\u6548\uff09\u3001
   * "$775,969.072M"\uff08\u91d1\u989d\u9ecf\u4e0a\u4ee3\u5e01\u6570\u91cf \u2192 \u9b3c\u6570\u5b57\uff09\u3001"MEADGodTeam"\uff08\u540d\u5b57\u8fde\u4f53\uff09\u3001\u5217\u5934\u8bcd\u754c\u5224\u5b9a\u5931\u6548
   * \uff08\u672c\u5730 mock \u7684\u6587\u672c\u8282\u70b9\u51d1\u5de7\u81ea\u5e26\u7a7a\u683c\uff0c\u624d\u4e00\u76f4\u6ca1\u66b4\u9732\uff09\u3002\u4e5f\u4e0d\u80fd\u7528\u88f8 textContent\u2014\u2014\u540c\u6837\u9ecf\u3002
   * \u552f\u4e00\u7a33\u7684\uff1a\u628a\u540e\u4ee3\u6587\u672c\u8282\u70b9\u7528\u7a7a\u683c\u9010\u4e2a\u62fc\u63a5\uff0c\u8bcd\u754c\u6c38\u8fdc\u5728\uff1b\u9690\u85cf\u8282\u70b9\uff08\u4e3b\u4eba\u5207\u5230 fomo \u81ea\u5bb6
   * Swaps/Thesis \u8bc4\u8bba\u9875\u65f6 Holders \u8868\u4ecd\u5728 DOM \u4f46\u88ab\u9690\u85cf\uff09\u540c\u6837\u9002\u7528\u3002
   */
  function spacedText(el) {
    if (!el) return '';
    let out = '';
    try {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const s = String(n.nodeValue || '').trim();
        if (s) out += (out ? ' ' : '') + s;
      }
    } catch (_) { out = String((el && el.textContent) || ''); }
    return out;
  }
  const cleanText = (el) => spacedText(el).replace(/\u00a0/g, ' ');
  const oneLine = (str) => String(str || '').replace(/\s+/g, ' ').trim();

  // 金额 token：带符号的排在前面，保证 "+$2,436" 整体成一个 token 而不是被拆成 "$2,436"
  const MONEY_TOKEN_RE =
    /[+\-−▲▼]\s*\$[\d,]+(?:\.\d+)?[KMBkmb]?|\$[\d,]+(?:\.\d+)?[KMBkmb]?/g;
  const PCT_RE = /([▲▼]|[+\-−])\s*([\d,]+(?:\.\d+)?)\s*%/;
  const isSignedMoney = (m) => /^[+\-−▲▼]/.test(String(m || ''));

  /** 从一段文本里挑出所有金额（可带 +/-/▲▼、K/M/B 后缀），空白已归一。 */
  function moneyTokens(str) {
    const hit = oneLine(str).match(MONEY_TOKEN_RE) || [];
    return hit.map((t) => t.replace(/\s+/g, ''));
  }

  /** "$1.2M" → 1200000，用来按仓位排序取前 5。 */
  function moneyValue(m) {
    const mm = /\$([\d,]+(?:\.\d+)?)([KMBkmb])?/.exec(String(m || ''));
    if (!mm) return 0;
    const v = parseFloat(mm[1].replace(/,/g, ''));
    if (!isFinite(v)) return 0;
    const suf = (mm[2] || '').toUpperCase();
    if (suf === 'K') return v * 1e3;
    if (suf === 'M') return v * 1e6;
    if (suf === 'B') return v * 1e9;
    return v;
  }

  const holdCount = (t) => (String(t || '').match(SCRAPE_HOLD_LOOSE_G) || []).length;   // 只喂 textContent

  /** 数据行必须自带作者锚（profile 链接 / 头像），表头与汇总行没有，天然被挡在外面。 */
  function hasRowAnchor(row) {
    try {
      return !!row.querySelector('a[href*="/profile/"], a[href*="/u/" i], a[href*="user" i], img');
    } catch (_) { return false; }
  }

  /** 找出所有"一行一个持有人"的容器。 */
  function collectHolderRows() {
    let all;
    try { all = document.body ? document.body.querySelectorAll('*') : []; } catch (_) { return []; }

    const rows = [];
    for (const el of all) {
      let t;
      try { t = el.textContent || ''; } catch (_) { continue; }
      if (!SCRAPE_HOLD_LOOSE.test(t)) continue;   // t = textContent，拼死的，用无词界版
      // 取最内层命中者，避免把整张表当成一行
      let innermost = true;
      for (const c of el.children) {
        if (SCRAPE_HOLD_LOOSE.test(c.textContent || '')) { innermost = false; break; }
      }
      if (!innermost) continue;

      // 往上爬到"整行"：文本里既有两个金额、或金额+百分比即停。
      // 关键护栏（v0.6）：一旦这一层已经裹进了第二个持有人（出现两个 avg. hold），
      // 立刻退回上一层——v0.5 正是在这里越界，两个持有人共用了同一个 $ 列。
      let row = el;
      let prev = el;
      for (let i = 0; i < 6 && row; i++) {
        const rt = row.textContent || '';
        if (holdCount(rt) > 1) { row = prev; break; }
        // 金额判定必须走 cleanText（隐藏表的裸 textContent 会把金额黏上邻格，见 spacedText 注释）
        const money = moneyTokens(cleanText(row));
        if (money.length >= 2 || (money.length >= 1 && /%/.test(rt))) break;
        prev = row;
        row = row.parentElement;
      }
      if (!row) row = el;
      if (holdCount(row.textContent || '') > 1) continue; // 仍是多行 → 宁可不要
      if (!hasRowAnchor(row)) continue;                   // 无作者锚 → 表头/汇总行
      if (rows.indexOf(row) === -1) rows.push(row);
    }
    return rows;
  }

  /** 按行内出现顺序切列：第一个无符号 $ = 仓位，带符号 $ = 盈亏，剩下的无符号 $ = 入场价。 */
  function flatColumns(flat) {
    const money = moneyTokens(flat);
    const plain = money.filter((m) => !isSignedMoney(m));
    const signed = money.filter(isSignedMoney);
    const position = plain[0] || '';
    // 线上实证两件事：①行里有响应式复制出来的仓位值单元格（同值 $ 出现两次）——跳过与
    // 仓位同值的 token；②Avg. entry 列长这样 "$156.7M MC $0.157"（入场市值 + 入场价）——
    // 成本要的是价格，优先取无 K/M/B 后缀的"价格样" token，市值样只做兜底。
    let avgEntry = '';
    for (let i = 1; i < plain.length; i++) {
      const t = plain[i];
      if (t === position) continue;
      if (!/[KMBkmb]$/.test(t)) { avgEntry = t; break; }
      if (!avgEntry) avgEntry = t;
    }
    return {
      position,
      avgEntry,
      pnlUsd: signed[0] || '',
      pct: flat.match(PCT_RE),
    };
  }

  /** 行的直接子元素 = 列；整行被单个容器裹住时下钻一层。 */
  function rowCells(row) {
    let list = [];
    try { list = row.children ? Array.from(row.children) : []; } catch (_) { list = []; }
    let guard = 0;
    while (list.length === 1 && guard++ < 3) {
      let kids = [];
      try { kids = list[0].children ? Array.from(list[0].children) : []; } catch (_) { kids = []; }
      if (!kids.length) break;
      list = kids;
    }
    return list.map((c) => oneLine(cleanText(c))).filter(Boolean);
  }

  /** 逐单元格切列：整行文本扫串了列时的兜底（同一个 $ 被两行共用就是这么来的）。 */
  function cellColumns(row) {
    const cells = rowCells(row);
    if (cells.length < 2) return null;
    let position = '', avgEntry = '', pnlUsd = '', pct = null;
    for (const t of cells) {
      const money = moneyTokens(t);
      if (PCT_RE.test(t)) {                       // 盈亏列（$ 与 % 同格）
        if (!pct) pct = t.match(PCT_RE);
        const s = money.find(isSignedMoney);
        if (s && !pnlUsd) pnlUsd = s;
        continue;
      }
      const signed = money.find(isSignedMoney);
      if (signed) { if (!pnlUsd) pnlUsd = signed; continue; }
      const plains = money.filter((m) => !isSignedMoney(m));
      if (!plains.length) continue;
      if (!position) position = plains[0];
      // 成本列可能是 "$156.7M MC $0.157"：优先价格样（无 K/M/B 后缀）
      else if (!avgEntry) avgEntry = plains.find((m) => !/[KMBkmb]$/.test(m)) || plains[0];
    }
    if (!position && !pnlUsd && !pct) return null;
    return { position, avgEntry, pnlUsd, pct };
  }

  /** 从"交易者列"里抠出名字：砍掉 Team 标记与 "2d 2h avg. hold" 尾巴，取第一个像名字的 token。 */
  function traderCellName(row, flat) {
    const cells = rowCells(row);
    let head = cells.length ? cells[0] : String(flat || '');
    head = head
      .replace(new RegExp(DUR_RUN + '\\s*' + alt(L10N.hold) + '|' + alt(L10N.hold) + '\\s*[:：]?\\s*' + DUR_RUN, 'ig'), ' ')
      .replace(SCRAPE_HOLD_G, ' ')
      .replace(/\bTeam\b/g, ' ');
    for (const tok of head.split(/[\s|·,]+/)) {
      const t = tok.replace(/^@/, '');
      if (!t || PRICEISH_RE.test(t) || TIMEISH_RE.test(t)) continue;
      if (NAMEISH_RE.test(t)) return t.slice(0, 32);
    }
    return '';
  }

  function parseHolderRow(row, perCell) {
    const flat = oneLine(cleanText(row));
    if (!SCRAPE_HOLD_RE.test(flat)) return null;

    // handle：有 profile 链接就用；没有就从"交易者列"的文本里取
    //（线上实测该列长这样："MEADGod Team 2d 2h avg. hold" → 名字 = Team/avg. hold 之前那个 token）
    let handle = handleFromLink(profileLink(row));
    if (!handle) {
      try {
        const a = row.querySelector('a[href*="/u/" i], a[href*="user" i]');
        if (a) handle = oneLine(a.textContent).replace(/^@/, '').slice(0, 32);
      } catch (_) { /* 忽略 */ }
    }
    if (!handle) handle = traderCellName(row, flat);

    const cols = (perCell ? cellColumns(row) : null) || flatColumns(flat);
    const positionUsd = cols.position || '';
    const avgEntry = cols.avgEntry || '';
    const pnlUsd = cols.pnlUsd || '';

    let pnl = '';
    let pnlPos = null;
    if (cols.pct) {
      const sign = cols.pct[1];
      pnlPos = (sign === '▲' || sign === '+');
      pnl = (pnlPos ? '▲' : '▼') + cols.pct[2] + '%';
    } else if (pnlUsd) {
      pnlPos = /^[+▲]/.test(pnlUsd) || !/[\-−▼]/.test(pnlUsd);
      pnl = pnlUsd;
    }

    // 时长单位放宽到 mo/w（"1mo avg. hold" 这种老持有人以前会解析成空）
    const holdRaw = flat.match(HOLD_DUR_RE);
    const holdM = holdRaw ? [holdRaw[0], (holdRaw[1] || holdRaw[2] || '').trim()] : null;
    const avgHold = holdM ? oneLine(holdM[1]) : '';

    // 至少要有仓位或盈亏才算一行有效数据
    if (!positionUsd && !pnl) return null;
    return { handle, positionUsd, avgEntry, pnl, pnlPos, avgHold };
  }

  function parseHolderRows(rowEls, perCell) {
    const out = [];
    const seen = [];
    for (const row of rowEls) {
      let parsed = null;
      try { parsed = parseHolderRow(row, perCell); } catch (_) { parsed = null; }
      if (!parsed) continue;
      // 结构化去重（作者+仓位），不再拿整行文本前 200 字当 key
      const key = (parsed.handle || '?') + '|' + (parsed.positionUsd || '?');
      if (seen.indexOf(key) !== -1) continue;
      seen.push(key);
      out.push(parsed);
    }
    return out;
  }

  /** 不同持有人解析出同一个仓位金额 = 列抓串了（线上实测过两行同为 $4,163,254）。 */
  function duplicatePositions(rows) {
    const seen = [];
    let dup = 0;
    for (const r of rows) {
      const v = r.positionUsd || '';
      if (!v) continue;
      if (seen.indexOf(v) !== -1) dup++;
      else seen.push(v);
    }
    return dup;
  }

  /**
   * 带护栏的整表解析：先整行解析，发现"不同持有人同一仓位金额"（列抓串了）再退回
   * 逐单元格解析取杂音更小的那份。scrapeHolders 与 thesis 的仓位装饰共用这一份。
   */
  function parseHoldersGuarded(rowEls) {
    let rows = parseHolderRows(rowEls, false);
    const dup = duplicatePositions(rows);
    if (dup > 0) {
      const percell = parseHolderRows(rowEls, true);
      if (percell.length && duplicatePositions(percell) < dup) rows = percell;
    }
    return rows;
  }

  /** 已解析的持有人行 → 按仓位取前 6（Holders 页展示用）。 */
  function topHolders(parsed) {
    const rows = (parsed || []).slice();
    rows.sort((a, b) => moneyValue(b.positionUsd) - moneyValue(a.positionUsd));
    return rows.slice(0, HOLDER_SHOW);
  }

  /** 持仓表：抓每一行含 "avg. hold" 的块，解析 handle/仓位/入场价/盈亏，按仓位取前 6。 */
  function scrapeHolders(rowElsIn) {
    const rowEls = rowElsIn || collectHolderRows();
    if (!rowEls.length) return [];
    return topHolders(parseHoldersGuarded(rowEls));
  }

  // ---- Fomo 持仓占比（v0.9.10）--------------------------------------------------
  //
  // 口径同「风向」：fomo 用户合计持仓 ÷ 市值。两个数都在 fomo 页面上已经渲染好了——
  // 每人的 $仓位在 Holders 表里（与上面同一张表、同一次解析），市值在代币信息条上——
  // 所以零网络、不登录、不烧任何第三方配额。
  // ⚠️ 这是**下界**：真页面 Holders (550) 只渲染了 48 行（2026-09-04 VISTA 实测），表外的人
  //   每个都拿得更少，但仍是漏算的，所以数字前带 ≥，并在副行标出榜单覆盖了多少人。
  // ⚠️ fail-closed：市值取不到、或合计 > 市值（说明抓到的不是市值）→ 整行不显示，
  //   绝不画一个"看着很正常的 0%"。
  const SHARE_BUY_PCT = 15;      // 主人经验阈值：≥15% 值得看（★）
  const SHARE_STRONG_PCT = 20;   // ≥20% 强（★★）
  let shareReject = '';          // 上次算不出的原因（no-rows / no-mc / bad-pct / over100），只进诊断（Kimi 审查 F2/F5）
  // 代币信息条上的 "Market cap" 叶子元素（6 语种锚点同 L10N）；无词界版——textContent 拼死的短串
  const MC_LABEL_RE = new RegExp('^\\s*' + alt(L10N.marketCap, true) + '\\s*$', 'i');
  // 底部标签 / 表标题的 "Holders (550)"：括号里的数 = fomo 持有人总数（信息条上的 "Holders 3K" 是链上持有人，无括号，不会误中）
  const HOLDERS_COUNT_RE = new RegExp('^\\s*' + alt(L10N.holders, true) + '\\s*[（(]\\s*([\\d,]+)\\s*[)）]\\s*$', 'i');

  /**
   * 市值：① 信息条——叶子元素文本恰为 "Market cap"，父元素文本 = "Market cap $3.3M"（真页面实测形状；
   * Swaps 表头里那个 "Market Cap" 父文本无金额，自然落选）；② 兜底读页面标题 "$3.3M MC | VISTA | fomo"。
   */
  function readMarketCap() {
    try {
      const all = document.body ? document.body.querySelectorAll('div, span, p, dt, th, td, li, b, strong') : [];
      let n = 0;
      for (const el of all) {
        if (++n > 20000) break;                        // 超长页面封顶（真页面几千个节点；封顶后还有标题兜底）
        if (el.childElementCount) continue;
        const t = el.textContent || '';
        if (t.length > 24 || !MC_LABEL_RE.test(t)) continue;
        const parent = el.parentElement;
        if (!parent) continue;
        const pt = oneLine(cleanText(parent));
        if (pt.length > 48) continue;                  // 表头 / 长句不是信息条
        const money = moneyTokens(pt).filter((m) => !isSignedMoney(m));
        if (!money.length) continue;
        const v = moneyValue(money[0]);
        if (v > 0) return { usd: v, src: 'bar' };
      }
    } catch (_) { /* 落到标题兜底 */ }
    try {
      const m = /^\s*(\$[\d,]+(?:\.\d+)?[KMBkmb]?)\s*MC\b/.exec(document.title || '');
      if (m) { const v = moneyValue(m[1]); if (v > 0) return { usd: v, src: 'title' }; }
    } catch (_) { /* 忽略 */ }
    return null;
  }

  /** fomo 持有人总数：优先当前激活且可见的 Holders 标签，再从其它可见标题取最大。 */
  function fomoHolderTotal() {
    try {
      let best = null; let activeBest = null;
      let n = 0;
      for (const el of document.querySelectorAll('button, [role="tab"], div, span, h1, h2, h3')) {
        if (++n > 8000) break;
        if (el.childElementCount > 2) continue;
        if (!visibleElement(el)) continue;
        const t = el.textContent || '';
        if (t.length > 32) continue;
        const m = HOLDERS_COUNT_RE.exec(t);
        if (!m) continue;
        const v = parseInt(m[1].replace(/,/g, ''), 10);
        if (!Number.isFinite(v) || v <= 0) continue;
        if (best == null || v > best) best = v;
        const cls = String(el.className || '');
        const active = el.getAttribute('aria-selected') === 'true' || el.getAttribute('data-state') === 'active'
          || /(?:^|\s)(?:active|selected|on|text-text-primary)(?:\s|$)/.test(cls);
        if (active && (activeBest == null || v > activeBest)) activeBest = v;
      }
      return activeBest == null ? best : activeBest;
    } catch (_) { return null; }
  }

  /** 全表合计 ÷ 市值 → { pct, sumUsd, mcUsd, mcSrc, counted, total, lower, tier } 或 null（算不出 / 对不上）。 */
  function computeFomoShare(parsed) {
    let sum = 0;
    let counted = 0;
    for (const r of parsed || []) {
      const v = moneyValue(r && r.positionUsd);
      if (!(v > 0)) continue;
      sum += v;
      counted++;
    }
    if (!counted) { shareReject = 'no-rows'; return null; }
    const mc = readMarketCap();
    if (!mc || !(mc.usd > 0)) { shareReject = 'no-mc'; return null; }
    const pct = sum / mc.usd * 100;
    if (!isFinite(pct) || pct <= 0) { shareReject = 'bad-pct'; return null; }
    if (pct > 100) { shareReject = 'over100'; return null; }   // 合计超过市值 = 市值抓错了，宁可不显示（原因进诊断）
    shareReject = '';
    const total = fomoHolderTotal();
    return {
      pct: Math.round(pct * 10) / 10, sumUsd: sum, mcUsd: mc.usd, mcSrc: mc.src,
      counted, total, lower: total == null || counted < total,
      tier: pct >= SHARE_STRONG_PCT ? 'strong' : (pct >= SHARE_BUY_PCT ? 'buy' : 'low'),
    };
  }

  // ---- Thesis 抓取（v0.7.4：改读 Holders 表的 "Thesis" 列）--------------------
  //
  // 旧版读左栏 Feed —— 那是"全局活动流"，各币混在一起，当前币的 thesis 只是偶尔出现在
  // 那里，所以"刚刚能抓、现在抓不到"。真正 token-specific 的 thesis 长在 Holders 表的
  // "Thesis" 列里（每个持有人对这只币写下的观点）。两个抓取器共用同一张 Holders 表，
  // 懒加载晚到时靠同一个 MutationObserver 一起被接住。
  const COL_TRADER_RE = rx('trader');
  const COL_POSITION_RE = rx('position');
  const COL_PNL_RE = rx('pnl', 'i');
  const COL_ENTRY_RE = rx('entry', 'i');
  const COL_THESIS_RE = rx('thesis');
  // 无词界的宽松版：只给"便宜预筛"用（textContent 会把相邻单元格拼死，带词界必失配）。
  // 精确判定一律走上面带词界的版本 + innerText。
  const COL_TRADER_LOOSE = rx('trader', 'i', true);
  const COL_POSITION_LOOSE = rx('position', 'i', true);
  const COL_ENTRY_LOOSE = rx('entry', 'i', true);
  const COL_THESIS_LOOSE = rx('thesis', 'i', true);
  // traderCellName 会用到这几个（保留）
  const TIMEISH_RE = /^\d+\s*[smhdw]$/i;
  const PRICEISH_RE = /^[$＄]?[\d,.]+\s*[KMB%]?$/i;
  const NAMEISH_RE = /^@?[A-Za-z0-9_.\-]{2,24}$/;
  const PROFILE_SEL = 'a[href*="/profile/"]';

  function profileLink(node) {
    try { return node.querySelector(PROFILE_SEL); } catch (_) { return null; }
  }

  /** 有 profile 链接时它最可靠，但绝不作为"是不是条目"的硬条件。 */
  function handleFromLink(a) {
    if (!a) return '';
    let t = '';
    try { t = oneLine(a.textContent).replace(/^@/, ''); } catch (_) { t = ''; }
    if (t && t.length <= 32 && !/\s/.test(t)) return t;
    try {
      const m = /\/profile\/([^/?#]+)/.exec(a.getAttribute('href') || '');
      if (m && m[1]) return decodeURIComponent(m[1]).slice(0, 32);
    } catch (_) { /* 忽略 */ }
    return t.slice(0, 32);
  }

  const normKey = (s) => oneLine(s).toLowerCase().replace(/[\s　]+/g, ' ');

  /** 行的直接子元素（列），不过滤空单元格——空 Thesis 列要保住位置，索引才对得上。 */
  function rowCellEls(row) {
    let list = [];
    try { list = row.children ? Array.from(row.children) : []; } catch (_) { list = []; }
    let guard = 0;
    while (list.length === 1 && guard++ < 3) {
      let kids = [];
      try { kids = list[0].children ? Array.from(list[0].children) : []; } catch (_) { kids = []; }
      if (!kids.length) break;
      list = kids;
    }
    return list;
  }

  /**
   * 找 Holders 表列头，定出 "Thesis" 列位置：返回 { len, thesisIdx } 或 null。
   * 列头 = 同一短元素里同时含 Trader / Position / Avg. entry / Thesis 四个列名。
   * 数据行可能比列头多出一个没有表头的 mcap 列，所以调用方按"距末尾偏移"折算，
   * 而不是拿列头下标直接读数据行（见 parseHolderThesis）——这样列往前插也不错位。
   */
  function findThesisColumn() {
    let all;
    try { all = document.body ? document.body.querySelectorAll('*') : []; } catch (_) { return null; }
    for (const el of all) {
      // 便宜预筛（textContent 免布局）：列头里得同时出现这几个词，再算 innerText。
      // 注意不能拿 textContent 直接做 \b 词界判定——块级单元格的 textContent 会拼成
      // "TraderPosition…"（无空格），\bTrader\b 会漏；innerText 才在块间补空格。
      let raw;
      try { raw = el.textContent || ''; } catch (_) { continue; }
      if (!raw || raw.length > 200) continue;   // 列头很短；跳过大容器，别去读整张表
      // v0.9.8 scar：这道**便宜预筛**只能用无词界的宽松版。上面那句注释早就写明 textContent
      // 会把列头拼成 "TraderPosition"（线上/mock 的 hcol 之间没有空白节点），可预筛用的却是
      // 带词界的 COL_*_RE —— 于是拉丁语系（含英文）在这一步就被判死，innerText 那道精确判定
      // 根本没机会跑；只有中日文因为 CJK 不加词界才侥幸通过（zh/ja 测试因此全绿）。
      if (!COL_TRADER_LOOSE.test(raw) || !COL_POSITION_LOOSE.test(raw)
        || !COL_THESIS_LOOSE.test(raw) || !COL_ENTRY_LOOSE.test(raw)) continue;
      const t = oneLine(cleanText(el));   // innerText：块级单元格间会带空格，词界判定才准
      if (!COL_TRADER_RE.test(t) || !COL_POSITION_RE.test(t)
        || !COL_ENTRY_RE.test(t) || !COL_THESIS_RE.test(t)) continue;
      // 取最内层命中者才是列头本身
      let innermost = true;
      for (const c of el.children) {
        const ct = oneLine(cleanText(c));
        if (COL_TRADER_RE.test(ct) && COL_POSITION_RE.test(ct) && COL_THESIS_RE.test(ct)) { innermost = false; break; }
      }
      if (!innermost) continue;
      const cells = rowCellEls(el).map((c) => oneLine(cleanText(c)));
      const thesisCellRe = new RegExp('^' + alt(L10N.thesis, true) + '$', 'i');
    const idx = cells.findIndex((c) => thesisCellRe.test(c.trim()));
      if (idx === -1) continue;
      return { len: cells.length, thesisIdx: idx };
    }
    return null;
  }

  /**
   * 从一行持有人里抠出他写的 thesis。col = findThesisColumn() 结果（可能 null）。
   * 定位 Thesis 单元格：列头能定 → 按"距末尾偏移"算（数据行可能多出无表头 mcap 列）；
   * 定不了 → 退回启发式：词数 >6 或含 https/x.com 链接的那个单元格。
   */
  function parseHolderThesis(row, col) {
    const cellEls = rowCellEls(row);
    if (!cellEls.length) return null;

    let cell = null;
    if (col && typeof col.thesisIdx === 'number' && col.len > 0) {
      const tail = col.len - 1 - col.thesisIdx;          // Thesis 之后还有几列（通常 0=最后一列）
      const idx = cellEls.length - 1 - tail;
      if (idx >= 0 && idx < cellEls.length) cell = cellEls[idx];
    } else {
      for (const c of cellEls) {
        const ct = oneLine(cleanText(c));
        // 词数阈值对无空格的中文失效（整段算 1 个"词"）→ 补 CJK 字符量判据（K3 审查修正）
        if (/https:\/\/|x\.com\//i.test(ct)
          || ct.split(/\s+/).filter(Boolean).length > 6
          || (cjkRatio(ct) >= 0.2 && ct.replace(/\s+/g, '').length > 12)) { cell = c; break; }
      }
    }
    if (!cell) return null;

    let raw = oneLine(cleanText(cell));
    if (!raw) return null;
    if (/^Thesis$/i.test(raw)) return null;              // 撞上列头本身，跳过

    // 前导点赞数（"147 …"）：抠出来做排序键，再从正文里剥掉
    let likes = 0;
    const likeM = raw.match(/^([\d,]+)\s+(?=\S)/);
    if (likeM) { likes = parseInt(likeM[1].replace(/,/g, ''), 10) || 0; raw = raw.slice(likeM[0].length); }
    raw = raw.trim();

    // 空、或剥掉点赞数后只剩数字 → 这位持有人没写 thesis
    if (!raw || /^[\d,.]+$/.test(raw)) return null;

    // 作者 = 持有人名字（复用 KOL 的交易者列解析：砍 Team / "Nd Nh avg. hold" 尾巴）
    const flat = oneLine(cleanText(row));
    const handle = handleFromLink(profileLink(row)) || traderCellName(row, flat);

    // 链接：单元格里的锚点，或正文里的 https（正文里的会被 textBlock 自动 linkify）
    let url = '';
    try { const a = cell.querySelector('a[href^="https://"]'); if (a) url = a.getAttribute('href'); } catch (_) { /* 忽略 */ }
    if (!url) url = urlsIn(raw)[0] || '';

    return { handle, symbol: '', text: raw, url: safeHttps(url) || '', likes, time: '', raw };
  }

  /**
   * Thesis：读 Holders 表每个持有人写的 thesis（token-specific，稳定源）。
   * 与 KOL 共用 collectHolderRows()——同一张表，懒加载一起被接住。
   * 排序后去重（按正文），点赞多→少（无赞按行序，稳定排序）。
   */
  // ---- Thesis 发言时间（v0.8.6 机会主义增强）--------------------------------
  // Holders 表的 Thesis 列没有时间戳（2026-09-02 线上逐格实证）；时间只存在于 fomo
  // 自家的 Thesis 评论流里，且只在主人开过那个 tab 后才渲染进 DOM。所以只做
  // "有就配、配不上就不显示"：按 作者 + 正文前缀 双条件对号，宁缺毋错。
  /** fomo 的相对时间（"2h"/"9m"/"3d"/"just now"）→ 分钟数；解析不出返回 null。 */
  function relAgeMinutes(t) {
    const str = String(t || '').trim().replace(/\s*(前|ago)\s*$/, '');
    if (!str) return null;
    if (rx('justNow', 'i', true).test(str)) return 0;
    const m = new RegExp('^(\\d+)\\s*(' + DUR_UNIT + ')$', 'i').exec(str);
    if (!m) return null;
    const u = m[2].toLowerCase();
    const mult = /^(s|秒)$/.test(u) ? 1 / 60
      : /^(m|min|分钟|分|min\.)$/.test(u) ? 1
      : /^(h|小时|時間|std\.?)$/.test(u) ? 60
      : /^(d|天|日|tage?|j)$/.test(u) ? 1440
      : /^(w|周|週)$/.test(u) ? 10080
      : /^(mo|个月|ヶ月|mon\.?|mes|meses|mois)$/.test(u) ? 43200 : null;
    return mult == null ? null : parseInt(m[1], 10) * mult;
  }

  const AGE_TOKEN = '(?:\\d+\\s*' + DUR_UNIT + '(?:\\s*(?:前|ago))?|' + alt(L10N.justNow, true) + ')';
  const COMMENT_HEAD_RE = new RegExp('^(@?[A-Za-z0-9_.\\-]{2,25})\\s+' + alt(L10N.thesis) + '\\s+(' + AGE_TOKEN + ')(?![A-Za-z])');
  const COMMENT_HEAD_G = new RegExp('(?:^|\\s)@?[A-Za-z0-9_.\\-]{2,25}\\s+' + alt(L10N.thesis) + '\\s+' + AGE_TOKEN + '(?![A-Za-z])', 'g');

  /**
   * fomo 自家 Thesis 评论流（主人开过那个 tab 才渲染进 DOM）：一条评论 =
   * "作者 Thesis 时间 $持仓 ( ▲盈亏% ) 正文 点赞 [N older]"。
   * 线上实证（2026-09-02）：作者+徽章+时间是一个小头部元素，正文在外层——
   * 所以从头部命中处向上爬到"完整一行"（再往上会裹进第二条评论就停）。
   */
  function scrapeThesisFeed() {
    const out = [];
    let all;
    try { all = document.body ? document.body.querySelectorAll('*') : []; } catch (_) { return out; }
    // v0.9.6 真页面 scar：左栏那条是**全局活动流**（所有币混着滚，还混 Buy/Sell），
    // 它的条目长得和底部 Thesis 标签一模一样（"handle Thesis 3m"），扫全文档会把别的币的
    // 评论当成本币的，"最新"档于是永远对不上号。实测坐标：左栏 x≈65 w≈214，底部面板 x≈353 w≈806。
    // 以左栏容器为准排除；容器认不出时退回宽度/位置兜底。
    // 注意：findLeftPanel() 返回的是 DOMRect，不是元素——别对它调 .contains（会抛，
    // 然后被 catch 吞掉，连带下面的几何判定一起失效。v0.9.6 就栽在这上面。）
    // v0.9.8：认没认出左栏要留痕。v0.9.6 那次就是 catch 把异常吞了、整道防线静默失效，
    // 页面上只表现为"评论对不上号"，没人看得出防线已经不在了。现在写进 diag。
    let panelRect = null;
    try { panelRect = findLeftPanel(); leftPanelHow = panelRect ? 'rect' : 'fallback'; }
    catch (_) { panelRect = null; leftPanelHow = 'error'; }
    const inLeftPanel = (el) => {
      let r;
      try { r = el.getBoundingClientRect(); } catch (_) { return false; }
      if (!r || !r.width) return false;
      const cx = r.left + r.width / 2;
      // ① 水平中心落在左栏矩形内 ② 兜底：又窄又靠左（左栏 w≈214/280，主面板 w≈806）
      if (panelRect && cx >= panelRect.left - 4 && cx <= panelRect.right + 4) return true;
      // 兜底只在「认不出左栏 + 桌面宽度」时用：窄视口下 fomo 会把左栏收起来，
      // 这时主面板自己也又窄又靠左，再套这条就是把正主的评论全判成左栏（宁可漏排除，不可错杀）。
      if (!panelRect && window.innerWidth >= 900
          && r.width < 300 && r.left < window.innerWidth * LEFT_ZONE_RATIO) return true;
      return false;
    };
    const seenRows = [];
    for (const el of all) {
      let raw;
      try { raw = el.textContent || ''; } catch (_) { continue; }
      if (!raw || raw.length > 300 || !COL_THESIS_LOOSE.test(raw)) continue;   // 预筛：textContent 拼死，无词界版
      const head = oneLine(cleanText(el));
      if (!COMMENT_HEAD_RE.test(head)) continue;
      if (inLeftPanel(el)) continue;   // 左栏全局流：不是当前币的评论
      let innermost = true;
      for (const c of el.children) {
        if (COMMENT_HEAD_RE.test(oneLine(cleanText(c)))) { innermost = false; break; }
      }
      if (!innermost) continue;
      // 向上爬到完整评论行：父层仍以同一个头开头、且只含这一条评论
      let row = el;
      for (let i = 0; i < 5 && row.parentElement; i++) {
        const pt = oneLine(cleanText(row.parentElement));
        if (!COMMENT_HEAD_RE.test(pt)) break;
        if ((pt.match(COMMENT_HEAD_G) || []).length > 1) break;
        if (pt.length > 1200) break;
        row = row.parentElement;
      }
      if (seenRows.indexOf(row) !== -1) continue;
      seenRows.push(row);

      const t = oneLine(cleanText(row));
      const m = COMMENT_HEAD_RE.exec(t);
      if (!m) continue;
      let rest = t.slice(m[0].length).trim();
      let positionUsd = '';
      const hm = /^([$][\d,.]+[KMBkmb]?)\s*/.exec(rest);
      if (hm) { positionUsd = hm[1]; rest = rest.slice(hm[0].length); }
      let pnl = '';
      let pnlPos = null;
      const pm = /^\(\s*([▲▼+\-−])\s*([\d,.]+)\s*%\s*\)\s*/.exec(rest);
      if (pm) {
        pnlPos = (pm[1] === '▲' || pm[1] === '+');
        pnl = (pnlPos ? '▲' : '▼') + pm[2] + '%';
        rest = rest.slice(pm[0].length);
      }
      rest = rest.replace(/\s+\d+\s+older$/i, '').trim();
      let likes = 0;
      let text = rest;
      const lm = /\s(\d{1,6})$/.exec(rest);
      if (lm) { likes = parseInt(lm[1], 10) || 0; text = rest.slice(0, lm.index).trim(); }
      if (!text) continue;
      out.push({
        handle: m[1].replace(/^@/, ''), time: m[2], ageMin: relAgeMinutes(m[2]),
        likes, positionUsd, pnl, pnlPos, text, url: safeHttps(urlsIn(text)[0] || '') || '',
      });
      if (out.length >= 60) break;
    }
    return out;
  }

  function scrapeThesis(rowElsIn) {
    const rowEls = rowElsIn || collectHolderRows();
    if (!rowEls.length) return { rows: [], general: false };
    const col = findThesisColumn();

    // v0.8：观点页行头要带作者的仓位/盈亏（fomo 同款）。
    // v0.8.1（K3 审查修正）：对号改按"同一行 DOM"，不再按 handle 建表——无 profile 链接时
    // handle 退化为显示名，同名持有人会张冠李戴；行身份永远不会。perCell 模式沿用整表判定
    //（不同持有人同仓位金额 = 列抓串了），解析不出就让装饰缺席，绝不影响 thesis 正文本身。
    let perCell = false;
    try {
      const flat = parseHolderRows(rowEls, false);
      const dup = duplicatePositions(flat);
      if (dup > 0) {
        const cells = parseHolderRows(rowEls, true);
        if (cells.length && duplicatePositions(cells) < dup) perCell = true;
      }
    } catch (_) { /* 装饰缺席即可 */ }

    const parsedAll = [];
    for (const row of rowEls) {
      let p = null;
      try { p = parseHolderThesis(row, col); } catch (_) { p = null; }
      if (!p) continue;
      try {
        const hold = parseHolderRow(row, perCell);   // 同一行 → 装饰必属同一位持有人
        if (hold) {
          p.positionUsd = hold.positionUsd || '';
          p.pnl = hold.pnl || '';
          p.pnlPos = hold.pnlPos;
        }
      } catch (_) { /* 装饰缺席 */ }
      parsedAll.push(p);
    }
    parsedAll.sort((a, b) => (b.likes || 0) - (a.likes || 0));   // 稳定：点赞多在前，无赞保持行序
    const out = [];
    const seen = [];
    for (const p of parsedAll) {
      const key = normKey(p.text);                               // 同一条 thesis 只留点赞最高那份
      if (!key || seen.indexOf(key) !== -1) continue;
      seen.push(key);
      out.push(p);
    }

    // 发言时间：评论流在 DOM 里才配得上（作者+正文前缀双门，宁缺毋错）。
    // 评论流只渲染最新一段，按赞榜前排的老 thesis 多半配不上——这是数据侧事实。
    let feed = [];
    try { feed = scrapeThesisFeed(); } catch (_) { feed = []; }
    for (const p of out) {
      const key = normKey(p.text).slice(0, 24);
      if (!key) continue;
      const hit = feed.find((c) => c.handle.toLowerCase() === String(p.handle || '').toLowerCase()
        && normKey(c.text).indexOf(key) !== -1);
      if (hit) p.time = hit.time;
    }
    return { rows: out, general: false, feed };
  }

  // ---------- 抓取调度：开卡即扫，表格懒加载 → 短时重扫 ----------
  let scrapeObserver = null;
  let lastScanAt = 0;        // 上次扫表时间（诊断用）
  let scrapeTimers = [];
  let observerDebounce = null;

  function stopScrapers() {
    if (scrapeObserver) { try { scrapeObserver.disconnect(); } catch (_) {} scrapeObserver = null; }
    for (const t of scrapeTimers) clearTimeout(t);
    scrapeTimers = [];
    if (observerDebounce) { clearTimeout(observerDebounce); observerDebounce = null; }
  }

  /**
   * 页面上 "Friends only" 筛选是否开着：true / false / null（判不出）。
   * 主人 2026-09-02：Thesis/Holders 为空时必须提示这一层，否则别人会把
   * "筛选后没数据" 误解成 "扩展抓不到"。
   */
  /**
   * fomo 的 Friends only 开关（v0.9.4 按真页面 DOM 重写）：
   * 真页面不是 checkbox，是 <button> 里一个 SVG，勾选态靠颜色变量区分——
   *   勾选：style="color: var(--color-accent-primary)"，SVG path 以 "M2 5.2" 开头（实心勾框）
   *   未勾：style="color: var(--color-text-tertiary)"，SVG path 以 "M10.8 2H5.2" 开头（空框）
   * 页面上有两个 Friends only：图表叠加层那个（<label> 包）和 Holders 表右上那个（<div> 包，
   * 旁边有 "Thesis only"）。决定 Holders 表内容的是后者，优先取它；找不到再退回文档序最后一个。
   * 老的 checkbox / aria-checked 路径保留，兜别的变体。判不出返回 null。
   */
  function friendsOnlyControl() {
    // K3 #5：不再对全页 label/div/span 逐个读 textContent（O(页面)），改走文本节点 TreeWalker（O(文本节点)）
    let carriers = [];
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (new RegExp('^\\s*' + alt(L10N.friendsOnly, true) + '\\s*$', 'i').test(n.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
      });
      let n;
      while ((n = walker.nextNode())) {
        let el = n.parentElement;
        // 文本可能被 <font>/<span> 包一层：上溯到第一个"自己文本恰好是 Friends only 且含状态控件"的容器，最多 3 层
        let pick = null;
        for (let i = 0; i < 3 && el && el !== document.body; i++) {
          const t = (el.textContent || '').trim();
          if (!new RegExp('^' + alt(L10N.friendsOnly, true) + '$', 'i').test(t)) break;
          if (hasStateControl(el)) { pick = el; break; }
          el = el.parentElement;
        }
        if (pick && carriers.indexOf(pick) === -1) carriers.push(pick);
      }
    } catch (_) { return null; }
    if (!carriers.length) return null;
    // Gickey D3：响应式页面常有隐藏副本，可见的优先
    const visible = carriers.filter((c) => { try { return c.getClientRects().length > 0; } catch (_) { return true; } });
    if (visible.length) carriers = visible;
    // Holders 表那个：自己或 ≤3 层祖先的兄弟里有一个文本恰为 "Thesis only"（K3 #1：不再只看直接兄弟）
    for (const c of carriers) {
      let el = c;
      for (let i = 0; i < 3 && el && el.parentElement && el.parentElement !== document.body; i++) {
        for (const sib of el.parentElement.children) {
          if (sib === el) continue;
          let st;
          try { st = (sib.textContent || '').trim(); } catch (_) { continue; }
          if (new RegExp('^' + alt(L10N.thesisOnly, true) + '$', 'i').test(st)) return c;
        }
        el = el.parentElement;
      }
    }
    return carriers[carriers.length - 1];
  }

  /** 载体里有没有能读出勾选态的东西（checkbox / aria-checked / 带 inline style 的按钮 / svg path）。 */
  function hasStateControl(el) {
    try {
      return !!el.querySelector('input[type="checkbox"], [aria-checked], button[style], svg path');
    } catch (_) { return false; }
  }

  function friendsOnlyActive() {
    try {
      const el = friendsOnlyControl();
      if (!el) return null;
      const box = el.querySelector('input[type="checkbox"]');
      if (box) return !!box.checked;
      const aria = el.querySelector('[aria-checked]');
      if (aria) return aria.getAttribute('aria-checked') === 'true';
      // K3 #2/#10：只认精确 token、先判 off——`--color-text-primary` 这种也含 "primary"，裸匹配会把关判成开。
      // 只读按钮自己的 inline style，不拿外层容器的颜色顶包；认不出宁可返回 null（退回通用提示）。
      const btn = el.querySelector('button[style], [role="checkbox"][style]');
      const style = ((btn && btn.getAttribute('style')) || '').toLowerCase();
      if (/--color-text-tertiary\b/.test(style)) return false;
      if (/--color-accent-primary\b/.test(style)) return true;
      const path = el.querySelector('svg path');
      const d = (path && path.getAttribute('d')) || '';
      if (/^M2\s+5\.2/.test(d)) return true;
      if (/^M10\.8\s+2H5\.2/.test(d)) return false;
    } catch (_) { /* 判不出 */ }
    return null;
  }

  /**
   * fomo 底部面板当前停在哪个标签（Holders / Swaps / Thesis）。
   * 真页面：三个 button 文案 "Holders (21.5K)" / "Swaps" / "Thesis (1,039)"，
   * 当前项 class 含 text-text-primary，其余 text-text-tertiary。判不出返回 null。
   */
  /**
   * 页面是否被浏览器翻译过（v0.9.5，主人朋友 scar：整页翻成中文后所有英文锚点同时消失）。
   * Chrome 翻译的两处稳定签名：<html class="translated-ltr|translated-rtl">；文本节点被包进
   * <font style="vertical-align: inherit;">。任一命中即判 true。
   */
  function pageTranslated() {
    try {
      const cls = String(document.documentElement.className || '');
      if (/\btranslated-(ltr|rtl)\b/.test(cls)) return true;
      if (document.querySelector('font[style*="vertical-align: inherit"]')) return true;
    } catch (_) { /* 判不出当没翻译 */ }
    return false;
  }

  const TAB_HOLDERS_RE = new RegExp('^' + alt(L10N.holders, true) + '(?:\\s*\\(|\\s*$)');
  const TAB_SWAPS_RE = new RegExp('^' + alt(L10N.swaps, true) + '(?:\\s*\\(|\\s*$)');
  const TAB_THESIS_RE = new RegExp('^' + alt(L10N.thesis, true) + '(?:\\s*\\(|\\s*$)');

  function fomoBottomTab() {
    try {
      // 候选：文案像 Holders / Swaps / Thesis 的按钮
      const cands = [];
      for (const b of document.querySelectorAll('button, [role="tab"]')) {
        const t = (b.textContent || '').trim();
        if (t.length > 25) continue;
        let key = null;
        // 标签文案 = 词本身，后面只允许空格/括号计数（"交易" 是 Swaps，"交易者" 是 Traders——必须整词匹配）
        if (TAB_HOLDERS_RE.test(t)) key = 'holders';
        else if (TAB_SWAPS_RE.test(t)) key = 'swaps';
        else if (TAB_THESIS_RE.test(t)) key = 'thesis';
        if (key) cands.push({ key, b });
      }
      if (cands.length < 2) return null;
      // K3 #6 / Gickey D3：只评估"同一排"的那组。真页面每个 tab 可能各裹一层 div，
      // 所以不是按直接父节点分组，而是找 ≤4 层内最近的、能罩住 ≥2 个不同 key 的祖先当 tablist。
      let best = null;   // { root, members }
      for (const c of cands) {
        let a = c.b.parentElement;
        for (let i = 0; i < 4 && a && a !== document.body; i++) {
          const members = cands.filter((x) => a.contains(x.b));
          const keys = new Set(members.map((x) => x.key));
          if (keys.size >= 2 && members.length <= 12) {
            if (!best || keys.size > new Set(best.members.map((x) => x.key)).size
              || (keys.size === new Set(best.members.map((x) => x.key)).size && best.root.contains(a) && a !== best.root)) {
              best = { root: a, members };
            }
            break;
          }
          a = a.parentElement;
        }
      }
      if (!best) return null;
      // 用 classList 精确 token（`hover:text-text-primary` 不算）；必须唯一，两个都像 active → 判不出
      const actives = [];
      for (const { key, b } of best.members) {
        let on = false;
        try { on = b.classList.contains('text-text-primary'); } catch (_) { on = false; }
        if (on || b.getAttribute('aria-selected') === 'true' || b.getAttribute('data-state') === 'active') actives.push(key);
      }
      const uniq = Array.from(new Set(actives));
      return uniq.length === 1 ? uniq[0] : null;
    } catch (_) { return null; }
  }

  /** 空态文案：确认开着 Friends only → 直说原因；判不出 → 带一句提醒；确认没开 → 原文案。 */
  function emptyScrapeHint(base, friendsOnly, bottomTab, translated) {
    if (translated) return tr('translated');   // v0.9.5：翻译把锚点全换掉了，其余判定都不可信
    if (bottomTab && bottomTab !== 'holders') return tr('bottomTab');   // 表被 Swaps/Thesis 顶掉：先切回来（Gickey D3 顺序）
    if (friendsOnly === true) return tr('friendsOn');
    if (friendsOnly === false) return base;
    return base + tr('friendsMaybe');
  }

  /** 抓取结果指纹：状态+数据一致就跳过重渲染（防阅读中闪烁/滚动跳动/翻译重跑，K3 审查建议）。 */
  function scrapeFingerprint(st) {
    try {
      return st.status + '|' + (st.holdersPresent ? 1 : 0)
        + '|' + (st.friendsOnly === true ? 'F' : st.friendsOnly === false ? 'f' : 'u') + '|' + (st.bottomTab || '-') + (st.translated ? '|T' : '')
        + '|' + JSON.stringify(st.data) + '|' + JSON.stringify(st.share || null) + '|' + JSON.stringify(st.feed || null);
    }
    catch (_) { return 'nofp:' + Date.now(); }   // 指纹算不出就当变了，宁可多画一次
  }

  function scanScrapers(seq, ca, chain) {
    if (!SITE.scrape) return;
    if (seq !== state.seq) return;
    const prevHolders = state.holders;
    const prevThesis = state.thesis;

    // K3 审查 F2：一轮只扫一遍 Holders 表，holders/thesis 共用（原先各扫一遍 + 列头再扫一遍）
    let rowEls = [];
    try { rowEls = collectHolderRows(); } catch (_) { rowEls = []; }
    // v0.9.10：整表只解析一次——前 6 名给 Holders 页，全表合计给「Fomo 持仓占比」
    let parsedAll = [];
    try { parsedAll = parseHoldersGuarded(rowEls); } catch (_) { parsedAll = []; }
    let holders = [];
    try { holders = topHolders(parsedAll); } catch (_) { holders = []; }
    let share = null;
    try { share = computeFomoShare(parsedAll); } catch (_) { share = null; }

    // v0.7.4：thesis 改读同一张 Holders 表的 "Thesis" 列。空态要分清两种情形——
    // 表压根没渲染出来（懒加载）→ 提示滚动 Holders 表；表在但没人写 thesis → 另一句话。
    // 用是否抓到 holder 行来判定（thesis 与 KOL 共用 collectHolderRows，同表同源）。
    const holdersPresent = holders.length > 0;
    let th = { rows: [], general: false };
    try { th = scrapeThesis(rowEls); } catch (_) { th = { rows: [], general: false }; }

    // 任一为空才需要侦测 Friends only / 底部标签（空态提示用；两个空态共用同一次侦测结果）
    const anyEmpty = !(holders.length && th.rows.length);
    const friendsOnly = anyEmpty ? friendsOnlyActive() : null;
    const bottomTab = anyEmpty ? fomoBottomTab() : null;
    const translated = anyEmpty ? pageTranslated() : false;
    lastScanAt = Date.now();

    // 抖动保护（v0.8.2）：这轮扫空、但本币已有成品数据 → 保留旧数据不清屏。
    // fomo 翻页/切自家 tab/虚拟滚动都可能让表暂时从 DOM 消失，不是"数据没了"。
    state.holders = holders.length
      ? { status: 'ready', data: holders, error: null, share }
      : (prevHolders && prevHolders.status === 'ready' ? prevHolders
        : { status: 'empty', data: null, error: null, friendsOnly, bottomTab, translated });
    const feed = (th && Array.isArray(th.feed)) ? th.feed : [];
    state.thesis = th.rows.length
      ? { status: 'ready', data: th.rows, error: null, general: th.general, holdersPresent: true, feed }
      : (prevThesis && prevThesis.status === 'ready'
        ? Object.assign({}, prevThesis, feed.length ? { feed } : null)
        : { status: 'empty', data: null, error: null, general: false, holdersPresent, friendsOnly, bottomTab, translated, feed });

    if (state.holders.status === 'ready' && state.thesis.status === 'ready' && feed.length) stopScrapers();

    const hFp = scrapeFingerprint(state.holders);
    const tFp = scrapeFingerprint(state.thesis);
    if (hFp !== state.scrapeFp.holders) { state.scrapeFp.holders = hFp; renderKol(); }
    if (tFp !== state.scrapeFp.thesis) { state.scrapeFp.thesis = tFp; renderThesis(); }
  }

  function startScrapers(seq, ca, chain) {
    if (!SITE.scrape) return;   // 页签都没长，观察者/定时器一个也别起
    stopScrapers();
    const run = () => scanScrapers(seq, ca, chain);
    run(); // 立刻扫一次（多半还没渲染出来）
    for (const ms of [800, 2000, 5000, 12000]) scrapeTimers.push(setTimeout(run, ms));
    try {
      scrapeObserver = new MutationObserver(() => {
        if (seq !== state.seq) { stopScrapers(); return; }
        if (observerDebounce) clearTimeout(observerDebounce);
        observerDebounce = setTimeout(run, 600);   // K3 F2：250→600ms，价格跳动别把主线程打成筛子
      });
      if (document.body) scrapeObserver.observe(document.body, { childList: true, subtree: true });
      // 主人切到 Holders/Feed 标签往往在开卡十几秒后，6 秒就撤观察者会白等；
      // 拉长到 25 秒，配合"刷新/重新开卡即重扫"，晚到的表格照样能被接住。
      scrapeTimers.push(setTimeout(stopScrapers, SCRAPE_WATCH_MS));
    } catch (_) { /* 无 MutationObserver 也能靠定时器兜底 */ }
  }

  /** 刷新钮 / 重新聚焦卡片：立刻重扫一次页面，不必等下一个 tick。 */
  let lastRescanAt = 0;
  function rescanNow(force) {
    if (!SITE.scrape) return;
    if (!state.open || !state.ca) return;
    const now = Date.now();
    if (!force && now - lastRescanAt < 2000) return; // 鼠标反复进出不该反复全页扫描
    lastRescanAt = now;
    startScrapers(state.seq, state.ca, state.chain);
  }

  // ---------- xxyy → fomo 登录态镜像 ----------
  // 数据仍由 fomo 自己的页面渲染，本扩展只把同一张表裁成卡片已经使用的字段。
  // 不读 cookie/localStorage，不回传 DOM/vnode，也不接收任意 URL。
  const FOMO_LOGIN_RE = /^(?:log\s*in|login|sign\s*in|connect\s*wallet|登录|登入|连接钱包)$/i;
  const FOMO_MIRROR_COUNT_RE = new RegExp('^\\s*' + alt(L10N.holders, true) + '\\s*[（(]\\s*([\\d,]+)\\s*[)）]\\s*$', 'i');
  const FOMO_MIRROR_ROUTE_SETTLE_MS = 700;
  let fomoMirrorRouteKey = '';
  let fomoMirrorRouteSince = 0;
  let fomoMirrorAuthKey = '';
  let fomoMirrorAuthStreak = 0;

  function visibleElement(el) {
    try {
      if (!el || !el.getClientRects || !el.getClientRects().length) return false;
      // getClientRects 已能挡住 display:none 的祖先；checkVisibility 再挡 content-visibility/
      // visibility 隐藏。旧 Chromium 不认识 options 时，保守回落到 rect + computed style。
      if (typeof el.checkVisibility === 'function') {
        try {
          if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
        } catch (_) { /* 旧实现继续走下面的兼容判断 */ }
      }
      const css = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
      return !css || (css.display !== 'none' && css.visibility !== 'hidden' && css.visibility !== 'collapse');
    } catch (_) { return false; }
  }

  function fomoLoginVisible() {
    try {
      let seen = 0;
      for (const el of document.querySelectorAll('button, a, [role="button"]')) {
        if (++seen > 4000) break;
        const t = oneLine(el.textContent);
        if (t.length <= 32 && FOMO_LOGIN_RE.test(t) && visibleElement(el)) return true;
      }
    } catch (_) { /* 判不出就继续等，不把故障冒充未登录 */ }
    return false;
  }

  /** 只用于识别明确的 Holders (0) 空表；正数但行没渲染时继续等。 */
  function fomoMirrorHolderCount() {
    let best = null; let activeBest = null;
    try {
      let seen = 0;
      for (const el of document.querySelectorAll('button, [role="tab"], div, span, h1, h2, h3')) {
        if (++seen > 8000) break;
        if (el.childElementCount > 2) continue;
        if (!visibleElement(el)) continue;
        const t = el.textContent || '';
        if (t.length > 32) continue;
        const m = FOMO_MIRROR_COUNT_RE.exec(t);
        if (!m) continue;
        const n = parseInt(m[1].replace(/,/g, ''), 10);
        if (!Number.isFinite(n) || n < 0) continue;
        if (best == null || n > best) best = n;
        const cls = String(el.className || '');
        const active = el.getAttribute('aria-selected') === 'true' || el.getAttribute('data-state') === 'active'
          || /(?:^|\s)(?:active|selected|on|text-text-primary)(?:\s|$)/.test(cls);
        if (active && (activeBest == null || n > activeBest)) activeBest = n;
      }
    } catch (_) { return null; }
    return activeBest == null ? best : activeBest;
  }

  /** 新开的专用后台页若记住了 Swaps/Thesis，切回 Holders；只点同组精确标签。 */
  function activateFomoHoldersForMirror() {
    try {
      const buttons = Array.from(document.querySelectorAll('button, [role="tab"]'));
      const holders = buttons.filter((b) => {
        const t = oneLine(b.textContent);
        return t.length <= 32 && TAB_HOLDERS_RE.test(t) && visibleElement(b);
      });
      for (const b of holders) {
        let root = b.parentElement;
        for (let up = 0; up < 5 && root && root !== document.body; up++, root = root.parentElement) {
          const group = buttons.filter((x) => root.contains(x)).map((x) => oneLine(x.textContent));
          const hasPeer = group.some((t) => TAB_SWAPS_RE.test(t)) || group.some((t) => TAB_THESIS_RE.test(t));
          if (!hasPeer) continue;
          if (fomoBottomTab() !== 'holders') b.click();
          return true;
        }
      }
    } catch (_) { /* 继续靠滚动/重试 */ }
    return false;
  }

  function prepareFomoMirrorPage() {
    activateFomoHoldersForMirror();
    try {
      const holders = Array.from(document.querySelectorAll('h1, h2, h3, div, button')).find((el) => {
        const t = oneLine(el.textContent);
        return t.length <= 32 && FOMO_MIRROR_COUNT_RE.test(t) && visibleElement(el);
      });
      if (holders && holders.scrollIntoView) holders.scrollIntoView({ block: 'center', behavior: 'auto' });
      else window.scrollTo(0, Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight));
    } catch (_) { /* 下一轮再试 */ }
  }

  const fomoChainKey = (v) => ({ sol: 'solana', bnb: 'bsc', eth: 'ethereum', robin: 'robinhood' }[String(v || '').toLowerCase()]
    || String(v || '').toLowerCase());
  const snapStr = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const snapshotHolder = (r) => ({
    handle: snapStr(r && r.handle, 32), positionUsd: snapStr(r && r.positionUsd, 32),
    avgEntry: snapStr(r && r.avgEntry, 32), pnl: snapStr(r && r.pnl, 32),
    pnlPos: r && r.pnlPos === true ? true : (r && r.pnlPos === false ? false : null),
    avgHold: snapStr(r && r.avgHold, 40),
  });
  const snapshotThesis = (r) => ({
    handle: snapStr(r && r.handle, 32), text: snapStr(r && r.text, 4000),
    url: safeHttps(r && r.url) || '', likes: Math.max(0, Math.min(1000000, Math.floor(Number(r && r.likes) || 0))),
    time: snapStr(r && r.time, 40),
    ageMin: r && r.ageMin != null && Number.isFinite(Number(r.ageMin)) && Number(r.ageMin) >= 0
      ? Math.min(5256000, Number(r.ageMin)) : null,
    positionUsd: snapStr(r && r.positionUsd, 32), pnl: snapStr(r && r.pnl, 32),
    pnlPos: r && r.pnlPos === true ? true : (r && r.pnlPos === false ? false : null),
  });

  /** Validate the actual position/cap ratio; a real tiny holding can round to 0.0%. */
  function snapshotFomoShare(r) {
    if (!r || typeof r !== 'object') return null;
    const pct = Number(r.pct); const sumUsd = Number(r.sumUsd); const mcUsd = Number(r.mcUsd);
    const counted = Math.floor(Number(r.counted));
    const totalRaw = r.total == null ? null : Math.floor(Number(r.total));
    if (!Number.isFinite(pct) || !Number.isFinite(sumUsd) || !Number.isFinite(mcUsd)
        || !Number.isFinite(counted) || !(pct >= 0 && pct <= 100 && sumUsd > 0 && mcUsd > 0 && counted > 0)) return null;
    const rawPct = sumUsd / mcUsd * 100;
    const roundedPct = Math.round(rawPct * 10) / 10;
    if (!(rawPct > 0 && rawPct <= 100) || pct !== roundedPct) return null;
    const total = Number.isFinite(totalRaw) && totalRaw >= counted ? totalRaw : null;
    return {
      pct: Math.round(pct * 10) / 10, sumUsd, mcUsd, mcSrc: snapStr(r.mcSrc, 16),
      counted, total, lower: r.lower === true || total == null || counted < total,
    };
  }

  function resetFomoMirrorAuth() {
    fomoMirrorAuthKey = '';
    fomoMirrorAuthStreak = 0;
  }

  /**
   * 后台每只币都新开独立 inactive tab，不复用上一只币的 SPA 文档；这里仍等路由稳定
   * 700ms，避免刚导航/重定向时拿到 hydration 中间态。
   */
  function fomoMirrorRouteSettled(ca, chain, here) {
    const key = chain + '|' + (isHex(ca) ? ca.toLowerCase() : ca);
    if (!here || !sameCa(here.ca, ca) || fomoChainKey(here.chain) !== chain) {
      fomoMirrorRouteKey = '';
      fomoMirrorRouteSince = 0;
      resetFomoMirrorAuth();
      return false;
    }
    if (fomoMirrorRouteKey !== key) {
      fomoMirrorRouteKey = key;
      fomoMirrorRouteSince = Date.now();
      resetFomoMirrorAuth();
      return false;
    }
    return Date.now() - fomoMirrorRouteSince >= FOMO_MIRROR_ROUTE_SETTLE_MS;
  }

  function buildFomoMirrorSnapshot(msg) {
    if (SITE.id !== 'fomo') return { status: 'unavailable' };
    const prepare = () => { if (msg && msg.readOnly !== true) prepareFomoMirrorPage(); };
    const ca = msg && typeof msg.ca === 'string' ? msg.ca.trim() : '';
    const chain = fomoChainKey(msg && msg.chain);
    if (!ADDR_RE.test(ca) || !chain) return { status: 'unavailable' };
    const here = parsePath(location.pathname);
    if (!fomoMirrorRouteSettled(ca, chain, here)) {
      prepare();
      return { status: 'pending' };
    }

    let rowEls = [];
    try { rowEls = collectHolderRows(); } catch (_) { rowEls = []; }
    if (!rowEls.length) {
      // 持仓行优先于登录按钮：Privy/页头可能残留 Connect Wallet，不能盖掉已登录的真表。
      // 真登录页还要 document complete + 连续两轮都看见精确按钮，hydration 闪一下不算。
      const loginVisible = document.readyState === 'complete' && fomoLoginVisible();
      const authKey = chain + '|' + (isHex(ca) ? ca.toLowerCase() : ca);
      if (loginVisible) {
        if (fomoMirrorAuthKey === authKey) fomoMirrorAuthStreak++;
        else { fomoMirrorAuthKey = authKey; fomoMirrorAuthStreak = 1; }
        if (fomoMirrorAuthStreak >= 2) return { status: 'auth_required' };
        prepare();
        return { status: 'pending' };
      }
      resetFomoMirrorAuth();
      const count = fomoMirrorHolderCount();
      if (document.readyState === 'complete' && count === 0) {
        return { status: 'ready', holders: [], thesis: [], feed: [], share: null };
      }
      prepare();
      return { status: 'pending' };
    }

    resetFomoMirrorAuth();
    let parsed = []; let thesis = { rows: [], feed: [] }; let share = null;
    try { parsed = parseHoldersGuarded(rowEls); } catch (_) { parsed = []; }
    try { thesis = scrapeThesis(rowEls); } catch (_) { thesis = { rows: [], feed: [] }; }
    try { share = computeFomoShare(parsed); } catch (_) { share = null; }
    if (!parsed.length) { prepare(); return { status: 'pending' }; }
    const feed = thesis && Array.isArray(thesis.feed) ? thesis.feed : [];
    return {
      status: 'ready',
      holders: topHolders(parsed).slice(0, HOLDER_SHOW).map(snapshotHolder),
      thesis: (thesis && Array.isArray(thesis.rows) ? thesis.rows : []).slice(0, THESIS_TAB_SHOW).map(snapshotThesis),
      thesisTotal: thesis && Array.isArray(thesis.rows) ? thesis.rows.length : 0,
      feed: feed.slice(0, 60).map(snapshotThesis),
      share: snapshotFomoShare(share),
    };
  }

  // ---------- 三个新段的渲染 ----------
  // ---------- 三个新段的渲染 ----------
  function kv(label, value, cls, title) {
    const row = h('div', { cls: 'kv' });
    if (title) row.setAttribute('title', title);
    // 空标签就别占那一列缩进，续行直接顶格
    if (nonEmpty(label)) row.appendChild(h('span', { cls: 'k', text: label }));
    row.appendChild(h('span', { cls: 'v' + (cls ? ' ' + cls : ''), text: value }));
    return row;
  }

  /** 只报最严重的一条红旗，不铺清单（卡片空间有限）。 */
  function worstFlag(sec) {
    if (!sec || typeof sec !== 'object') return '无红旗';
    if (sec.isHoneypot === true) return '蜜罐';
    if (Number(sec.canNotSell) > 0) return '不可卖 ' + Number(sec.canNotSell);
    if (Number(sec.sellTaxPct) > 0) return '卖税 ' + fracPct(sec.sellTaxPct);
    if (sec.liquidityLocked === false) return '流动性未锁';
    if (Number(sec.top10HolderPct) > 0.5) return '前十持仓 ' + fracPct(sec.top10HolderPct);
    // 买税不在给定的严重度序列里，但"有税"仍是买入前必须知道的事，不能报成"无红旗"
    if (Number(sec.buyTaxPct) > 0) return '买税 ' + fracPct(sec.buyTaxPct);
    if (Array.isArray(sec.flags)) {
      for (const f of sec.flags) if (nonEmpty(f)) return String(f).trim();
    }
    return '无红旗';
  }

  const clip = (str, n) => {
    const t = String(str || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  const numOr = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
  /** security 里的 *Pct 是小数(0.2491=24.91%)，kol.retentionPct 是百分数(67.07)。 */
  const fracPct = (v) => (numOr(Number(v), 0) * 100).toFixed(1) + '%';

  function breakdownTitle(bd) {
    if (!bd || typeof bd !== 'object') return '';
    return Object.keys(bd).map((k) => k + ' ' + bd[k]).join(' · ');
  }

  function isStale(iso) {
    const t = Date.parse(iso);
    return isFinite(t) && (Date.now() - t) > STALE_MS;
  }

  /** 自定义分析源那一段：只有用户配了 URL 模板才会出现。 */
  function renderAnalysis() {
    if (!els) return;
    const slot = els.slotAnalysis;
    slot.textContent = '';
    const st = state.analysis;

    // 没配分析源 = 这段在公开版里根本不存在
    if (st.status === 'disabled' || st.status === 'idle') return;

    if (st.status === 'loading') {
      slot.appendChild(h('div', { cls: 'grey', text: tr('aiLoading') }));
      return;
    }
    if (st.status === 'absent') {
      slot.appendChild(h('div', { cls: 'grey', text: FRIENDLY.absent }));
      return;
    }
    if (st.status === 'error') {
      slot.appendChild(h('div', { cls: 'grey',
        text: FRIENDLY[ANALYSIS_ERR[st.kind]] || FRIENDLY.analysis }));
      return;
    }
    if (st.status !== 'ready' || !st.data) return;

    const d = st.data;
    const v = d.verdict || {};
    const q = d.quant || {};
    const nar = d.narrative || {};
    const box = h('div', { cls: 'analysis' });
    const stale = isStale(d.updatedAt);
    if (stale) box.classList.add('stale');

    box.appendChild(h('div', { cls: 'sechead' },
      [h('span', { cls: 'sectitle', text: tr('ai') })]));

    if (nonEmpty(v.oneLiner)) {
      box.appendChild(h('div', { cls: 'oneliner', text: v.oneLiner.trim() }));
    }

    // meme 点：这币的梗到底是什么。自家/自配中文内容，不进翻译登记。
    if (nonEmpty(nar.memeHook)) {
      const row = h('div', { cls: 'kv memehook' });
      row.appendChild(h('span', { cls: 'k', text: tr('memeHook') }));
      row.appendChild(textBlock(nar.memeHook.trim(), false, MEME_CLAMP));
      box.appendChild(row);
    }

    const badges = h('div', { cls: 'badges' });
    if (nonEmpty(v.label)) {
      badges.appendChild(h('span', {
        cls: 'badge ' + (LABEL_TONE[v.label] || 'warn'),
        text: LABEL_TEXT[v.label] || String(v.label).trim(), // 没见过的档位原样显示
      }));
    }
    const score = Number(v.score);
    if (isFinite(score)) {
      badges.appendChild(h('span', {
        cls: 'badge score', text: Math.round(score) + '/100',
        title: breakdownTitle(v.scoreBreakdown),
      }));
    }
    if (badges.childNodes.length) box.appendChild(badges);

    // 技术三态 + 最严重的一条红旗，合并成一行；技术细节收进 tooltip
    const tech = nar.tech || {};
    const techMap = { running: '跑得起来', announced: '只宣布未落地', none: '没有技术面', na: '不适用' };
    const sec = q.security || {};
    const worst = worstFlag(sec);
    if (nonEmpty(tech.status) || Object.keys(sec).length) {
      const techLabel = nonEmpty(tech.status) ? (techMap[tech.status] || tech.status) : '未知';
      box.appendChild(kv(tr('techFlags'),
        techLabel + ' · 红旗 ' + worst,
        worst === '无红旗' ? 'ok-line' : 'flags',
        nonEmpty(tech.detail) ? clip(tech.detail, 220) : ''));
    }

    // meta：更新时间 +（配了详情模板才有的）完整分析链接
    const meta = h('div', { cls: 'dmeta' });
    if (nonEmpty(d.mode)) meta.appendChild(h('span', { text: String(d.mode).trim() + tr('tier') }));
    if (nonEmpty(d.updatedAt)) {
      meta.appendChild(h('span', { text: tr('updatedAt') + relTime(d.updatedAt), title: absTime(d.updatedAt) }));
    }
    const detail = buildFromTemplate(settings.detailTemplate, state.ca);
    if (detail) {
      meta.appendChild(h('span', { cls: 'spacer' }));
      meta.appendChild(h('a', {
        text: tr('fullReport'), href: detail,
        attrs: { target: '_blank', rel: 'noopener noreferrer' },
      }));
    }
    if (meta.childNodes.length) box.appendChild(meta);

    if (stale) {
      box.appendChild(h('div', { cls: 'muted', text: tr('stale') }));
    }
    slot.appendChild(box);
  }

  function appendFomoLink(body, rawUrl, label) {
    const url = safeFomoPayloadUrl(rawUrl, true);
    if (!url) return;
    body.appendChild(h('a', {
      cls: 'rlink', text: label, href: url,
      attrs: { target: '_blank', rel: 'noopener noreferrer' },
    }));
  }

  /** 登录态缺失与临时读取失败是两种明确状态；两者都 fail-closed，不画空持仓/0%。 */
  function renderFomoMirrorGate(body, st) {
    if (!st || st.source !== 'fomo-mirror') return false;
    if (st.status !== 'auth_required' && st.status !== 'unavailable') return false;
    const auth = st.status === 'auth_required';
    body.appendChild(h('div', { cls: 'grey', text: auth ? tr('fomoLogin') : tr('fomoUnavailable') }));
    appendFomoLink(body, st.fomoUrl, auth ? tr('fomoLoginAction') : tr('fomoOpenAction'));
    return true;
  }

  function renderUnresolvedPool(body) {
    if (!state.resolveFailed || !isXxyyPoolRef(state.ca)) return false;
    body.textContent = '';
    body.appendChild(h('div', { cls: 'grey', text: tr('resolveTokenFailed') }));
    return true;
  }

  /**
   * 持仓者页（v0.8 第三个标签）：渲染从页面 DOM 抓来的持仓行。
   * 标签页本身就是容器，段级折叠已移除；渲染不看标签是否可见，切过去内容已在。
   */
  function renderKol() {
    if (!els) return;
    const body = els.slotKol;
    body.textContent = '';
    const st = state.holders;
    const rows = (st.status === 'ready' && Array.isArray(st.data)) ? st.data : [];
    setTabCount('holders', rows.length);
    renderShare();   // v0.9.10：与持仓表同源同步，表变它就变

    if (renderUnresolvedPool(body) || renderFomoMirrorGate(body, st)) return;
    if (st.status === 'scanning' || st.status === 'idle') {
      // 首扫多半空，别急着显示灰字；等重扫。仍占位一行淡字。
      body.appendChild(h('div', { cls: 'grey', text: state.resolving ? tr('resolvingToken') : SITE.fomoMirror ? tr('fomoReading') : tr('readingHolders') }));
      return;
    }
    if (!rows.length) {
      if (st.source === 'fomo-mirror') {
        body.appendChild(h('div', { cls: 'grey', text: tr('fomoNoHolders') }));
        appendFomoLink(body, st.fomoUrl, tr('fomoOpenAction'));
        return;
      }
      body.appendChild(h('div', { cls: 'grey',
        text: emptyScrapeHint(tr('scrollHolders'), st.friendsOnly, st.bottomTab, st.translated) }));
      body.appendChild(diagButton());
      return;
    }

    // v0.9.10：页顶一行合计（头部那行的详细版：合计 / 市值 / 榜单覆盖）
    if (st.share) {
      body.appendChild(h('div', { cls: 'share-sum', title: tr('shareTip') }, [
        h('span', { text: tr('shareLabel') + ' ' }),
        h('span', { cls: 'share-pct ' + st.share.tier, text: sharePctText(st.share) }),
        h('span', { text: ' · ' + shareDetail(st.share) }),
      ]));
    }

    // 行格式（v0.8.8 主人定稿）：@名字 · $仓位 ▲盈亏% · 持有 2d 4h ——
    // 成本撤出行内（挤到换行了），收进整行的悬停提示；代币数量照旧不显示。
    for (const r of rows) {
      const item = h('div', { cls: 'row-item' });
      if (nonEmpty(r.avgEntry)) item.setAttribute('title', tr('cost') + r.avgEntry);
      const rh = h('div', { cls: 'rhead' });
      const dot = () => h('span', { cls: 'sep', text: '·' });
      // 认不出作者就整个 chip 不出现，绝不编一个"@匿名"糊弄主人
      if (nonEmpty(r.handle)) rh.appendChild(h('span', { cls: 'rauthor', text: '@' + r.handle }));
      if (nonEmpty(r.positionUsd)) {
        if (rh.childNodes.length) rh.appendChild(dot());
        rh.appendChild(h('span', { cls: 'rval', text: r.positionUsd }));
      }
      if (nonEmpty(r.pnl)) {
        rh.appendChild(h('span', { cls: 'pnl' + pnlToneCls(r.pnlPos), text: r.pnl }));
      }
      // v0.8.4：持仓时长回归显示（主人 2026-09-02 要求；v0.7 曾按要求去掉）
      if (nonEmpty(r.avgHold)) {
        rh.appendChild(dot());
        rh.appendChild(h('span', { cls: 'rtime', text: tr('held') + r.avgHold }));
      }
      item.appendChild(rh);
      body.appendChild(item);
    }
  }

  // ---- Fomo 持仓占比渲染（v0.9.10）：头部独占一行，Holders 页顶再给详细版 ----
  function sharePctText(sh) {
    return (sh.lower ? '≥' : '') + sh.pct.toFixed(1) + '%';
  }
  function shareDetail(sh) {
    const cover = sh.total != null ? (sh.counted + '/' + sh.total) : String(sh.counted);
    return tr('shareTotal') + fmtUsdShort(sh.sumUsd) + tr('shareMc') + fmtUsdShort(sh.mcUsd) + ' · ' + tr('shareCover') + cover;
  }
  function fmtUsdShort(v) {
    const n = Number(v) || 0;
    const f = (x, d) => x.toFixed(d).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
    if (n >= 1e9) return '$' + f(n / 1e9, 2) + 'B';
    if (n >= 1e6) return '$' + f(n / 1e6, 2) + 'M';
    if (n >= 1e3) return '$' + f(n / 1e3, 1) + 'K';
    return '$' + Math.round(n);
  }
  function renderShare() {
    if (!els || !els.shareRow) return;
    const row = els.shareRow;
    row.textContent = '';
    const sh = state.holders && state.holders.share;
    if (!HAS_FOMO_DATA || !sh) { row.hidden = true; return; }
    row.appendChild(h('span', { cls: 'share-k', text: tr('shareLabel') }));
    row.appendChild(h('span', { cls: 'share-pct ' + sh.tier, text: sharePctText(sh) }));
    if (sh.tier !== 'low') row.appendChild(h('span', { cls: 'share-tag ' + sh.tier, text: sh.tier === 'strong' ? '★★' : '★' }));
    row.appendChild(h('span', { cls: 'share-sub', text: shareDetail(sh) }));
    row.title = tr('shareTip');
    row.hidden = false;
  }

  /** 盈亏配色三分支：true 绿 / false 红 / 判不出方向不配色（不许默认当赚，K3 审查修正）。 */
  function pnlToneCls(pnlPos) {
    if (pnlPos === true) return ' pos';
    if (pnlPos === false) return ' neg';
    return '';
  }

  /** 抽出正文里的 https 链接（去重，保序）。 */
  function urlsIn(text) {
    const out = [];
    const str = String(text || '');
    URL_IN_TEXT_RE.lastIndex = 0;
    let m;
    while ((m = URL_IN_TEXT_RE.exec(str)) !== null) {
      if (out.indexOf(m[0]) === -1) out.push(m[0]);
      if (URL_IN_TEXT_RE.lastIndex === m.index) URL_IN_TEXT_RE.lastIndex++;
    }
    return out;
  }

  /** https://x.com/foo/status/123 → "x.com/foo" 这种短标签。 */
  function linkLabel(url) {
    try {
      const u = new URL(url);
      const seg = u.pathname.split('/').filter(Boolean)[0];
      return u.hostname.replace(/^www\./, '') + (seg ? '/' + seg : '');
    } catch (_) { return url.slice(0, 28); }
  }

  /**
   * 长文本折叠 + 链接保底。
   * 精选后正文被裁短，但主人明确要"带推特链接就要能跳" ——
   * 所以被裁掉那段里的链接，仍以短链片形式挂在末尾，不必展开就能点。
   */
  function textBlock(text, register, clampAt) {
    const limit = clampAt || THESIS_CLAMP;
    const wrap = h('div', { cls: 'rtext' });
    const full = String(text || '');
    let expanded = full.length <= limit;
    const paint = () => {
      wrap.textContent = '';
      const shown = expanded ? full : full.slice(0, limit) + '…';
      linkifyInto(wrap, shown, register);
      if (!expanded) {
        const visible = urlsIn(shown);
        const hidden = urlsIn(full).filter((u) => visible.indexOf(u) === -1).slice(0, 2);
        for (const u of hidden) {
          wrap.appendChild(h('a', {
            cls: 'chiplink', text: '↗ ' + linkLabel(u), href: u, title: u,
            attrs: { target: '_blank', rel: 'noopener noreferrer' },
          }));
        }
      }
      if (full.length > limit) {
        wrap.appendChild(h('button', {
          cls: 'more', text: expanded ? tr('less') : tr('more'), attrs: { type: 'button' },
          on: { click: () => { expanded = !expanded; paint(); } },
        }));
      }
    };
    paint();
    return wrap;
  }

  /**
   * {ca} 模板 → 实际 URL；只接受 https 公网地址。
   * 详情页虽然只是个可点链接（扩展自己不发请求），但也不该把内网地址渲染进卡片，
   * 与后台分析源保持同一条准入线。
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

  function isPublicHttpsUrl(url) {
    let u;
    try { u = new URL(url); } catch (_) { return false; }
    if (u.protocol !== 'https:') return false;
    return isPublicHostname(u.hostname);
  }

  function buildFromTemplate(template, ca) {
    const t = String(template || '').trim();
    if (!t || t.indexOf('{ca}') === -1 || !ca) return null;
    const key = isHex(ca) ? ca.toLowerCase() : ca;
    const url = t.split('{ca}').join(encodeURIComponent(key));
    // 详情页只是个可点链接（扩展不发请求），但仍与后台分析源同一条准入线：
    // 默认只认 https 公网；开了高级开关才允许 http/内网自建详情页。
    if (settings.allowPrivateAnalysisSource) return /^https?:\/\//i.test(url) ? url : null;
    return isPublicHttpsUrl(url) ? url : null;
  }

  /**
   * 观点页（v0.8 第二个标签，原「Thesis 精选」段整体迁移）：持有人对这只币写的 thesis，
   * 按点赞降序全量列出（fomo 自家观点流的排法），不再只取前 2。
   * 行头跟 fomo 一样带上这位持有人的仓位与盈亏（同一张 Holders 表里顺手解析，抓不到就不显示）。
   * v0.7.4：数据源为 Holders 表的 "Thesis" 列（token-specific，稳定），不读左栏 Feed。
   * v0.7.3：段内无译按钮/翻译提示条——翻译只由头部 中/EN 钮统一控制。
   */
  function renderThesis() {
    if (!els) return;
    const body = els.slotThesis;
    body.textContent = '';
    const st = state.thesis;
    const rows = (st.status === 'ready' && Array.isArray(st.data)) ? st.data : [];
    const totalCount = st.source === 'fomo-mirror' && Number.isSafeInteger(st.totalCount)
      && st.totalCount >= rows.length ? st.totalCount : rows.length;
    setTabCount('views', totalCount);

    if (renderUnresolvedPool(body) || renderFomoMirrorGate(body, st)) return;
    if (st.status === 'scanning' || st.status === 'idle') {
      body.appendChild(h('div', { cls: 'grey', text: state.resolving ? tr('resolvingToken') : SITE.fomoMirror ? tr('fomoReading') : tr('readingTable') }));
      return;
    }
    if (!rows.length) {
      if (st.source === 'fomo-mirror') {
        body.appendChild(h('div', { cls: 'grey', text: st.holdersPresent ? tr('noThesis') : tr('fomoNoHolders') }));
        appendFomoLink(body, st.fomoUrl, tr('fomoOpenAction'));
        return;
      }
      // 表在但没人写 thesis → 一句话；表压根没渲染（懒加载）→ 与持仓者同一句"滚到可见"
      body.appendChild(h('div', { cls: 'grey', text: emptyScrapeHint(st.holdersPresent
        ? tr('noThesis')
        : tr('scrollTable'), st.friendsOnly, st.bottomTab, st.translated) }));
      body.appendChild(diagButton());   // K3 #12："没人写 thesis" 也是用户会来报的状态
      return;
    }

    // v0.8.7 排序切换：按赞（默认）| 最新（只列 ≥2 赞且配到发言时间的，时间新→旧）
    const sortBtn = (key, label) => h('button', {
      cls: 'sbtn' + (state.thesisSort === key ? ' on' : ''), text: label, attrs: { type: 'button' },
      on: { click: () => { if (state.thesisSort !== key) { state.thesisSort = key; renderThesis(); } } },
    });
    body.appendChild(h('div', { cls: 'sortrow' },
      [sortBtn('likes', tr('sortLikes')), sortBtn('time', tr('sortTime'))]));

    // 最新档（v0.8.9 重做）：数据源直接换成 fomo 自家评论流——它天生带时间/正文/点赞/持仓，
    // 且"最新"本来就该看它；按赞档继续用 Holders 表全量。评论流只渲染最新一段，没开过
    // 那个 tab 就是空的，占位说明白。
    let shown = rows;
    if (state.thesisSort === 'time') {
      const feed = Array.isArray(st.feed) ? st.feed : [];
      shown = feed
        .filter((r) => (r.likes || 0) >= 2 && r.ageMin !== null)
        .slice()
        .sort((a, b) => a.ageMin - b.ageMin);
      if (!shown.length) {
        body.appendChild(h('div', { cls: 'grey',
          text: feed.length
            ? tr('feedNoLikes')
            : tr('feedMissing') }));
        rescanNow();   // 主人多半刚开完评论页切回来，顺手补扫一次
        return;
      }
    }

    for (const row of shown.slice(0, THESIS_TAB_SHOW)) {
      const item = h('div', { cls: 'row-item' });
      const rh = h('div', { cls: 'rhead' });
      if (nonEmpty(row.handle)) rh.appendChild(h('span', { cls: 'rauthor', text: '@' + row.handle }));
      if (row.likes) rh.appendChild(h('span', { cls: 'rlikes', text: '♥ ' + row.likes }));
      // 发言时间：评论流对上号才有（见 scrapeThesisTimes），配不上就不显示
      if (nonEmpty(row.time)) rh.appendChild(h('span', { cls: 'rtime', text: row.time }));
      // fomo 观点流同款：作者旁给这位持有人的仓位与盈亏（同表解析，解析不出就不占位）
      if (nonEmpty(row.positionUsd) || nonEmpty(row.pnl)) {
        rh.appendChild(h('span', { cls: 'spacer' }));
        if (nonEmpty(row.positionUsd)) rh.appendChild(h('span', { cls: 'rval', text: row.positionUsd }));
        if (nonEmpty(row.pnl)) {
          rh.appendChild(h('span', { cls: 'pnl' + pnlToneCls(row.pnlPos), text: row.pnl }));
        }
      }
      item.appendChild(rh);
      item.appendChild(textBlock(row.text, true, THESIS_CLAMP));
      body.appendChild(item);
    }
    // 角标报的是真实条数；超上限时明说截断了，不许"看着像全量"
    const shownCount = state.thesisSort === 'time' ? shown.length : totalCount;
    if (shownCount > THESIS_TAB_SHOW) {
      body.appendChild(h('div', { cls: 'muted',
        text: (state.thesisSort === 'time' ? tr('capNewest') : tr('capLikes'))
          + THESIS_TAB_SHOW + tr('capTail') + shownCount + tr('capEnd') }));
    }
    refreshLangBtn();
    translation.autoEnable();
  }

  /**
   * 来源推文整段默认折叠：主人极少看原始推文，
   * "是不是机器人刷的"这个问题 DeBot 的评级理由已经回答了。
   */
  function renderTweets() {
    if (!els) return;
    const slot = els.slotTweets;
    slot.textContent = '';
    const st = state.tweets;
    if (st.status === 'idle' || st.status === 'empty') return;

    const total = (state.history && Array.isArray(state.history.source_tweets))
      ? state.history.source_tweets.length : 0;
    // full 布局默认展开，compact/预览默认收起；用户手动开合写回 state 以跨重渲染保持
    const det = h('details', { cls: 'sec tweets', attrs: state.tweetsOpen ? { open: '' } : {} });
    listen(det, 'toggle', () => { state.tweetsOpen = det.open; });
    det.appendChild(h('summary', {
      cls: 'sectitle',
      text: tr('tweets') + (total ? tr('tweetsN') + total + tr('tweetsNEnd') : ''),
    }));

    if (st.status === 'loading') {
      det.appendChild(h('div', { cls: 'grey', text: tr('loading') }));
      slot.appendChild(det);
      return;
    }
    if (!Array.isArray(st.data) || !st.data.length) {
      det.appendChild(h('div', { cls: 'grey', text: FRIENDLY.tweets }));
      slot.appendChild(det);
      return;
    }

    const tweetRow = (t) => {
      const item = h('div', { cls: 'row-item' });
      const rh = h('div', { cls: 'rhead' });
      if (nonEmpty(t.author)) rh.appendChild(h('span', { cls: 'rauthor', text: '@' + t.author }));
      if (nonEmpty(t.authorName) && t.authorName !== t.author) {
        rh.appendChild(h('span', { cls: 'rtime', text: t.authorName }));
      }
      rh.appendChild(h('span', { cls: 'spacer' }));
      rh.appendChild(h('a', {
        cls: 'rlink', text: tr('openTweet'),
        href: safeHttps(t.url) || ('https://x.com/i/status/' + t.id),
        attrs: { target: '_blank', rel: 'noopener noreferrer' },
      }));
      item.appendChild(rh);
      item.appendChild(textBlock(t.text, true, TWEET_CLAMP));
      return item;
    };

    st.data.slice(0, TWEET_SHOW).forEach((t) => det.appendChild(tweetRow(t)));

    const rest = st.data.slice(TWEET_SHOW);
    if (rest.length) {
      const more = h('details', { cls: 'more-block' },
        [h('summary', { text: tr('moreTweets') + rest.length + ')' })]);
      rest.forEach((t) => more.appendChild(tweetRow(t)));
      det.appendChild(more);
    }

    slot.appendChild(det);
    refreshLangBtn();
    translation.autoEnable();
  }

  // ---------- URL 监听 ----------
  function parsePath(pathname) {
    let path = String(pathname || '');
    // 容忍传进来带 query/hash，或干脆是整条 URL
    try {
      if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
    } catch (_) { /* 忽略 */ }
    path = path.split('?')[0].split('#')[0];
    const m = TOKEN_PATH_RE.exec(path);
    if (!m) return null;
    if (SITE.id === 'xxyy' && !ADDR_RE.test(m[2]) && !XXYY_POOL_ID_RE.test(m[2])) return null;
    // 路径链 slug → DexScreener chainId（xxyy: sol→solana / eth→ethereum；没映射的原样透传）
    const slug = String(m[1]).toLowerCase();
    return { chain: (SITE.chainMap && SITE.chainMap[slug]) || slug, ca: m[2] };
  }

  /**
   * v0.9.10：URL 代币 → 开卡的唯一入口（自动弹出 / 轮询换币 / 点链接快切 / 圆钮 / 预览退场都走这里）。
   * fomo 直接开；xxyy 这类站点（SITE.resolveAddr）URL 上挂的是池子地址（实测 /sol/<mint> 会被
   * 302 成 /sol/<pool>），DeBot / DexScreener 都按代币 CA 取数，所以先让后台反解一次再开卡。
   * 反解失败就按原地址开（DeBot 会如实说未收录），绝不让卡片因为反解挂掉而不出现。
   */
  const resolveCache = new Map();   // 'chain|addr' → 代币 CA（content script 存活期内）
  // URL 自动开卡与悬停预览是两条独立 lane：悬停绝不能取消尚在反解的当前 URL。
  const resolveSeq = { url: 0, preview: 0 };
  /**
   * v0.9.12：URL 开卡与悬停预览共用同一条"先反解再 load"的路（mode = 'url' | 'preview'）。
   * 预览分支的过期判定看 hoverPendingCa——等反解那几百毫秒里鼠标已经离开这一行，就别再把卡弹出来。
   */
  function openToken(tok, mode, force = false) {
    if (!tok || !tok.ca) return;
    const lane = mode === 'preview' ? 'preview' : 'url';
    // 站点不需要反解、或这条命中本来就是代币 CA（Vue 探针读到 tokenAddress）→ 直接开
    if (!SITE.resolveAddr || (tok.resolved && ADDR_RE.test(tok.ca))) {
      resolveSeq[lane]++;
      state.resolveFailed = false;
      state.srcAddr = tok.ca;
      load(tok.ca, tok.chain, mode, force);
      return;
    }
    const key = String(tok.chain || '') + '|' + (isHex(tok.ca) || isXxyyPoolRef(tok.ca) ? tok.ca.toLowerCase() : tok.ca);
    const hit = resolveCache.get(key);
    if (hit) {
      resolveSeq[lane]++;
      state.resolveFailed = false;
      state.srcAddr = tok.ca;
      load(hit, tok.chain, mode, force);
      return;
    }
    const my = ++resolveSeq[lane];
    state.resolveFailed = false;
    state.srcAddr = tok.ca;
    load(tok.ca, tok.chain, mode, false, true);
    const displaySeq = state.seq;
    requestResolve(tok.ca, tok.chain, (resp) => {
      if (my !== resolveSeq[lane]) return;                             // 同一 lane 已经换币
      if (mode === 'url' && !sameToken(urlToken, tok)) return;         // 等反解期间已离开/切链/换币
      if (mode === 'preview' && !sameToken({ ca: hoverPendingCa, chain: hoverPendingChain }, tok)) return;
      const ok = !!(resp && resp.ok && resp.payload && typeof resp.payload.ca === 'string' && ADDR_RE.test(resp.payload.ca));
      const ca = ok ? resp.payload.ca : tok.ca;
      // Kimi 审查 F1：反解失败（网络抖动/后台无响应）按原地址开卡但**不缓存**，下次换币/↻ 重新反解
      if (ok) {
        if (resolveCache.size > 200) resolveCache.clear();
        resolveCache.set(key, ca);
      }
      // Keep the resolved identity for later, but a newer preview owns the visible card.
      if (state.seq !== displaySeq) return;
      state.resolveFailed = !ok;
      state.srcAddr = tok.ca;
      if (!ok && isXxyyPoolRef(tok.ca)) {
        state.resolving = false;
        state.status = 'error';
        state.holders = { status: 'error', data: null, error: null };
        state.thesis = { status: 'error', data: null, error: null };
        state.pairs = { status: 'error', data: null, error: null };
        state.analysis = { status: 'disabled', data: null, error: null };
        paintChrome(); paintHeader(); renderPairs(); renderDebot(); renderKol(); renderThesis(); renderAnalysis();
        return;
      }
      load(ca, tok.chain, mode, force);
    });
  }
  const openFromUrl = (tok) => openToken(tok, 'url');

  function onUrlMaybeChanged() {
    const next = parsePath(location.pathname);
    const changed = !((!next && !urlToken) || sameToken(next, urlToken));
    if (!changed) return;
    cancelHoverDwell();
    resolveSeq.url++;
    resolveSeq.preview++;
    urlToken = next;

    // 离开代币页：卡片上那只旧币已经不是"当前聚焦的币"了，别继续摆着
    if (!next) {
      if (state.open && !state.pinned) closeCard();
      return;
    }
    if (autoOpenEnabled() || state.open) openFromUrl(next);
  }

  /**
   * 点击左栏代币行/任何 /tokens/ 链接：不等那 250ms 轮询，立刻切到新币。
   * 这是"进新币先看到上一只币"的主路径修复——轮询只是兜底。
   */
  function fastSwitchFromClick(target, event) {
    let a = null;
    try { a = target.closest && target.closest(SITE.tokenLinkSel); } catch (_) { return false; }
    if (!a) return false;
    if ((event && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0))
        || (a.target && a.target.toLowerCase() !== '_self') || a.hasAttribute('download')) return false;
    const hit = anchorToken(a);
    if (!hit || !hit.ca) return false;
    // 已经是这只币（xxyy 上 URL 挂的是池子地址，与反解后的 state.ca 不同，所以拿 srcAddr 比）
    if (state.open && state.mode === 'url' && isCurrentToken(hit)) return true;
    urlToken = hit;
    if (autoOpenEnabled() || state.open) openFromUrl(hit);
    return true;
  }

  function installUrlWatcher() {
    // 注：线上 content script 处于 isolated world，此处的补丁拦不到页面自身的
    // pushState 调用，真正兜底的是下面的轮询；补丁只在同世界注入时（测试）生效。
    try {
      for (const fn of ['pushState', 'replaceState']) {
        const orig = history[fn];
        if (typeof orig !== 'function' || orig.__fomoDebotPatched) continue;
        const patched = function () {
          const r = orig.apply(this, arguments);
          try { window.dispatchEvent(new CustomEvent(LOC_EVENT)); } catch (_) {}
          return r;
        };
        patched.__fomoDebotPatched = true;
        history[fn] = patched;
      }
    } catch (_) { /* 忽略 */ }

    listen(window, LOC_EVENT, onUrlMaybeChanged);
    listen(window, 'popstate', onUrlMaybeChanged);
    // Reuse the navigation tick: GMGN's tracker can mount after the card or be
    // resized independently. Only an un-dragged card follows its actual bounds.
    setInterval(() => { onUrlMaybeChanged(); refreshGmgnDock(); }, URL_POLL_MS);
  }

  // ---------- 悬停解析 ----------
  function anchorToken(a) {
    try {
      const u = new URL(a.getAttribute('href') || '', location.href);
      if (u.origin !== location.origin) return null;
      return parsePath(u.pathname);
    } catch (_) { return null; }
  }

  /**
   * 策略 a（主路）：锚点。命中 6 层祖先内的 /tokens/<chain>/<ca> 链接。
   * 关键约束：某一层若同时含多个不同代币链接，说明它是"列表容器"而不是"行"，
   * 此时宁可解析不出，也绝不拿第一个链接顶包（否则悬停任意空白处都会误报邻行的币）。
   */
  function resolveByAnchor(target) {
    const direct = target.closest && target.closest(SITE.tokenLinkSel);   // v0.9.11：链接形状按站点表走（fomo 仍是 /tokens/）
    if (direct) {
      const hit = anchorToken(direct);
      if (hit) return hit;
    }
    let node = target;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      if (node.matches && node.matches(SITE.tokenLinkSel)) {
        const hit = anchorToken(node);
        if (hit) return hit;
      }
      if (!node.querySelectorAll) continue;
      const found = [];
      const seen = Object.create(null);
      for (const a of node.querySelectorAll(SITE.tokenLinkSel)) {
        const hit = anchorToken(a);
        if (!hit) continue;
        const key = hit.chain + '|' + (isHex(hit.ca) ? hit.ca.toLowerCase() : hit.ca);
        if (seen[key]) continue;
        seen[key] = 1;
        found.push(hit);
      }
      if (found.length === 1) return found[0];
      if (found.length > 1) return null; // 歧义容器 → 交给 fiber 或直接放弃
    }
    return null;
  }

  /**
   * 策略 b：React fiber 探针（仅在锚点无果时使用）。
   * 线上实测坑：朴素扫描会先撞到 value.fomoUser.address 这类"用户钱包地址"。
   * 故：① 键名像人（user/wallet/profile/owner/creator/follower/account）→ 整棵子树跳过；
   *     ② 只有自身或直接父键像币（token/ca/contract/pair/coin/mint/address）才收；
   *     ③ 路径上出现过人味键名 → 一律不收；全场只有人味命中 → 解析为空。
   */
  function scanProps(obj, path, depth, hits) {
    if (!obj || typeof obj !== 'object' || depth > 3 || hits.length) return;
    let keys;
    try { keys = Object.keys(obj); } catch (_) { return; }
    for (const key of keys) {
      if (USERISH_RE.test(key)) continue; // ① 人味子树整体跳过
      let val;
      try { val = obj[key]; } catch (_) { continue; }
      if (typeof val === 'string') {
        if (!ADDR_RE.test(val)) continue;
        const parentKey = path.length ? path[path.length - 1] : '';
        const tokenish = TOKENISH_RE.test(key) || TOKENISH_RE.test(parentKey);
        const userishPath = path.some((p) => USERISH_RE.test(p));
        if (tokenish && !userishPath) { hits.push(val); return; } // ②③
        continue;
      }
      if (val && typeof val === 'object' && depth < 3) {
        scanProps(val, path.concat(key), depth + 1, hits);
        if (hits.length) return;
      }
    }
  }

  function resolveByFiber(target) {
    let holder = null, fiberKey = null;
    let node = target;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      let keys;
      try { keys = Object.keys(node); } catch (_) { keys = []; }
      const k = keys.find((x) => x.indexOf('__reactFiber') === 0);
      if (k) { holder = node; fiberKey = k; break; }
    }
    if (!holder) return null;

    let fiber;
    try { fiber = holder[fiberKey]; } catch (_) { return null; }

    const hits = [];
    for (let up = 0; up < 12 && fiber; up++) {
      try { scanProps(fiber.memoizedProps, [], 0, hits); } catch (_) { /* 忽略 */ }
      if (hits.length) break;
      try { fiber = fiber.return; } catch (_) { break; }
    }
    return hits.length ? { chain: null, ca: hits[0] } : null;
  }

  function resolveHovered(target, clientX) {
    if (!SITE.hover) return null;   // 悬停解析按 fomo 版式调的（左侧区域限定 + fiber 探针），别的站不开
    if (!target || !target.closest) return null;
    // 只在左侧区域做解析，避免全页扫描开销
    if (clientX >= window.innerWidth * (SITE.hoverZone || LEFT_ZONE_RATIO)) return null;   // 悬停区按站点表（xxyy/gmgn 左栏更宽）
    // 页脚 / 导航里的 /tokens/ 快捷链接（BTC、SOL 行情位）不是"聚焦的币"
    if (target.closest('footer, nav, [role="navigation"]')) return null;
    if (SITE.hover === 'anchor' || SITE.hover === 'gmgn-react') return resolveByAnchor(target);
    // 真扩展里 content script 在 ISOLATED world，直读 #app._vnode 永远是空。
    // 只有 main-world 测试夹具保留同步探针；生产走 background + scripting MAIN 的坐标探针。
    if (SITE.hover === 'vue') return resolveByAnchor(target) || (TEST ? resolveByVue(target) : null);
    return resolveByAnchor(target) || resolveByFiber(target);
  }

  /** 悬停目标 → 它所属的"行"容器（行内所有子元素共享同一个），用来判断是否换了行。 */
  function hoverRowOf(target) {
    try {
      if (SITE.hover === 'vue') { const vr = stableXxyyRow(target); if (vr) return vr; }
      if (SITE.rowSel && target.closest) { const r = target.closest(SITE.rowSel); if (r) return r; }   // v0.9.12：站点给了行选择器就按整行算
      return (target.closest && target.closest('a, li, tr, div')) || target;
    } catch (_) { return target; }
  }

  // ---------- 策略 c：Vue 3 vnode 树探针（v0.9.12，xxyy）----------
  // xxyy 是 Vue 3 生产版：元素上不挂组件实例（__vueParentComponent 是开发版才有的），行也不是链接，
  // 锚点 / React fiber 两套解析在它上面全是瞎的。但根容器 #app._vnode 在任何构建里都在
  //（渲染器 render() 末尾 container._vnode = vnode）。2026-09-05 台湾出口实测：从根往下 1737 个
  // vnode / 5ms 走到悬停行，所属组件 DynamicScrollerItem 的 props.item 里就有 tokenAddress（代币 CA）
  // 与 pairAddress（池子）——拿 tokenAddress 直接开卡，连反解都省了。
  const VUE_CHAIN_IDS = { 1: 'ethereum', 56: 'bsc', 8453: 'base', 1399811149: 'solana', 4663: 'robinhood', 143: 'monad' };
  const VUE_CHAIN_NAMES = { sol: 'solana', solana: 'solana', bsc: 'bsc', bnb: 'bsc', eth: 'ethereum', ethereum: 'ethereum', base: 'base', robin: 'robinhood', robinhood: 'robinhood' };
  const TOKEN_KEY_RE = /^(token(address|ca|mint)?|mint(address)?|ca|contract(address)?|basetoken(address)?)$/i;
  const POOL_KEY_RE = /^(pair(address)?|pool(address)?|amm(address)?)$/i;
  const vueHoverCache = new WeakMap();   // 行元素 → { text, hit, at }；recycle-scroller 复用 DOM 节点，文本一变即作废

  /** 一个像"行数据"的对象 → { chain, ca, resolved }：有代币字段直接算已解析；只有池子字段就交给反解。 */
  function vueItemToHit(item) {
    if (!item || typeof item !== 'object') return null;
    let ca = '';
    let pool = '';
    let chain = null;
    let keys;
    try { keys = Object.keys(item); } catch (_) { return null; }
    for (const k of keys) {
      let v;
      try { v = item[k]; } catch (_) { continue; }
      if (typeof v === 'string' && (ADDR_RE.test(v) || XXYY_POOL_ID_RE.test(v))) {
        if (!ca && TOKEN_KEY_RE.test(k) && ADDR_RE.test(v)) ca = v;
        else if (!pool && POOL_KEY_RE.test(k) && (ADDR_RE.test(v) || XXYY_POOL_ID_RE.test(v))) pool = v;
      } else if ((typeof v === 'string' || typeof v === 'number') && /^(chain(id|name)?|network(id)?)$/i.test(k)) {
        const s = String(v).toLowerCase();
        chain = VUE_CHAIN_NAMES[s] || VUE_CHAIN_IDS[s] || chain;
      }
    }
    if (ca) return { chain, ca, resolved: true };
    if (pool) return { chain, ca: pool, resolved: false };
    return null;
  }

  /** props 顶层 → item/row/data 这类对象一层 → 再一层；深度封 3、节点封 200；人味键整棵跳过。 */
  function vueScanProps(props) {
    const q = [[props, 0]];
    let n = 0;
    while (q.length && n++ < 200) {
      const [obj, d] = q.shift();
      if (!obj || typeof obj !== 'object') continue;
      const hit = vueItemToHit(obj);
      if (hit) return hit;
      if (d >= 3) continue;
      let keys;
      try { keys = Object.keys(obj); } catch (_) { continue; }
      for (const k of keys.slice(0, 40)) {
        if (USERISH_RE.test(k)) continue;
        let v;
        try { v = obj[k]; } catch (_) { continue; }
        if (v && typeof v === 'object' && !Array.isArray(v)) q.push([v, d + 1]);
      }
    }
    return null;
  }

  function resolveByVue(target) {
    if (!SITE.vueRoot) return null;
    let rootEl = null;
    try { rootEl = document.querySelector(SITE.vueRoot); } catch (_) { return null; }
    const rootVn = rootEl && rootEl._vnode;
    if (!rootVn) return null;
    const rowEl = (SITE.rowSel && target.closest) ? target.closest(SITE.rowSel) : null;
    if (rowEl) {
      const c = vueHoverCache.get(rowEl);
      if (c && c.text === rowEl.textContent && Date.now() - c.at < 5000) return c.hit;
    }
    // 悬停目标及其 ≤8 层祖先都算候选；取离目标最近的命中 vnode 所属的组件
    const cands = new Map();
    let n = target;
    for (let i = 0; i < 8 && n && n !== document.body; i++, n = n.parentElement) cands.set(n, i);
    let best = null;
    let bestDist = 99;
    let visited = 0;
    const seen = new Set();
    const trav = (vn, inst, depth) => {
      if (!vn || typeof vn !== 'object' || visited > 60000 || depth > 150 || bestDist === 0) return;
      if (seen.has(vn)) return;
      seen.add(vn);
      visited++;
      const el = vn.el;
      if (el && inst && cands.has(el)) {
        const dist = cands.get(el);
        if (dist < bestDist) { bestDist = dist; best = inst; }
      }
      if (vn.component) { trav(vn.component.subTree, vn.component, depth + 1); return; }
      if (vn.suspense && vn.ssContent) trav(vn.ssContent, inst, depth + 1);
      const ch = vn.children;
      if (Array.isArray(ch)) for (const c of ch) { if (c && typeof c === 'object') trav(c, inst, depth + 1); }
    };
    try { trav(rootVn, null, 0); } catch (_) { return null; }
    let hit = null;
    let inst = best;
    for (let up = 0; up < 3 && inst && !hit; up++, inst = inst.parent) {   // 行组件自己没有就看上两层（slot 数据可能在父组件）
      try { hit = vueScanProps(inst.props); } catch (_) { hit = null; }
    }
    if (hit && !hit.chain && urlToken) hit.chain = urlToken.chain;   // 行数据没写链就沿用当前页的链（只影响副池 chips）
    if (rowEl) vueHoverCache.set(rowEl, { text: rowEl.textContent, hit, at: Date.now() });
    return hit;
  }

  /** xxyy 左栏几何命中：这一层只判断“是不是行”，不读页面 JS 对象。 */
  function stableXxyyRow(target) {
    if (!target || !target.closest) return null;
    try {
      // RecycleScroller 会复用外壳并重建内层 .row；dwell 若钉在内层，重建瞬间就被误判为离行。
      return target.closest('.vue-recycle-scroller__item-view')
        || target.closest('.virtual-wrap [role="item"], .monitor-item, .multi-wallet-monitor-item, .row');
    } catch (_) { return null; }
  }

  function vueHoverRow(target, clientX) {
    if (SITE.hover !== 'vue' || !target || !target.closest) return null;
    if (!Number.isFinite(clientX)) return null;
    // New-layout widgets can be dragged to the right; keep this exception scoped to token widgets.
    if (clientX >= window.innerWidth * (SITE.hoverZone || LEFT_ZONE_RATIO)
        && !target.closest('.follows, .monitor')) return null;
    if (target.closest('footer, nav, [role="navigation"]')) return null;
    return stableXxyyRow(target);
  }

  /**
   * 真扩展的 xxyy dwell：600ms 后把当前坐标交给 background，由 MAIN world 只读 vnode。
   * 同一行内跨格移动只更新坐标，不重启计时；离行会使旧异步回包过期。
   */
  function armXxyyVueHover(target, clientX, clientY) {
    const nextRow = vueHoverRow(target, clientX);
    if (!nextRow) return false;

    if (hoverPendingRow === nextRow) {
      hoverPendingTarget = target;
      hoverPendingX = clientX;
      hoverPendingY = clientY;
      cancelHide();
      return true;
    }

    cancelHoverDwell();
    hoverPendingRow = nextRow;
    hoverPendingTarget = target;
    hoverPendingX = clientX;
    hoverPendingY = clientY;
    cancelHide();
    const my = ++hoverProbeSeq;

    const row = hoverPendingRow;
    const probe = (attempt) => {
      if (my !== hoverProbeSeq || !row || hoverPendingRow !== row) return;
      const x = hoverPendingX;
      const y = hoverPendingY;
      requestXxyyVueHit(x, y, (resp) => {
        if (my !== hoverProbeSeq || !row || hoverPendingRow !== row) return;
        const raw = resp && resp.ok && resp.payload;
        const ca = raw && typeof raw.ca === 'string' && (ADDR_RE.test(raw.ca)
          || (raw.resolved !== true && isXxyyPoolRef(raw.ca))) ? raw.ca : '';
        if (!ca) {
          // Vue 虚拟行刚复用/重绘时，elementFromPoint 与 vnode 会有一个极短的不一致窗。
          // 同一行、同一 hover generation 内最多补两次；离行立即由 hoverProbeSeq 作废。
          if (attempt + 1 < XXYY_PROBE_MAX_ATTEMPTS) {
            hoverTimer = setTimeout(() => { hoverTimer = null; probe(attempt + 1); }, XXYY_PROBE_RETRY_MS);
            return;
          }
          cancelHoverDwell();
          if (state.open && state.mode === 'preview' && !state.pinned) scheduleHide();
          return;
        }
        const hit = { chain: raw.chain || (urlToken && urlToken.chain) || null, ca, resolved: raw.resolved === true };
        hoverPendingCa = ca;
        hoverPendingChain = hit.chain;
        if (state.open && isCurrentToken(hit)) { cancelHide(); return; }
        previewRow = row;
        openToken(hit, 'preview');
      });
    };
    hoverTimer = setTimeout(() => { hoverTimer = null; probe(0); }, HOVER_DEBOUNCE_MS);
    return true;
  }

  // Stay attached to a bounded row, not the tracker/list container.
  function gmgnHoverRow(target, x) {
    if (SITE.hover !== 'gmgn-react' || !target || !target.closest
        || !Number.isFinite(x) || x >= innerWidth * SITE.hoverZone
        || target.closest('nav,footer,[role="navigation"]')) return null;
    let best = null;
    for (let el = target, up = 0; el && el !== document.body && up < 8; up++, el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.height > 180 || r.width > innerWidth * 0.6) break;
      if (r.height >= 20 && r.width >= 80 && getComputedStyle(el).cursor === 'pointer') best = el;
    }
    return best;
  }

  function armGmgnHover(target, x, y) {
    const row = gmgnHoverRow(target, x);
    if (!row) return false;
    if (hoverPendingRow === row) {
      hoverPendingX = x; hoverPendingY = y; hoverPendingTarget = target;
      cancelHide(); return true;
    }
    cancelHoverDwell(); cancelHide();
    hoverPendingRow = row; hoverPendingX = x; hoverPendingY = y;
    hoverPendingTarget = target;
    const seq = ++hoverProbeSeq;
    const probe = () => {
      if (seq !== hoverProbeSeq || hoverPendingRow !== row || !row.isConnected) return;
      const current = document.elementFromPoint(hoverPendingX, hoverPendingY);
      if (!current || !row.contains(current)) { cancelHoverDwell(); return; }
      sendMsg({type:'gmgn-react-hit',x:hoverPendingX,y:hoverPendingY}, resp => {
        if (seq !== hoverProbeSeq || hoverPendingRow !== row || !row.isConnected) return;
        const hit = resp && resp.ok && resp.payload;
        if (hit && ADDR_RE.test(String(hit.ca || '')) && hit.chain) {
          hoverPendingCa = hit.ca;
          hoverPendingChain = hit.chain;
          if (!state.open || !isCurrentToken(hit)) { previewRow = row; openToken(hit, 'preview'); }
          // Virtual lists may reuse a row without moving the cursor.
          hoverTimer = setTimeout(() => { hoverTimer = null; probe(); }, 400);
        } else {
          cancelHoverDwell();
          if (state.open && state.mode === 'preview' && !state.pinned) scheduleHide();
        }
      });
    };
    hoverTimer = setTimeout(() => { hoverTimer = null; probe(); }, HOVER_DEBOUNCE_MS);
    return true;
  }

  function onMouseOver(e) {
    const t = e.target;
    if (!t || t.nodeType !== 1) return;
    if (host && (t === host || host.contains(t))) { cancelHide(); return; }

    if (!settings.hoverPreview) return;

    const clientX = e.clientX;
    if (SITE.hover === 'gmgn-react') {
      let anchorHit = null;
      try { anchorHit = resolveByAnchor(t); } catch (_) {}
      if (!anchorHit && armGmgnHover(t, clientX, e.clientY)) return;
    }
    // xxyy 无链接列表行：真扩展必须走异步 MAIN-world 探针。
    // 若命中的本来就是一条代币链接，仍留给下面的同步快路。
    if (SITE.hover === 'vue' && !TEST) {
      let anchorHit = null;
      try { anchorHit = resolveByAnchor(t); } catch (_) { anchorHit = null; }
      if (!anchorHit && armXxyyVueHover(t, clientX, e.clientY)) return;
    }
    let hit = null;
    try { hit = resolveHovered(t, clientX); } catch (_) { hit = null; }
    const nextCa = hit && hit.ca ? hit.ca : null;
    const nextRow = nextCa ? hoverRowOf(t) : null;

    // 关键修复（v0.7.3）：只要还停在"同一行、同一个 CA"上，就别动正在跑的计时器——
    // fomo 的一行里有头像/名字/徽章/价格等一堆子元素，光标在行内挪动会不停触发
    // mouseover；旧代码每次都 clearTimeout 重置，600ms 永远走不完，预览从来不弹。
    // 现在行内微动只更新"到点时用哪个 target 解析"，dwell 计时照常朝 600ms 累积。
    if (hoverTimer && nextCa && hoverPendingRow
        && nextRow === hoverPendingRow
        && sameToken(hit, {ca:hoverPendingCa, chain:hoverPendingChain})) {
      hoverPendingTarget = t;
      hoverPendingX = clientX;
      return;
    }

    // 换了行 / 换了 CA / 移出了可识别区域 → 重新计时
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    hoverPendingRow = nextRow;
    hoverPendingCa = nextCa;
    hoverPendingChain = hit && hit.chain;
    hoverPendingTarget = t;
    hoverPendingX = clientX;

    if (!nextCa) {
      // 从预览行移到 Friends Only / 筛选按钮时，mouseout 可能已挂了退场计时。
      // 光标进入明确可交互控件就先续住，不必赌用户会在 400ms 内点下去。
      if (state.open && state.mode === 'preview' && !state.pinned && isPageControl(t)) cancelHide();
      return;   // 不在任何可识别的行上：不起新计时（退场交给 mouseout）
    }
    cancelHide();

    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      const target = hoverPendingTarget || t;
      const x = hoverPendingX;
      let hit2 = null;
      try { hit2 = resolveHovered(target, x); } catch (_) { hit2 = null; }
      if (!hit2) {
        // 指针已离开可识别的行 → 预览进入退场倒计时
        if (state.open && state.mode === 'preview' && !state.pinned) scheduleHide();
        return;
      }
      if (state.open && isCurrentToken(hit2)) { cancelHide(); return; }
      previewRow = hoverRowOf(target);
      openToken(hit2, 'preview');   // v0.9.12：预览也走站点反解（xxyy 左栏链接挂的可能也是池子地址）
    }, HOVER_DEBOUNCE_MS);
  }

  function onMouseOut(e) {
    const to = e.relatedTarget;
    const from = e.target;
    // dwell 期间离开行就作废；行内从名字移到价格不算离开。
    if (hoverPendingRow && (!to || !hoverPendingRow.contains || !hoverPendingRow.contains(to))) {
      cancelHoverDwell();
    }
    if (!state.open || state.mode !== 'preview' || state.pinned) return;
    if (to && host && (to === host || host.contains(to))) return;
    if (to && previewRow && previewRow.contains && previewRow.contains(to)) return;
    // Friends Only 这类控件点击后常被 Vue 原地重建，浏览器会补一颗 relatedTarget=null 的 mouseout。
    // 这不是“用户离开预览”，不要让旧退场计时把刚操作完的卡片关掉；点图表空白仍由 click 明确关闭。
    const fromControlOutsidePreview = from && isPageControl(from)
      && !(previewRow && previewRow.contains && previewRow.contains(from));
    if (fromControlOutsidePreview || (to && isPageControl(to))) { cancelHide(); return; }
    scheduleHide();
  }

  // ---------- 点卡片外关闭 ----------
  /**
   * 卡片是浮在图表上的，主人想看图时不该被逼着去点 ×。
   * 不关的四种点击：卡片自身（含圆钮，都在 shadow 宿主里）、左栏那些可悬停的代币行、
   * 任何代币链接（那是在切币，不是想关卡）、页面筛选/排序控件。
   */
  function onDocClick(e) {
    if (!state.open) { cancelHoverDwell(); resolveSeq.url++; resolveSeq.preview++; return; }
    const t = e.target;
    if (!t || t.nodeType !== 1) return;
    // closed shadow 里的点击会被重定向到宿主元素上，这一条就能兜住卡片与圆钮
    if (host && (t === host || host.contains(t))) return;
    try {
      // 点的是代币链接 → 立刻换币（而不是关卡，也不必等轮询）
      if (fastSwitchFromClick(t, e)) { cancelHoverDwell(); cancelHide(); return; }
      if (previewRow && previewRow.contains && previewRow.contains(t)) {
        cancelHoverDwell();
        cancelHide();
        return;
      }
      if (gmgnHoverRow(t, e.clientX) || vueHoverRow(t, e.clientX) || resolveHovered(t, e.clientX)) { // 左栏可解析/几何命中的代币行
        // v0.9.13：点击行会由站点自己的路由切到 URL 模式；撤掉移动鼠标时新挂的 dwell，
        // 否则它可能在路由完成后又把旧预览盖回来。
        cancelHoverDwell();
        cancelHide();
        return;
      }
      // v0.9.1：点的是页面上的控件（Friends only 勾选框、筛选/排序按钮、外链…）= 用户在操作
      // fomo，不是在"点卡外关卡"。主人实测：点 Holders 表上方的 Friends only 卡片直接消失。
      // 只有点空白/图表这类非交互区才算主动关卡。
      if (isPageControl(t)) {
        // v0.9.13：悬停预览从左栏移向 Friends Only 时，mouseout 已经挂了 400ms 退场计时；
        // 单靠“不把 click 当卡外”还不够，旧计时仍会在 click 之后把卡关掉。页面控件点击
        // 是明确交互，先撤掉这颗计时器；之后真点空白/图表仍会照常关闭。
        cancelHide();
        // K3 #3：用户很可能刚点了 fomo 的 Holders 标签 / Friends only 开关来"修"空态——观察者可能早撤了，
        // 400ms 后补扫一次，别让"切到 Holders"这句在表已经出来后还挂着。
        scheduleControlRescan();
        return;
      }
    } catch (_) { /* 解析失败就按"外部点击"处理 */ }
    closeCard();
  }

  let controlRescanTimer = null;
  function scheduleControlRescan() {
    const hEmpty = state.holders && state.holders.status === 'empty';
    const tEmpty = state.thesis && state.thesis.status === 'empty';
    if (!hEmpty && !tEmpty) return;
    if (controlRescanTimer) clearTimeout(controlRescanTimer);
    controlRescanTimer = setTimeout(() => { controlRescanTimer = null; rescanNow(true); }, 400);
  }

  /**
   * 页面控件判定：按钮/输入/label/链接/ARIA 控件，或 4 层祖先内有 cursor:pointer
   * （fomo 的可点区块多是 div.cursor-pointer 包一个 pointer-events-none 的图标按钮）。
   */
  const CONTROL_SEL = 'button, input, select, textarea, label, a, summary, '
    + '[role="button"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], '
    + '[role="option"], [role="radio"], [contenteditable="true"]';
  function isPageControl(t) {
    if (!t || !t.closest) return false;
    if (t.isContentEditable) return true;   // Gickey D5：contenteditable="" / plaintext-only 不在 selector 里
    if (t.closest(CONTROL_SEL)) return true;
    let el = t;
    for (let i = 0; i < 4 && el && el.nodeType === 1 && el !== document.body; i++) {
      try { if (getComputedStyle(el).cursor === 'pointer') return true; } catch (_) { return false; }
      el = el.parentElement;
    }
    return false;
  }

  // ---------- 键盘 ----------
  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    const a = document.activeElement;
    if (a) {
      const tag = (a.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable) return;
    }
    closeCard();
  }

  // ---------- 启动 ----------
  function start() {
    loadSettings(() => {
      if (disposed) return;
      urlToken = parsePath(location.pathname);
      if (urlToken && autoOpenEnabled()) openFromUrl(urlToken);
      else ensureUi();
    });
    watchSettings();
    installUrlWatcher();
    listen(document, 'mouseover', onMouseOver, true);
    listen(document, 'mouseout', onMouseOut, true);
    listen(document, 'keydown', onKeyDown, true);
    listen(document, 'click', onDocClick, true);
    listen(document, 'scroll', onScrollMaybeRescan, { capture: true, passive: true });
    listen(window, 'resize', () => { applySize(); applyLauncherPos(); });
    ensureUi();
  }

  // 只在真实 fomo content script 上受理后台快照；测试主世界桩与其它站点均不开这条入口。
  if (!TEST) {
    try {
      listenChrome(chrome.runtime.onMessage, (msg, sender, sendResponse) => {
        if (disposed || !sender || sender.id !== chrome.runtime.id || !msg) return false;
        if (msg.type === 'lens-health') { sendResponse({ ok: true }); return false; }
        if (SITE.id !== 'fomo' || msg.type !== 'fomo-mirror-snapshot') return false;
        try { sendResponse({ ok: true, payload: buildFomoMirrorSnapshot(msg) }); }
        catch (_) { sendResponse({ ok: false, kind: 'unavailable' }); }
        return false;
      });
    } catch (_) { /* 扩展上下文失效时由后台超时并给固定提示 */ }
  }

  if (TEST) {
    globalThis.__fomoDebotTestHandle = {
      get shadow() { return shadow; },
      get host() { return host; },
      diag() { return buildDiag(); },
      stopScrapers() { stopScrapers(); },   // 模拟 25s 观察者过期
      mirrorSnapshot(msg) { return buildFomoMirrorSnapshot(msg); },
      mirrorHolderCount() { return fomoMirrorHolderCount(); },
      mirrorShare(value) { return snapshotFomoShare(value); },
      get state() {
        return {
          open: state.open, ca: state.ca, chain: state.chain, mode: state.mode,
          pinned: state.pinned, status: state.status, lang: settings.lang,
          openMode: settings.openMode, compact: state.compact,
          tab: state.tab,
          size: card ? { w: Math.round(card.getBoundingClientRect().width), h: Math.round(card.getBoundingClientRect().height) } : null,
          errorKind: state.errorKind,
          analysis: state.analysis.status,
          holders: state.holders.status,
          thesis: state.thesis.status,
          feed: ((state.thesis && state.thesis.feed) || []).map((f) => f && (f.handle || f.author || '')),
          tweets: state.tweets.status,
          translator: translation.status,
          translating: translation.on,
        };
      },
    };
  }

  listen(document, DISPOSE_EVENT, dispose);
  globalThis[INSTANCE_KEY] = { dispose, alive: () => {
    if (disposed) return false;
    try { return TEST || !!chrome.runtime.id; } catch (_) { return false; }
  } };
  start();
})();
