/**
 * 真扩展黑盒：--load-extension 安装当前目录，在 Chrome 默认 ISOLATED world 下验收。
 * 覆盖：当前 URL 自动开卡、xxyy→fomo 登录态 DOM 镜像、未登录提示、Vue 有界补探、
 * RecycleScroller 行复用、Friends Only 控件重建后卡片保持。
 */
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PPTR = 'file:///usr/local/lib/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
const puppeteer = await import(PPTR).then((m) => m.default ?? m);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 默认验当前源码；打包后可指向解压出来的 fomo-lens/，防止“源码能跑”冒充“交付包能装”。
const EXT_DIR = process.env.FOMO_EXTENSION_DIR
  ? path.resolve(process.env.FOMO_EXTENSION_DIR)
  : path.resolve(__dirname, '..');
const XXYY_FIXTURE = fs.readFileSync(path.join(__dirname, 'mock-xxyy.html'));
const FOMO_FIXTURE = fs.readFileSync(path.join(__dirname, 'mock-fomo.html'));
const LOGIN_FIXTURE = fs.readFileSync(path.join(__dirname, 'mock-fomo-login.html'));

const PONS_CA = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const CASHCAT_CA = '0x020bfc650a365f8bb26819deaabf3e21291018b4';
const AUTH_CA = '0x1111111111111111111111111111111111111111';
const CURRENT_POOL = 'HMzvsEEmtzHhvZNw9uwbaG85HCTmFnkbhzUx16cy7ca3';

const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fomo-lens-installed-cert-'));
const keyFile = path.join(certDir, 'key.pem');
const crtFile = path.join(certDir, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyFile, '-out', crtFile, '-days', '2', '-subj', '/CN=pro.xxyy.io',
  '-addext', 'subjectAltName=DNS:pro.xxyy.io,DNS:fomo.family,DNS:api.dexscreener.com,DNS:app.debot.ai,DNS:debot.ai,DNS:api.github.com,DNS:api.fxtwitter.com'],
{ stdio: 'ignore' });

const seen = { fomo: [], debot: [], dex: [] };
const reply = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
const json = (res, body, status = 200) => reply(res, status, 'application/json; charset=utf-8', JSON.stringify(body));

