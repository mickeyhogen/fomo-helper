// Final ZIP / real MV3 / isolated world / trusted mouse input. No product test hooks.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pp from '/usr/local/lib/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import {lensEval,lensSnapshot,lensPoint,lensClick,sleep,until} from './launcher-browser.mjs';
const DIR=path.dirname(fileURLToPath(import.meta.url));
const EXT=process.env.FOMO_EXTENSION_DIR||path.resolve(DIR,'..');
const OUT=process.env.FOMO_TEST_OUTPUT||path.join(DIR,'screenshots/installed-launcher');
fs.mkdirSync(OUT,{recursive:true});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fomo-launcher-'));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',temp+'/key','-out',temp+'/cert','-days','2','-subj','/CN=fomo.family'],{stdio:'ignore'});
const CA='0x39dbed3a2bd333467115de45665cc57f813c4571';
const OTHER='0x020bfc650a365f8bb26819deaabf3e21291018b4';
const POOL='0x1d767e12f99d8c7ac792749209868a1fafec6e1599b5cb9f4582bf5525793598';
const checks=[],errors=[];
const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,...(!ok?{detail}:{})});console.log((ok?'PASS ':'FAIL ')+name)};
const fomo=fs.readFileSync(DIR+'/mock-fomo-mirror.html','utf8');
const server=https.createServer({key:fs.readFileSync(temp+'/key'),cert:fs.readFileSync(temp+'/cert')},(req,res)=>{
  const u=new URL(req.url,'https://'+req.headers.host);
  const reply=(body,type='text/html')=>{res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(body)};
  if(u.pathname.startsWith('/fixtures/'))return reply(fs.readFileSync(DIR+u.pathname),'text/javascript');
  if(u.hostname==='fomo.family')return reply(fomo);
  if(u.hostname==='gmgn.ai')return reply(fs.readFileSync(DIR+'/mock-gmgn-installed.html'));
  if(['www.xxyy.io','pro.xxyy.io'].includes(u.hostname))return reply(fs.readFileSync(DIR+'/mock-xxyy-layouts.html'));
  if(u.hostname==='api.dexscreener.com')return reply(JSON.stringify({pairs:u.pathname.includes(POOL)?[{chainId:'robinhood',pairAddress:POOL,baseToken:{address:CA}}]:[]}),'application/json');
  if(/debot\.ai$/.test(u.hostname)){
    const address=u.searchParams.get('ca_address')||CA;
    const doc=JSON.parse(fs.readFileSync(DIR+'/fixtures/pons.json'));
    doc.data.history.ca_address=address;doc.data.history.story.contract_address=address;
    doc.data.history.name=doc.data.history.story.project_name=address.toLowerCase()===OTHER?'OTHER':'PONS';
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
  await worker.evaluate(()=>chrome.storage.sync.set({lang:'zh',updateCheck:false,openMode:'full'}));
  const p=await browser.newPage();p.on('pageerror',e=>errors.push(e.message));
  await p.setViewport({width:1360,height:900});
  for(const [site,route] of [['fomo','https://fomo.family/tokens/robinhood/'+CA],['gmgn','https://gmgn.ai/robinhood/token/'+CA],['xxyy-old','https://www.xxyy.io/robin/'+POOL],['xxyy-new','https://pro.xxyy.io/robin/'+POOL]]){
    await p.goto(route,{waitUntil:'domcontentloaded'});
    check(site+' default current-token card',!!await until(async()=>(await lensSnapshot(p))?.card));
    const marker=await p.evaluate(()=>window.__launcherDocumentMarker=Math.random());
    await lensClick(p,'.btn.x');await sleep(160);
    let s=await lensSnapshot(p);
    check(site+' close leaves visible clickable launcher',!s.card&&s.launcher&&s.inViewport&&s.hit,s);
    check(site+' launcher identifies itself without hovering',s.label==='Fomo Lens',s);
    const point=await lensPoint(p,'.launcher');await p.mouse.move(point.x,point.y);await sleep(250);
    s=await lensSnapshot(p);check(site+' hover explains reopen and drag',s.tooltip==='visible'&&s.hint.includes('拖动'),s);
    await p.screenshot({path:OUT+'/'+site+'-closed.png'});
    await lensClick(p,'.launcher');
    check(site+' actual click restores card without refresh',!!await until(async()=>{const s=await lensSnapshot(p);return s?.card&&!s.launcher;})&&await p.evaluate(x=>window.__launcherDocumentMarker===x,marker));
    check(site+' reopen remains on the current token',p.url()===route&&(await lensSnapshot(p)).preview===false);
    for(let i=0;i<3;i++){await lensClick(p,'.btn.x');await sleep(100);await lensClick(p,'.launcher');check(site+' repeated reopen '+i,!!await until(async()=>(await lensSnapshot(p))?.card));}
    await p.keyboard.press('Escape');await sleep(100);s=await lensSnapshot(p);
    check(site+' Escape leaves a recoverable entry',!s.card&&s.launcher&&s.hit,s);
    await lensClick(p,'.launcher');await until(async()=>(await lensSnapshot(p))?.card);
    await p.mouse.click(800,780);await sleep(150);s=await lensSnapshot(p);
    check(site+' outside click leaves a recoverable entry',!s.card&&s.launcher&&s.hit,s);
    await lensClick(p,'.launcher');await until(async()=>(await lensSnapshot(p))?.card);
  }
  // Drag, then resize: the whole expanded-width launcher must remain visible.
  await lensClick(p,'.btn.x');await sleep(100);
  let pt=await lensPoint(p,'.launcher');await p.mouse.move(pt.x,pt.y);await p.mouse.down();await p.mouse.move(1340,880,{steps:8});await p.mouse.up();await sleep(100);
  check('drag does not accidentally reopen',!(await lensSnapshot(p)).card);
  await p.setViewport({width:390,height:740});await sleep(200);
  let s=await lensSnapshot(p);check('narrow viewport keeps complete launcher clickable',s.launcher&&s.inViewport&&s.hit,s);
  await p.screenshot({path:OUT+'/narrow-closed.png'});
  await lensClick(p,'.launcher');check('first click after drag can reopen',!!await until(async()=>(await lensSnapshot(p))?.card));
  await p.setViewport({width:1360,height:900});
  await worker.evaluate(()=>chrome.storage.sync.set({lang:'en',openMode:'off'}));
  await p.goto('https://www.xxyy.io/robin/'+POOL,{waitUntil:'domcontentloaded'});
  await until(async()=>(await lensSnapshot(p))?.launcher);
  s=await lensSnapshot(p);check('English manual mode keeps an understandable entry',!s.card&&s.launcher&&s.aria.includes('Fomo Lens')&&s.hint.includes('Drag'),s);
  const next='https://www.xxyy.io/robin/'+OTHER;
  await p.evaluate(url=>history.pushState({},'',url),next);await sleep(400);
  await lensClick(p,'.launcher');
  check('manual entry follows SPA current CA instead of last closed token',!!await until(async()=>{const s=await lensSnapshot(p);return s?.card&&s.name==='OTHER';}));
  await p.screenshot({path:OUT+'/english-reopened.png'});
  for(const key of ['Enter','Space']){
    await lensClick(p,'.btn.x');await sleep(150);
    await lensEval(p,'this.querySelector(".launcher").focus();');
    await p.keyboard.press(key);
    check('keyboard '+key+' reopens the current card',!!await until(async()=>(await lensSnapshot(p))?.card));
  }
  await lensClick(p,'.btn.x');await sleep(150);
  await p.setViewport({width:900,height:740,hasTouch:true});await sleep(200);
  await lensEval(p,`window.__touchEvents=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel','click'])this.querySelector('.launcher').addEventListener(type,e=>window.__touchEvents.push({type:e.type,x:e.clientX,y:e.clientY,detail:e.detail,primary:e.isPrimary,button:e.button}));`);
  pt=await lensPoint(p,'.launcher');
  await p.touchscreen.touchStart(pt.x,pt.y);
  await p.touchscreen.touchMove(180,220);await p.touchscreen.touchEnd();await sleep(200);
  s=await lensSnapshot(p);check('touch drag moves the entry without opening',!s.card&&s.launcher&&s.inViewport&&s.rect.x<240,s);
  pt=await lensPoint(p,'.launcher');await p.touchscreen.tap(pt.x,pt.y);
  check('touch tap reopens after dragging',!!await until(async()=>(await lensSnapshot(p))?.card),{state:await lensSnapshot(p),events:await p.evaluate(()=>window.__touchEvents)});
  await lensClick(p,'.btn.x');await sleep(150);
  await p.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  check('reduced-motion setting suppresses entry animation',await lensEval(p,'return getComputedStyle(this.querySelector(".launcher")).animationName==="none";'));
  check('no injected test globals or page errors',errors.length===0&&await p.evaluate(()=>!window.__FOMO_DEBOT_TEST__&&!window.__fomoDebotTestHandle),errors);
}catch(e){check('launcher acceptance completes',false,e.stack)}
finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true})}
fs.writeFileSync(OUT+'/receipt.json',JSON.stringify({version:JSON.parse(fs.readFileSync(EXT+'/manifest.json')).version,checks,errors},null,2));
process.exit(checks.every(c=>c.ok)?0:1);
