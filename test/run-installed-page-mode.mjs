// Installed MV3 acceptance: independent CA-page opening, hover, SPA navigation and migration.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pp from '/usr/local/lib/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import {lensEval,lensSnapshot,lensClick,sleep,until} from './launcher-browser.mjs';
const DIR=path.dirname(fileURLToPath(import.meta.url));
const EXT=process.env.FOMO_EXTENSION_DIR||path.resolve(DIR,'..');
const OUT=process.env.FOMO_TEST_OUTPUT||path.join(DIR,'screenshots/installed-page-mode');
fs.mkdirSync(OUT,{recursive:true});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fomo-page-mode-'));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',temp+'/key','-out',temp+'/cert','-days','2','-subj','/CN=fomo.family'],{stdio:'ignore'});
const CA='0x39dbed3a2bd333467115de45665cc57f813c4571';
const OTHER='0x020bfc650a365f8bb26819deaabf3e21291018b4';
const POOL='0x1d767e12f99d8c7ac792749209868a1fafec6e1599b5cb9f4582bf5525793598';
const checks=[],errors=[],hits=[];
const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,...(!ok?{detail}:{})});console.log((ok?'PASS ':'FAIL ')+name)};
let delayResolve=false;
const server=https.createServer({key:fs.readFileSync(temp+'/key'),cert:fs.readFileSync(temp+'/cert')},(req,res)=>{
  const u=new URL(req.url,'https://'+req.headers.host);
  hits.push({host:u.hostname,path:u.pathname});
  const reply=(body,type='text/html')=>{res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(body)};
  if(u.pathname.startsWith('/fixtures/'))return reply(fs.readFileSync(DIR+u.pathname),'text/javascript');
  if(u.hostname==='fomo.family')return reply(fs.readFileSync(DIR+'/mock-fomo.html'));
  if(u.hostname==='gmgn.ai')return reply(fs.readFileSync(DIR+'/mock-gmgn-installed.html'));
  if(['www.xxyy.io','pro.xxyy.io'].includes(u.hostname))return reply(fs.readFileSync(DIR+'/mock-xxyy-layouts.html'));
  if(u.hostname==='api.dexscreener.com'){
    const send=()=>reply(JSON.stringify({pairs:u.pathname.includes(POOL)?[{chainId:'robinhood',pairAddress:POOL,baseToken:{address:CA}}]:[]}),'application/json');
    if(delayResolve&&u.pathname.includes(POOL))return setTimeout(send,1500);
    return send();
  }
  if(/debot\.ai$/.test(u.hostname)){
    const address=u.searchParams.get('ca_address')||CA;
    const doc=JSON.parse(fs.readFileSync(DIR+'/fixtures/pons.json'));
    doc.data.history.ca_address=address;doc.data.history.story.contract_address=address;
    doc.data.history.name=doc.data.history.story.project_name=address.toLowerCase()===CA?'PONS':'OTHER';
    return reply(JSON.stringify(doc),'application/json');
  }
  return reply('{}','application/json');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try{
  const hosts=['fomo.family','gmgn.ai','www.xxyy.io','pro.xxyy.io','app.debot.ai','debot.ai','api.dexscreener.com','api.github.com','api.fxtwitter.com'];
  browser=await pp.launch({executablePath:'/usr/bin/chromium',headless:'new',userDataDir:temp+'/profile',acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage','--no-proxy-server','--ignore-certificate-errors',`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,'--host-resolver-rules='+hosts.map(h=>`MAP ${h} 127.0.0.1:${server.address().port}`).join(', ')]});
  const worker=await(await browser.waitForTarget(t=>t.type()==='service_worker')).worker();
  const id=await worker.evaluate(()=>chrome.runtime.id);
  await worker.evaluate(()=>chrome.storage.sync.set({updateCheck:false}));
  const p=await browser.newPage();p.on('pageerror',e=>errors.push(e.message));
  await p.setViewport({width:1360,height:900});
  await p.goto('https://fomo.family/tokens/robinhood/'+CA,{waitUntil:'domcontentloaded'});
  check('fresh install keeps default CA page opening',!!await until(async()=>(await lensSnapshot(p))?.card));
  const popup=await browser.newPage();popup.on('pageerror',e=>errors.push(e.message));await popup.setViewport({width:326,height:760});
  await popup.goto('chrome-extension://'+id+'/popup.html');
  await until(()=>popup.evaluate(()=>document.querySelector('#hoverPreview').checked));
  check('popup defaults to page open and hover on',await popup.evaluate(()=>document.querySelector('#caPageAutoOpen').value==='open'&&document.querySelector('#hoverPreview').checked));
  check('content expansion is a separate two-choice setting',await popup.evaluate(()=>Array.from(document.querySelector('#openMode').options).map(x=>x.value).join(',')==='compact,full'));
  await popup.select('#caPageAutoOpen','off');
  check('selecting page closed hides current page card immediately',!!await until(async()=>{const s=await lensSnapshot(p);return s?.launcher&&!s.card}));
  check('page setting preserves hover and compact content',await worker.evaluate(async()=>{const s=await chrome.storage.sync.get(null);return s.caPageAutoOpen===false&&s.hoverPreview!==false&&s.openMode==='compact'}));
  await popup.screenshot({path:OUT+'/settings-zh.png'});
  await popup.select('#lang','en');
  check('English labels explain page behavior and independent hover',await popup.evaluate(()=>document.documentElement.lang==='en'&&document.querySelector('[data-i18n="caPage"]').textContent==='Current CA page'&&document.querySelector('[data-i18n="caPageHint"]').textContent.includes('Hover previews still work')));
  await popup.screenshot({path:OUT+'/settings-en.png'});
  check('settings fit the existing narrow popup',await popup.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await popup.select('#lang','zh');
  for(const [site,route,row] of [
    ['fomo','https://fomo.family/tokens/robinhood/'+CA,'#row-anchor-cashcat a'],
    ['gmgn','https://gmgn.ai/robinhood/token/'+CA,'#react .sym'],
    ['xxyy-old','https://www.xxyy.io/robin/'+CA,'#f1 .name'],
    ['xxyy-new','https://pro.xxyy.io/robin/'+CA,'#f1 .name'],
  ]){
    await p.bringToFront();await p.mouse.move(800,700);
    await p.goto(route,{waitUntil:'domcontentloaded'});await until(async()=>(await lensSnapshot(p))?.launcher);await sleep(750);
    check(site+' page stays closed on load',!(await lensSnapshot(p)).card);
    await p.hover(row);await sleep(150);await p.mouse.move(800,700);await sleep(700);
    check(site+' quick pass does not pop up',!(await lensSnapshot(p)).card);
    await p.hover(row);
    check(site+' dwell still opens hover preview with page disabled',!!await until(async()=>{const s=await lensSnapshot(p);return s?.card&&s.preview}));
    await p.mouse.move(800,700);await sleep(850);
    check(site+' leaving hover returns to closed page',!(await lensSnapshot(p)).card);
    await p.hover(row);await until(async()=>(await lensSnapshot(p))?.preview);
    // Real row click for Fomo/GMGN; emulate XXYY's router after its real Vue hover.
    if(site==='fomo'||site==='gmgn')await p.click(row);
    else await p.evaluate(ca=>history.pushState({},'', '/robin/'+ca),OTHER);
    await p.mouse.move(800,700);await sleep(900);
    check(site+' navigation out of preview does not open a CA page card',!(await lensSnapshot(p)).card);
    await lensClick(p,'.launcher');
    check(site+' manual entry opens the current CA',!!await until(async()=>{const s=await lensSnapshot(p);return s?.card&&!s.preview&&s.name==='OTHER'}));
    await p.evaluate(url=>history.pushState({},'',url),route);await sleep(650);
    check(site+' next CA starts closed even after manual opening',!(await lensSnapshot(p)).card);
    await popup.select('#caPageAutoOpen','open');
    check(site+' enabling page opening applies without refresh',!!await until(async()=>{const s=await lensSnapshot(p);return s?.card&&!s.preview&&s.name==='PONS'}));
    await lensClick(p,'.btn.x');await sleep(700);
    check(site+' manual close is respected while page opening is enabled',!(await lensSnapshot(p)).card);
    await p.reload({waitUntil:'domcontentloaded'});
    check(site+' enabled page opens on reload',!!await until(async()=>(await lensSnapshot(p))?.card));
    await popup.select('#caPageAutoOpen','off');await until(async()=>!(await lensSnapshot(p))?.card);
  }
  await popup.select('#openMode','full');
  check('changing content expansion does not turn page opening back on',await worker.evaluate(async()=>{const s=await chrome.storage.sync.get(null);return s.caPageAutoOpen===false&&s.openMode==='full'}));
  await p.bringToFront();await p.hover('#f1 .name');await until(async()=>(await lensSnapshot(p))?.preview);
  await popup.select('#caPageAutoOpen','open');
  check('changing page preference preserves an active hover preview',(await lensSnapshot(p)).preview);
  await p.mouse.move(800,700);
  check('leaving preview restores current CA when enabled',!!await until(async()=>{const s=await lensSnapshot(p);return s?.card&&!s.preview&&s.name==='PONS'}));
  // A slow XXYY pool response must not reopen a card after the preference changed.
  delayResolve=true;await worker.evaluate(()=>chrome.storage.session.clear());
  await p.goto('https://pro.xxyy.io/robin/'+POOL,{waitUntil:'domcontentloaded'});
  await until(()=>hits.some(x=>x.host==='api.dexscreener.com'&&x.path.includes(POOL)));
  await popup.select('#caPageAutoOpen','off');await sleep(2100);
  check('late pool resolution cannot override page closed preference',!(await lensSnapshot(p)).card);
  delayResolve=false;
  // Legacy values must be honored both before opening the new popup and after migration.
  await popup.close();
  for(const [name,seed,open,layout] of [
    ['legacy off',{openMode:'off',hoverPreview:true},false,'full'],
    ['legacy autoOpen false',{autoOpen:false,hoverPreview:true},false,'full'],
    ['legacy full',{openMode:'full',hoverPreview:false},true,'full'],
    ['legacy compact',{openMode:'compact'},true,'compact'],
    ['explicit page false',{openMode:'full',caPageAutoOpen:false},false,'full'],
    ['explicit page true overrides old off',{openMode:'off',caPageAutoOpen:true},true,'full'],
  ]){
    await p.goto('about:blank');
    await worker.evaluate(async s=>{await chrome.storage.sync.clear();await chrome.storage.sync.set({updateCheck:false,...s})},seed);
    await p.goto('https://fomo.family/tokens/robinhood/'+CA,{waitUntil:'domcontentloaded'});
    await until(async()=>!!await lensSnapshot(p));await sleep(850);
    check(name+' loads with the intended page behavior',(await lensSnapshot(p)).card===open);
    const q=await browser.newPage();await q.goto('chrome-extension://'+id+'/popup.html');await sleep(200);
    const values=await q.evaluate(async()=>({page:document.querySelector('#caPageAutoOpen').value,layout:document.querySelector('#openMode').value,hover:document.querySelector('#hoverPreview').checked,storage:await chrome.storage.sync.get(null)}));
    check(name+' migrates page, content and hover independently',values.page===(open?'open':'off')&&values.layout===layout&&values.hover===(seed.hoverPreview!==false)&&values.storage.caPageAutoOpen===open&&values.storage.openMode===layout,values);
    await sleep(300);
    check(name+' migration does not unexpectedly open or close the page',(await lensSnapshot(p)).card===open);
    if(!open){await p.bringToFront();await p.hover('#row-anchor-cashcat a');check(name+' still allows default hover',!!await until(async()=>(await lensSnapshot(p))?.preview));}
    await q.close();
  }
  check('no page errors or product test hooks',errors.length===0&&await p.evaluate(()=>!window.__FOMO_DEBOT_TEST__&&!window.__fomoDebotTestHandle),errors);
}catch(e){check('page-mode acceptance completes',false,e.stack)}
finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true})}
fs.writeFileSync(OUT+'/receipt.json',JSON.stringify({version:JSON.parse(fs.readFileSync(EXT+'/manifest.json')).version,checks,errors},null,2));
process.exit(checks.every(c=>c.ok)?0:1);