const server = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(crtFile) }, (req, res) => {
  const hostname = String(req.headers.host || '').split(':')[0].toLowerCase();
  const u = new URL(req.url || '/', `https://${hostname || 'invalid.test'}`);
  if (hostname === 'pro.xxyy.io') return reply(res, 200, 'text/html; charset=utf-8', XXYY_FIXTURE);
  if (hostname === 'fomo.family') {
    seen.fomo.push(u.pathname);
    return reply(res, 200, 'text/html; charset=utf-8',
      u.pathname.toLowerCase().endsWith('/' + AUTH_CA.toLowerCase()) ? LOGIN_FIXTURE : FOMO_FIXTURE);
  }
  if (hostname === 'api.dexscreener.com') {
    seen.dex.push(u.pathname);
    if (u.pathname.includes('/latest/dex/pairs/')) {
      return json(res, { pair: { chainId: 'solana', pairAddress: CURRENT_POOL, baseToken: { address: PONS_CA, symbol: 'PONS' }, quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' } } });
    }
    return json(res, { pairs: [] });
  }
  if (hostname === 'app.debot.ai' || hostname === 'debot.ai') {
    seen.debot.push(u.searchParams.get('ca_address') || '');
    return json(res, { code: -1, error: 'not covered in smoke fixture' });
  }
  if (hostname === 'api.github.com') return json(res, {}, 404);
  if (hostname === 'api.fxtwitter.com') return json(res, {}, 404);
  return json(res, {}, 404);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fomo-lens-installed-profile-'));
let browser;
let failed = false;
const check = (label, pass, actual) => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : ` -> ${JSON.stringify(actual)}`}`);
  if (!pass) failed = true;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs = 10000, stepMs = 180) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (_) { /* 下一轮 */ }
    await sleep(stepMs);
  }
  return last || null;
}

/** 主世界只能看见 closed shadow 的宿主；按命中面积区分 44px 圆钮与完整卡片。 */
const footprint = (page) => page.evaluate(() => {
  const host = document.querySelector('[data-fomo-debot]');
  if (!host) return { host: false, hits: 0, bounds: null };
  let hits = 0; let minX = innerWidth; let minY = innerHeight; let maxX = 0; let maxY = 0;
  for (let y = 8; y < innerHeight; y += 12) {
    for (let x = 8; x < innerWidth; x += 12) {
      if (document.elementFromPoint(x, y) === host) {
        hits++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
  }
  return { host: true, hits, bounds: hits ? [minX, minY, maxX, maxY] : null };
});

/** CDP 的 pierce=true 可只读验收 closed ShadowRoot；不向扩展加入任何测试后门。 */
async function piercedCard(page) {
  const client = await page.target().createCDPSession();
  try {
    const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const attrs = (node) => {
      const out = {};
      for (let i = 0; i < (node.attributes || []).length; i += 2) out[node.attributes[i]] = node.attributes[i + 1];
      return out;
    };
    let host = null;
    const findHost = (node) => {
      if (!node || host) return;
      if (Object.prototype.hasOwnProperty.call(attrs(node), 'data-fomo-debot')) { host = node; return; }
      for (const child of [...(node.shadowRoots || []), ...(node.children || [])]) findHost(child);
    };
    findHost(root);
    if (!host) return { text: '', hrefs: [] };
    const texts = []; const hrefs = [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeName === '#text' && node.nodeValue) texts.push(node.nodeValue);
      const a = attrs(node);
      if (a.href) hrefs.push(a.href);
      for (const child of [...(node.shadowRoots || []), ...(node.children || [])]) walk(child);
    };
    walk(host);
    return { text: texts.join(' ').replace(/\s+/g, ' ').trim(), hrefs };
  } finally {
    await client.detach();
  }
}

try {
  const mappedHosts = ['pro.xxyy.io', 'fomo.family', 'api.dexscreener.com', 'app.debot.ai',
    'debot.ai', 'api.github.com', 'api.fxtwitter.com'];
  browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    userDataDir: profileDir,
    acceptInsecureCerts: true,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors', '--no-proxy-server',
      `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`,
      '--host-resolver-rules=' + mappedHosts.map((h) => `MAP ${h} 127.0.0.1:${port}`).join(', '),
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // 1) 直接打开一只币：不经过左栏 hover，也必须自动出现，并从 fomo 带回三类数据。
  await page.goto(`https://pro.xxyy.io/sol/${CURRENT_POOL}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-fomo-debot]', { timeout: 5000 });
  const current = await waitFor(async () => {
    const fp = await footprint(page); const card = await piercedCard(page);
    return fp.hits > 40 && card.text.includes('21.9%') ? { fp, card } : null;
  }, 12000);
  check('当前已打开的 xxyy 代币自动展示完整卡片（无需 hover）', !!current, current);
  check('xxyy 卡片有 Meta / Thesis / Holders 三页', !!current
    && /Meta/.test(current.card.text) && /Thesis/.test(current.card.text) && /Holders/.test(current.card.text), current && current.card.text);
  check('xxyy 读到 fomo Thesis、Holders 与 Fomo 持仓占比', !!current
    && current.card.text.includes('You can now see which tokens distribute creator rewards')
    && current.card.text.includes('$29.4K') && current.card.text.includes('21.9%'), current && current.card.text);
  check('池子地址先反解成代币 CA，再打开同币 fomo 页', seen.dex.some((p) => p.includes(CURRENT_POOL))
    && seen.fomo.some((p) => p.toLowerCase().endsWith('/' + PONS_CA.toLowerCase())), { dex: seen.dex, fomo: seen.fomo });
  await waitFor(async () => (await browser.pages()).filter((p) => p.url().startsWith('https://fomo.family/')).length === 0, 5000);

  // 2) 列表页：先制造 vnode 暂时缺席，第一探失败后必须在有界补探里弹出。
  await page.goto('https://pro.xxyy.io/meme', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-fomo-debot]', { timeout: 5000 });
  await sleep(250);
  const launcherOnly = await footprint(page);
  // 离行必须让在途/待重试探针全部过期：第三探若没被取消，会在 vnode 恢复后把旧币弹出来。
  await page.evaluate(() => {
    const root = document.getElementById('app');
    const saved = root._vnode;
    root._vnode = null;
    setTimeout(() => { root._vnode = saved; }, 720);
  });
  await page.hover('#xx-row-cashcat .sym');
  await sleep(640);
  await page.mouse.move(1000, 520);
  await sleep(600);
  const afterStaleLeave = await footprint(page);
  check('左侧收藏探针在途时离行：后续补探全部作废，不会迟到弹旧币',
    afterStaleLeave.hits <= launcherOnly.hits + 10, { launcherOnly, afterStaleLeave });

  await page.evaluate(() => {
    const root = document.getElementById('app');
    const saved = root._vnode;
    root._vnode = null;
    setTimeout(() => { root._vnode = saved; }, 650);
  });
  await page.hover('#xx-row-cashcat .sym');
  const retryCard = await waitFor(async () => {
    const fp = await footprint(page);
    return fp.hits > launcherOnly.hits + 30 ? fp : null;
  }, 2500, 100);
  check('左侧收藏首次 Vue 探针撞上重绘空窗，90ms 有界补探后仍会弹框', !!retryCard,
    { launcherOnly, retryCard });

  // 3) dwell 进行到一半时复用同一虚拟行并重建内层 row，计时不能丢；新币应命中登录提示。
  await page.mouse.move(1000, 520); await sleep(650);
  const beforeReuse = await footprint(page);
  await page.hover('#xx-row-cashcat .sym');
  await sleep(300);
  await page.evaluate(() => {
    const el = window.__xxyyReuseFirstRow('auth');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  });
  const reused = await waitFor(async () => {
    const fp = await footprint(page);
    return fp.hits > beforeReuse.hits + 30 ? fp : null;
  }, 1600, 80);
  check('RecycleScroller 复用外壳并重建内层 row 时，左侧收藏仍稳定弹框', !!reused,
    { beforeReuse, reused });
  const authCard = await waitFor(async () => {
    const card = await piercedCard(page);
    return card.text.includes('需要先登录 fomo') ? card : null;
  }, 6000);
  const authUrl = `https://fomo.family/tokens/solana/${AUTH_CA}`;
  check('未登录 fomo 时明确提示登录并给同币入口，不显示假 0%', !!authCard
    && authCard.hrefs.includes(authUrl) && !authCard.text.includes('0.0%'), authCard);

  // 4) Friends Only 点击后 Vue 把控件原地替换，补发 relatedTarget=null mouseout；卡片仍须留着。
  await page.evaluate(() => {
    const label = document.getElementById('xx-friends');
    label.addEventListener('click', () => setTimeout(() => {
      document.body.dataset.friendsChanged = '1';
      const fresh = label.cloneNode(true);
      label.replaceWith(fresh);
    }, 0), { once: true });
  });
  const beforeFriends = await footprint(page);
  await page.click('#xx-friends');
  await sleep(900);
  const afterFriends = await footprint(page);
  const friendsChanged = await page.evaluate(() => document.body.dataset.friendsChanged === '1');
  check('点 Friends Only 后控件已切换/重建且弹框不消失', friendsChanged
    && afterFriends.hits > launcherOnly.hits + 30, { friendsChanged, beforeFriends, afterFriends });

  // 5) 同一虚拟外壳反复切币；每次都必须在一次 dwell 内打开，抓“偶尔不弹”的概率性回退。
  let repeatPass = 0;
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Escape'); await sleep(120);
    await page.evaluate((kind) => { window.__xxyyReuseFirstRow(kind); }, i % 2 ? 'pons' : 'cashcat');
    const base = await footprint(page);
    await page.hover('#xx-row-cashcat .sym');
    const shown = await waitFor(async () => {
      const fp = await footprint(page);
      return fp.hits > base.hits + 30 ? fp : null;
    }, 1600, 80);
    if (shown) repeatPass++;
    await page.mouse.move(1000, 520); await sleep(480);
  }
  check('左侧收藏虚拟行连续 8 次切换均弹框', repeatPass === 8, { repeatPass });
  check('临时 fomo 读取页全部自动关闭，没有残留 tab',
    (await browser.pages()).filter((p) => p.url().startsWith('https://fomo.family/')).length === 0,
    (await browser.pages()).map((p) => p.url()));
} catch (err) {
  failed = true;
  console.error('FAIL  真扩展黑盒执行异常:', err && err.stack ? err.stack : err);
} finally {
  if (browser) await browser.close();
  server.close();
}

process.exit(failed ? 1 : 0);
