// Real MV3 installation. HTTPS fixtures simulate the upstream; no content-script stubs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pp from '/usr/local/lib/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.env.FOMO_EXTENSION_DIR || path.resolve(DIR, '..');
const OUT = process.env.FOMO_TEST_OUTPUT;
const BASELINE = process.env.FOMO_RECOVERY_BASELINE === '1';
fs.mkdirSync(OUT, {recursive: true});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fomo-recovery-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', temp+'/key', '-out', temp+'/cert', '-days', '2', '-subj', '/CN=fomo.family'], {stdio: 'ignore'});
const fixture = fs.readFileSync(DIR+'/mock-fomo.html', 'utf8');
const story = JSON.parse(fs.readFileSync(DIR+'/fixtures/pons.json'));
const CA = story.data.history.ca_address;
const NEXT = '0x020bfc650a365f8bb26819deaabf3e21291018b4';
const checks = [], hits = [], errors = [];
let fail = 0, pageLoads = 0;
const server = https.createServer({key: fs.readFileSync(temp+'/key'), cert: fs.readFileSync(temp+'/cert')}, (req, res) => {
  const u = new URL(req.url, 'https://'+req.headers.host);
  const reply = (status, body, type='application/json') => {res.writeHead(status, {'content-type': type, 'cache-control': 'no-store'}); res.end(body);};
  if (u.hostname === 'fomo.family') {pageLoads++; return reply(200, fixture, 'text/html');}
  if (u.pathname === '/api/v1/nitter/story/latest') {
    const ca = u.searchParams.get('ca_address'); hits.push({host: u.hostname, ca, at: Date.now()});
    if (fail > 0) {fail--; return reply(503, '{}');}
    const value = structuredClone(story);
    value.data.history.ca_address = ca;
    value.data.history.name = ca === CA ? 'PONS' : 'NEXT';
    value.data.history.story.project_name = value.data.history.name;
    value.data.history.story.contract_address = ca;
    value.data.history.source_tweets = [];
    return reply(200, JSON.stringify(value));
  }
  return reply(200, '{"pairs":[]}');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (name, ok, details) => {checks.push({name, ok: !!ok, details}); console.log((ok ? 'PASS ' : 'FAIL ')+name);};
async function until(fn, ms=8000) {const end=Date.now()+ms; while (Date.now()<end) {const r=await fn(); if(r)return r; await sleep(100);} return null;}
async function shadowCall(page, body) {
  const c = await page.createCDPSession();
  try {
    const {root} = await c.send('DOM.getDocument', {depth:-1, pierce:true}); let host;
    const visit = n => {if ((n.attributes||[]).includes('data-fomo-debot')) host=n; for(const k of [...(n.children||[]), ...(n.shadowRoots||[])])visit(k);}; visit(root);
    if (!host?.shadowRoots?.[0]) return null;
    const {object} = await c.send('DOM.resolveNode', {nodeId:host.shadowRoots[0].nodeId});
    const {result, exceptionDetails} = await c.send('Runtime.callFunctionOn', {objectId:object.objectId, functionDeclaration:'function(){'+body+'}', returnByValue:true});
    if(exceptionDetails)throw new Error(exceptionDetails.text);
    return result.value;
  } finally {await c.detach();}
}
const snapshot = p => shadowCall(p, 'return {text:this.querySelector(".card").textContent, visible:!this.querySelector(".card").hidden, name:this.querySelector(".name").textContent, error:this.querySelector(".slot-debot .state")?.textContent||"", views:this.querySelector(".pane-views").textContent, holders:this.querySelector(".pane-holders").textContent};');
const refresh = p => shadowCall(p, 'const b=[...this.querySelectorAll("button")].find(x=>["重新抓取","Refresh"].includes(x.title)); b.click(); return true;');
const retry = p => shadowCall(p, 'const b=[...this.querySelectorAll("button")].find(x=>["重试","Retry"].includes(x.textContent)); if(!b)return false; b.click(); return true;');
const ready = s => s?.text.includes('非托管代币发射平台');
let browser;
try {
  const hosts=['fomo.family','pro.xxyy.io','gmgn.ai','api.dexscreener.com','app.debot.ai','debot.ai','api.github.com','api.fxtwitter.com'];
  browser=await pp.launch({executablePath:'/usr/bin/chromium', headless:'new', enableExtensions:true, protocolTimeout:20000, userDataDir:temp+'/profile', acceptInsecureCerts:true, args:['--no-sandbox','--disable-dev-shm-usage','--no-proxy-server','--ignore-certificate-errors', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules='+hosts.map(h=>`MAP ${h} 127.0.0.1:${server.address().port}`).join(', ')]});
  const p=await browser.newPage(); await p.setViewport({width:1280,height:900}); p.on('pageerror',e=>errors.push(e.message));
  await p.goto('https://fomo.family/tokens/robinhood/'+CA, {waitUntil:'domcontentloaded'});
  check('installed extension reads the narrative', !!await until(async()=>ready(await snapshot(p))));
  await p.evaluate(()=>{window.__recoveryPageMarker='preserved';});
  const initialLoads=pageLoads;
  const target=await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/background.js'));
  const control=await browser.newPage();
  await control.goto(target.url().replace('/background.js','/popup.html'));
  await control.evaluate(()=>{setTimeout(()=>chrome.runtime.reload(), 50);});
  await sleep(1600);
  if (!control.isClosed()) await control.close();
  if (process.env.FOMO_RECOVERY_DEBUG) {
    const active = await (await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/background.js'))).worker();
    console.log('reload-debug', await active.evaluate(async()=>({id:chrome.runtime.id, version:chrome.runtime.getManifest().version, permissions:await chrome.permissions.getAll(), tabs:await chrome.tabs.query({url:'https://fomo.family/*'}), reconnect:typeof reconnectOpenTabs})));
  }
  await refresh(p);
  if (BASELINE) {
    await sleep(500);
    const first=await snapshot(p);
    const clicked=await retry(p); await sleep(500);
    const second=await snapshot(p);
    check('baseline reproduces refresh and retry both stuck after extension reload', clicked&&first.text.includes('这段暂时读不到')&&second.text.includes('这段暂时读不到'), {first,second});
    await p.reload({waitUntil:'domcontentloaded'});
    check('baseline full page reload restores exactly the same upstream', !!await until(async()=>ready(await snapshot(p))), {snapshot:await snapshot(p), targets:browser.targets().map(t=>({type:t.type(),url:t.url()}))});
  } else {
    check('extension reload reconnects the existing page and refresh works', !!await until(async()=>ready(await snapshot(p))));
    check('reconnect preserves the page document and leaves a single card', pageLoads===initialLoads&&await p.evaluate(()=>window.__recoveryPageMarker==='preserved'&&document.querySelectorAll('[data-fomo-debot]').length===1), {initialLoads,pageLoads});
    fail=2; const transientStart=hits.length; await refresh(p);
    check('one transient outage recovers automatically without page reload', !!await until(async()=>ready(await snapshot(p))), hits.slice(transientStart));
    check('automatic recovery is bounded to one retry round', hits.length-transientStart===3, hits.slice(transientStart));
    fail=100; const persistentStart=hits.length; await refresh(p);
    await until(async()=>(await snapshot(p))?.text.includes('这段暂时读不到')); await sleep(2000);
    check('persistent upstream outage stops after the retry budget', hits.length-persistentStart===4, hits.slice(persistentStart));
    const before=await snapshot(p); fail=0;
    const clicked=await retry(p);
    check('manual retry recovers only the failed narrative and preserves Fomo data', clicked&&!!await until(async()=>ready(await snapshot(p)))&&(await snapshot(p)).views===before.views&&(await snapshot(p)).holders===before.holders);
    const sw=await (await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/background.js'))).worker();
    const tab=await sw.evaluate(async()=> (await chrome.tabs.query({url:'https://fomo.family/*'}))[0].id);
    await sw.evaluate(async tabId=>{await Promise.all([1,2,3].map(()=>chrome.scripting.executeScript({target:{tabId,frameIds:[0]},files:['content.js']})));},tab);
    check('duplicate injection does not create extra cards', await p.evaluate(()=>document.querySelectorAll('[data-fomo-debot]').length===1));
    for (const fault of ['alive', 'dispose']) {
      // Fault the previous real isolated-world instance, as an invalidated legacy
      // extension can do; then use the actual Chrome injection/update path.
      await sw.evaluate(async ({tabId,fault})=>chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',func:kind=>{
        const old=globalThis.__fomoLensInstance;
        if(kind==='alive')old.alive=()=>{throw new Error('Extension context invalidated')};
        else {const dispose=old.dispose;old.alive=()=>false;old.dispose=()=>{dispose();throw new Error('Legacy cleanup failed')}}
      },args:[fault]}),{tabId:tab,fault});
      let injectionError=null;
      try {await sw.evaluate(async tabId=>chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',files:['content.js']}),tab)}
      catch(e){injectionError=e.message}
      const reconnected=await sw.evaluate(async tabId=>{
        const out=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',func:()=>{try{return !!globalThis.__fomoLensInstance.alive()}catch(_){return false}}});
        return out[0]?.result===true;
      },tab);
      const isFaultBaseline=process.env.FOMO_LIFECYCLE_BASELINE==='1';
      if(isFaultBaseline){
        check('baseline '+fault+' exception prevents reconnection',!reconnected,{injectionError,reconnected});
        await sw.evaluate(async tabId=>chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',func:()=>{const old=globalThis.__fomoLensInstance;try{old.dispose()}catch(_){}old.alive=()=>false;old.dispose=()=>{};}}),tab);
        await sw.evaluate(async tabId=>chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',files:['content.js']}),tab);
      } else check('legacy '+fault+' exception cannot break real reconnection',reconnected&&!injectionError&&!!await until(async()=>ready(await snapshot(p)))&&pageLoads===initialLoads&&await p.evaluate(()=>document.querySelectorAll('[data-fomo-debot]').length===1),injectionError);
      await until(async()=>ready(await snapshot(p)));
    }
    fail=2; const raceStart=hits.length; await refresh(p);
    await until(async()=>hits.length-raceStart>=2);
    fail=0; await p.evaluate(next=>history.pushState({},'', '/tokens/robinhood/'+next),NEXT);
    await until(async()=>(await snapshot(p))?.name==='NEXT'); await sleep(1500);
    check('switching tokens cancels the obsolete automatic retry', (await snapshot(p))?.name==='NEXT'&&hits.slice(raceStart).filter(h=>h.ca===CA).length===2, hits.slice(raceStart));

    await shadowCall(p, 'this.querySelector(".x").click();');
    const launcherState = () => shadowCall(p, 'const b=this.querySelector(".launcher"),r=b.getBoundingClientRect();return {visible:!b.hidden,x:r.x,y:r.y,w:r.width,h:r.height,label:b.getAttribute("aria-label"),tip:getComputedStyle(b.querySelector(".launcher-tip")).visibility};');
    let button=await launcherState();
    check('close leaves a small visible and labelled reopen button', button.visible&&button.w===44&&button.h===44&&button.label==='打开 Fomo Lens', button);
    await p.mouse.move(1100,600);
    await p.screenshot({path:OUT+'/launcher-idle.png'});
    await p.mouse.move(button.x+22,button.y+22); await sleep(200);
    check('hover explains the button without expanding its hit area', (await launcherState()).tip==='visible'&&(await launcherState()).w===44);
    await p.screenshot({path:OUT+'/launcher-hover.png'});
    await p.mouse.click(button.x+22,button.y+22);
    check('reopen button restores the current token without page refresh', !!await until(async()=>{const s=await snapshot(p);return s?.visible&&s.name==='NEXT';}));
    await p.evaluate(()=>history.pushState({},'', '/')); await sleep(400);
    const row=await p.$eval('#row-anchor-pons',e=>{const r=e.getBoundingClientRect();return {x:r.x+45,y:r.y+r.height/2};});
    await p.mouse.move(row.x,row.y);
    check('list-page hover opens a different token preview', !!await until(async()=>{const s=await snapshot(p);return s?.visible&&s.name==='PONS';}));
    await shadowCall(p, 'this.querySelector(".x").click();');
    button=await launcherState(); await p.mouse.click(button.x+22,button.y+22);
    check('list-page reopen remembers the dismissed token without a token URL', !!await until(async()=>{const s=await snapshot(p);return s?.visible&&s.name==='PONS';})&&new URL(p.url()).pathname==='/');
    await p.keyboard.press('Escape');
    await shadowCall(p, 'this.querySelector(".launcher").focus();');
    await p.keyboard.press('Enter');
    check('keyboard Enter also restores the card', !!await until(async()=> (await snapshot(p))?.visible));
    await p.keyboard.press('Escape'); button=await launcherState();
    await p.mouse.move(button.x+22,button.y+22); await p.mouse.down();
    await p.mouse.move(540,360,{steps:10}); await p.mouse.up(); await sleep(200);
    const dragged=await launcherState();
    check('dragging the launcher moves it without opening the card', dragged.visible&&Math.abs(dragged.x-518)<3&&!(await snapshot(p))?.visible, dragged);
    const stored=await sw.evaluate(async()=> (await chrome.storage.local.get('launcherPos')).launcherPos);
    check('launcher position is saved', stored&&Math.abs(stored.left-dragged.x)<2&&Math.abs(stored.top-dragged.y)<2, stored);
    await p.setViewport({width:360,height:640}); await sleep(150); button=await launcherState();
    check('viewport shrink keeps the launcher reachable', button.visible&&button.x>=0&&button.x+button.w<=360&&button.y>=0&&button.y+button.h<=640,button);
    await p.mouse.click(button.x+22,button.y+22);
    check('reopen still works after window resize', !!await until(async()=> (await snapshot(p))?.visible));
    check('all recovery actions keep the original page', await p.evaluate(()=>window.__recoveryPageMarker==='preserved'));
    const expectedFaults=process.env.FOMO_LIFECYCLE_BASELINE==='1'?['Extension context invalidated','Legacy cleanup failed']:[];
    check('no unexpected content script exceptions', errors.every(e=>expectedFaults.includes(e)), errors);
  }
} catch(e) {check('recovery regression executes',false,e.stack);}
finally {if(browser)await browser.close(); server.closeAllConnections(); await new Promise(r=>server.close(r)); fs.rmSync(temp,{recursive:true,force:true});}
fs.writeFileSync(OUT+'/receipt.json',JSON.stringify({version:JSON.parse(fs.readFileSync(EXT+'/manifest.json')).version, baseline:BASELINE, checks, hits, errors},null,2));
process.exit(checks.every(c=>c.ok)?0:1);
