// Real MV3 regression: Fomo mounts only one of Holders/Thesis at a time.
// No test globals, direct state injection, credentials or upstream network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pp from '/usr/local/lib/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import {lensEval, lensClick, sleep, until} from './launcher-browser.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.env.FOMO_EXTENSION_DIR || path.resolve(DIR, '..');
const OUT = process.env.FOMO_TEST_OUTPUT || path.resolve(DIR, '../../thesis-test');
const BASELINE = process.env.FOMO_THESIS_BASELINE === '1';
fs.mkdirSync(OUT, {recursive: true});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fomo-thesis-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', temp+'/key',
  '-out', temp+'/cert', '-days', '2', '-subj', '/CN=fomo.family'], {stdio: 'ignore'});
const fixture = fs.readFileSync(DIR+'/mock-fomo-mirror.html', 'utf8');
const gmgn = fs.readFileSync(DIR+'/mock-gmgn-installed.html', 'utf8');
const xxyy = fs.readFileSync(DIR+'/mock-xxyy.html', 'utf8');
const story = JSON.parse(fs.readFileSync(DIR+'/fixtures/pons.json'));
const CA = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const LOW = '0x1111111111111111111111111111111111111111';
const ZERO = '0x2222222222222222222222222222222222222222';
const BROKEN = '0x3333333333333333333333333333333333333333';
const AUTH = '0x4444444444444444444444444444444444444444';
const SLOW = '0x5555555555555555555555555555555555555555';
const COLD = '0x6666666666666666666666666666666666666666';
const BOOT = '0x7777777777777777777777777777777777777777';
let repaired = false;
const hits = [], checks = [], errors = [];
const check = (name, ok, detail) => {
  checks.push({name, ok: !!ok, ...(!ok ? {detail} : {})});
  console.log((ok ? 'PASS ' : 'FAIL ')+name+(!ok ? ' '+JSON.stringify(detail) : ''));
};

function fomoPage(u) {
  const ca = u.pathname.split('/').at(-1);
  const rows = [
    '<div class="crow"><span>newest_user</span> <span>Thesis</span> <span>Closed</span> <span>5m</span> <span>▲ 10%</span> <span>NEWEST_CLOSED actual comment ending 2026</span> <span>7</span> <span>1 newer</span></div>',
    '<div class="crow"><span>older_user</span> <span>Thesis</span> <span>2h</span> <span>$2K</span> <span>( ▼ 4% )</span> <span>OLDER_HIGH_LIKES</span> <span>12</span></div>',
    '<div class="crow"><span>low_user</span> <span>Thesis</span> <span>1m</span> <span>$3K</span> <span>( ▲ 1% )</span> <span>LOW_LIKES</span> <span>1</span></div>',
  ];
  const comments = ca === ZERO ? '' : ca === LOW ? rows[2] : rows.join('');
  // As on the live site, activating one tab removes the other panel from the DOM.
  return fixture.replace('</body>', `<script>
    const holders=document.querySelector('#holders'),feed=document.querySelector('#thesis-feed');
    feed.innerHTML=${JSON.stringify(comments)};feed.remove();
    const mount=document.querySelector('main'), tabs=document.querySelector('#bottom-tabs');
    window.__ownerMarker='untouched';window.__tabSwitches=0;window.__tokenReady=${ca !== BOOT};
    document.querySelector('#btab-thesis').textContent='Thesis (${ca === ZERO ? 0 : 3})';
    function switchPanel(key){
      window.__tabSwitches++;
      for(const b of tabs.querySelectorAll('button'))b.className=b.id==='btab-'+key?'text-text-primary':'text-text-tertiary';
      holders.remove();feed.remove();
      if(key==='holders')mount.append(holders);
      if(key==='thesis' && document.visibilityState==='visible' && window.__tokenReady && ${(ca === AUTH || (ca === BROKEN && !repaired)) ? 'false' : 'true'}){
        ${ca === SLOW ? 'setTimeout(()=>mount.append(feed),6500);' : 'mount.append(feed);'}
      }
    }
    for(const b of tabs.querySelectorAll('button'))b.addEventListener('click',()=>switchPanel(b.id.replace('btab-','')));
    if(${ca === BOOT}){holders.remove();setTimeout(()=>{window.__tokenReady=true;if(document.querySelector('#btab-holders').classList.contains('text-text-primary'))mount.append(holders);},2400);}
    if(location.search.includes('feed'))switchPanel('thesis');
    if(location.search.includes('narrow')){
      for(const c of holders.querySelectorAll('.hthesis'))c.remove();
      holders.querySelector('.htab').lastElementChild.remove();
    }
    if(${ca === AUTH}){holders.remove();const b=document.createElement('button');b.textContent='Log in';mount.append(b);}
  </script></body>`);
}
const server = https.createServer({key: fs.readFileSync(temp+'/key'), cert: fs.readFileSync(temp+'/cert')}, (req, res) => {
  const u = new URL(req.url, 'https://'+req.headers.host);
  const reply = (body, type='text/html') => {res.writeHead(200, {'content-type': type, 'cache-control': 'no-store'});res.end(body);};
  if (u.hostname === 'fomo.family') {
    hits.push(u.href);
    if (u.pathname.endsWith(COLD)) return setTimeout(() => reply(fomoPage(u)), 16000);
    return reply(fomoPage(u));
  }
  if (u.hostname === 'gmgn.ai') return reply(gmgn);
  if (u.hostname === 'pro.xxyy.io' || u.hostname === 'www.xxyy.io') return reply(xxyy);
  if (u.pathname === '/api/v1/nitter/story/latest') {
    const s = structuredClone(story), ca = u.searchParams.get('ca_address');
    s.data.history.ca_address = ca;s.data.history.story.contract_address = ca;s.data.history.source_tweets = [];
    s.data.history.name = ca === LOW ? 'LOW_TOKEN' : ca === SLOW ? 'SLOW_TOKEN' : 'PONS';
    return reply(JSON.stringify(s), 'application/json');
  }
  return reply('{"pairs":[]}', 'application/json');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await pp.launch({executablePath: '/usr/bin/chromium', headless: true, userDataDir: temp+'/profile',
  ignoreDefaultArgs: ['--disable-extensions'], args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors',
    '--no-proxy-server', '--disable-extensions-except='+EXT, '--load-extension='+EXT,
    '--host-resolver-rules=MAP * 127.0.0.1:'+server.address().port+', EXCLUDE localhost'],
  defaultViewport: {width: 1512, height: 1000}});
const snap = page => lensEval(page, `return {name:this.querySelector('.name').textContent,text:this.querySelector('.slot-thesis').textContent,
  authors:[...this.querySelectorAll('.slot-thesis .rauthor')].map(e=>e.textContent),
  likes:[...this.querySelectorAll('.slot-thesis .rlikes')].map(e=>e.textContent),
  bodies:[...this.querySelectorAll('.slot-thesis .rtext')].map(e=>e.textContent),
  holdings:this.querySelector('.slot-kol').textContent,share:this.querySelector('.share-bar')?.textContent||'',
  count:this.querySelectorAll('.slot-thesis .row-item').length};`);
const readComments = async page => {
  if (BASELINE) return;
  const ready=await until(async()=>{const s=await snap(page);return s && (s.authors.length || /前台加载|没有 ≥2|没有显示|需要先登录/.test(s.text)) ? s : null;}, 35000);
  if (ready?.text.includes('前台加载')) await lensClick(page, '.slot-thesis > .sbtn');
};
const openViews = async page => {
  await until(() => lensEval(page, 'const c=this.querySelector(".card");return !c.hidden&&c.getBoundingClientRect().width>0;'), 12000);
  await lensClick(page, '[data-tab="views"]');
  await readComments(page);
};
const nativeUrl = ca => 'https://fomo.family/tokens/robinhood/'+ca;
const emptyTemporaryTabs = async owner => (await browser.pages()).filter(p => p !== owner && p.url().startsWith('https://fomo.family/tokens/')).length === 0;
let page;
try {
  page = await browser.newPage();page.on('pageerror', e => errors.push(e.message));
  await page.goto(nativeUrl(CA));
  await until(async () => (await snap(page))?.count === 3);
  await openViews(page);
  check('native By likes reads the holder theses', (await snap(page)).authors.join(',') === '@31337___,@MEADGod,@ogle');
  const worker=await (await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/background.js'))).worker();
  const windowBefore=await worker.evaluate(async()=> (await chrome.windows.getAll()).map(w=>({id:w.id,focused:w.focused})));
  const ownerBefore = await page.evaluate(() => ({marker:window.__ownerMarker, switches:window.__tabSwitches, scroll:scrollY}));
  await lensClick(page, '.slot-thesis .sbtn:nth-child(2)');await readComments(page);
  if (BASELINE) {
    await sleep(2200);
    check('v0.9.23 reproduces missing newest comments while the real feed is available',
      (await snap(page)).count === 0 && await emptyTemporaryTabs(page), await snap(page));
  } else {
    await until(async () => (await snap(page))?.text.includes('NEWEST_CLOSED'), 33000);
    let s = await snap(page);
    check('Newest independently reads comments with Holders unmounted', s.authors.join(',') === '@newest_user,@older_user', s);
    check('Closed and newer badges preserve likes and numeric-ending text', s.likes.join(',') === '♥ 7,♥ 12' && s.bodies[0].includes('ending 2026'), s);
    check('the owner Fomo page is neither switched nor scrolled', JSON.stringify(ownerBefore) === JSON.stringify(await page.evaluate(() => ({marker:window.__ownerMarker, switches:window.__tabSwitches, scroll:scrollY}))));
    check('temporary comment tab is closed', await until(() => emptyTemporaryTabs(page)));
    check('the explicit reader tab closes and owner focus is preserved', JSON.stringify(windowBefore)===JSON.stringify(await worker.evaluate(async()=> (await chrome.windows.getAll()).map(w=>({id:w.id,focused:w.focused})))));
    await page.screenshot({path:OUT+'/native-newest.png'});
    await lensClick(page, '.slot-thesis .sbtn:nth-child(1)');
    check('returning to By likes preserves the holder list', (await snap(page)).authors.join(',') === '@31337___,@MEADGod,@ogle');

    await page.goto(nativeUrl(CA)+'?feed');
    await until(async () => (await snap(page))?.text.includes('NEWEST_CLOSED'));
    await openViews(page);
    s = await snap(page);
    check('opening directly on native Thesis works without Holders', s.authors[0] === '@older_user' && s.count === 3, s);
    await lensClick(page, '.slot-thesis .sbtn:nth-child(2)');await readComments(page);
    check('native Thesis can switch to Newest without a holder prerequisite', (await snap(page)).authors.join(',') === '@newest_user,@older_user');

    await page.goto(nativeUrl(CA)+'?narrow');
    await until(async () => !!await lensEval(page, 'return !!this.querySelector(".tab");'));
    await openViews(page);
    await until(async () => (await snap(page))?.text.includes('NEWEST_CLOSED'), 33000);
    s = await snap(page);
    check('a missing responsive Thesis column falls back to comments sorted by likes', s.authors[0] === '@older_user' && s.text.includes('按已读到的评论赞数排序'), s);

    for (const host of ['gmgn.ai', 'www.xxyy.io']) {
      await page.goto('https://'+host+(host === 'gmgn.ai' ? '/robinhood/token/' : '/robin/')+CA);
      await until(async () => (await snap(page))?.text.includes('You can now see'), 33000);
      const before = await snap(page);
      await openViews(page);
      await lensClick(page, '.slot-thesis .sbtn:nth-child(2)');await readComments(page);
      await until(async () => (await snap(page))?.text.includes('NEWEST_CLOSED'), 33000);
      s = await snap(page);
      check(host+' Newest reads the separate feed', s.authors.join(',') === '@newest_user,@older_user', s);
      check(host+' comment fetching preserves holdings and share', s.holdings === before.holdings && s.share === before.share);
      check(host+' cleans up temporary tabs', await until(() => emptyTemporaryTabs(page)));
      await page.screenshot({path:OUT+'/'+host+'-newest.png'});
    }

    await page.goto(nativeUrl(BOOT));
    await openViews(page);await lensClick(page, '.slot-thesis .sbtn:nth-child(2)');await readComments(page);
    await until(async () => (await snap(page))?.text.includes('NEWEST_CLOSED'), 33000);
    check('wait for token context before switching the source tab', (await snap(page)).authors[0] === '@newest_user', await snap(page));
    check('bootstrap readers close their temporary tabs', await until(() => emptyTemporaryTabs(page), 33000));

    for (const [ca, expected] of [[LOW,'没有 ≥2 赞'], [ZERO,'没有显示这只币的评论'], [BROKEN,'暂时读不到这只币的评论'], [AUTH,'需要先登录']]) {
      await page.goto(nativeUrl(ca));
      await until(async () => !!await lensEval(page, 'return !!this.querySelector(".tab");'));
      await openViews(page);
      await lensClick(page, '.slot-thesis .sbtn:nth-child(2)');await readComments(page);
      await until(async () => (await snap(page))?.text.includes(expected), 33000);
      check('distinct comment state '+ca.slice(-4), (await snap(page)).text.includes(expected), await snap(page));
      check('empty/error/auth readers close their own tabs', await until(() => emptyTemporaryTabs(page)));
      if (ca === BROKEN) {
        repaired = true;
        await lensClick(page, '.slot-thesis > .sbtn');
        await until(async () => (await snap(page))?.text.includes('NEWEST_CLOSED'), 33000);
        check('Retry recovers without reloading the owner page', (await snap(page)).authors[0] === '@newest_user');
      }
    }

    await page.goto('https://gmgn.ai/robinhood/token/'+COLD);
    await openViews(page);await lensClick(page, '.slot-thesis .sbtn:nth-child(2)');await readComments(page);
    await until(async () => (await snap(page))?.text.includes('NEWEST_CLOSED'), 55000);
    check('a cold Fomo page arriving after 15s still yields comments', (await snap(page)).authors[0] === '@newest_user', await snap(page));
    check('cold-page readers clean up', await until(() => emptyTemporaryTabs(page), 33000));

    await page.goto('https://gmgn.ai/robinhood/token/'+SLOW);
    await until(async () => !!await lensEval(page, 'return !!this.querySelector(".tab");'));
    await openViews(page);await lensClick(page, '.slot-thesis .sbtn:nth-child(2)');await readComments(page);
    await sleep(900);
    await page.evaluate(url => history.pushState({}, '', url), 'https://gmgn.ai/robinhood/token/'+LOW);
    await until(async () => (await snap(page))?.name === 'LOW_TOKEN', 12000);
    await openViews(page);await lensClick(page, '.slot-thesis .sbtn:nth-child(2)');await readComments(page);
    await until(async () => (await snap(page))?.text.includes('没有 ≥2 赞'), 33000);
    await sleep(6500);
    check('a late old-token feed cannot replace the new token', (await snap(page)).text.includes('没有 ≥2 赞') && !(await snap(page)).text.includes('NEWEST_CLOSED'), await snap(page));
    check('no temporary reader remains after token switch', await until(() => emptyTemporaryTabs(page), 33000));
  }
} catch(e) {check('acceptance sequence completed', false, e.stack);}
finally {
  await browser.close();await new Promise(r => server.close(r));
  fs.writeFileSync(OUT+'/receipt.json', JSON.stringify({checks, hits, errors}, null, 2));
}
process.exit(checks.every(c => c.ok) ? 0 : 1);
