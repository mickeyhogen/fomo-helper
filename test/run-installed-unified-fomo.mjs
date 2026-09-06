/** Installed GMGN + Fomo parity acceptance. Real extension worlds/messages/tabs;
 * local HTTPS supplies only page/API fixtures. No product test flag is enabled. */
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pp from '/usr/local/lib/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
const DIR=path.dirname(fileURLToPath(import.meta.url));
const EXT=path.resolve(process.env.FOMO_EXTENSION_DIR||path.join(DIR,'..'));
const REFERENCE=path.resolve(process.env.FOMO_REFERENCE_DIR||EXT);
const OUT=path.resolve(process.env.FOMO_TEST_OUTPUT||path.join(DIR,'screenshots/installed-gmgn-fomo'));
const TARGET=process.env.FOMO_TARGET_SITE==='xxyy'?'xxyy':'gmgn';
const SITE_HOST=TARGET==='xxyy'?(process.env.FOMO_XXYY_HOST==='www.xxyy.io'?'www.xxyy.io':'pro.xxyy.io'):'gmgn.ai';
const tokenPath=(ca,chain='eth')=>'/'+chain+(TARGET==='xxyy'?'/':'/token/')+ca;
const tokenUrl=(ca,chain='eth')=>'https://'+SITE_HOST+tokenPath(ca,chain);
const LANG=process.env.FOMO_UI_LANG==='en'?'en':'zh';
const SITE_LANG=process.env.FOMO_SITE_LANG==='zh'?'zh':'en';
const COPY=LANG==='en'?{refresh:'Refresh',login:'Log in to fomo first',unavailable:'make sure you are logged in',share:'fomo share',held:'held ',cost:'cost ',sort:'By likes'}:{refresh:'重新抓取',login:'需要先登录 fomo',unavailable:'确认已登录',share:'Fomo 持仓',held:'持有 ',cost:'成本 ',sort:'按赞'};
const refreshSelector=`button[title="${COPY.refresh}"]`;
fs.mkdirSync(OUT,{recursive:true});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'gmgn-fomo-parity-'));
const refDir=path.join(temp,'reference');fs.mkdirSync(refDir);
const hashes={};
for(const n of ['content.js','background.js','manifest.json']){
 const data=fs.readFileSync(path.join(REFERENCE,n));hashes[n]=crypto.createHash('sha256').update(data).digest('hex');fs.writeFileSync(path.join(refDir,n),data);
}
for(const n of ['popup.html','popup.js'])fs.copyFileSync(path.join(REFERENCE,n),path.join(refDir,n));
fs.cpSync(path.join(EXT,'icons'),path.join(refDir,'icons'),{recursive:true});
const referenceManifest=JSON.parse(fs.readFileSync(path.join(refDir,'manifest.json')));
referenceManifest.name='Fomo parity reference';delete referenceManifest.action;delete referenceManifest.key;
referenceManifest.content_scripts[0].matches=['https://reference.fomo.family/*'];
fs.writeFileSync(path.join(refDir,'manifest.json'),JSON.stringify(referenceManifest));
// Map only the disposable reference copy onto its fixture hostname. The candidate
// retains its production allowlist and is installed byte-for-byte unchanged.
const refContent=fs.readFileSync(path.join(refDir,'content.js'),'utf8');
fs.writeFileSync(path.join(refDir,'content.js'),refContent.replace(
 "['fomo.family', 'gmgn.ai', 'pro.xxyy.io', 'www.xxyy.io'].includes(location.hostname)",
 "['fomo.family', 'gmgn.ai', 'pro.xxyy.io', 'www.xxyy.io'].includes(location.hostname.replace(/^reference\\./, ''))"));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',temp+'/key','-out',temp+'/cert','-days','2','-subj','/CN=gmgn.ai'],{stdio:'ignore'});
let gmgn=fs.readFileSync(DIR+(TARGET==='xxyy'?'/mock-xxyy.html':'/mock-gmgn-installed.html'),'utf8');
let fomo=fs.readFileSync(DIR+'/mock-fomo-mirror.html','utf8');
let login=fs.readFileSync(DIR+'/mock-fomo-login.html','utf8');
if(SITE_LANG==='zh'){
 const dict={'Holders (128)':'持有者 (128)','Thesis (4,933)':'观点 (255)','Friends only':'仅看好友','Thesis only':'仅看观点','Avg. entry':'平均买入价','Market cap':'市值',Trader:'交易者',Position:'持仓',PnL:'盈亏',Thesis:'观点',Swaps:'交易',Alerts:'通知'};
 const sourceTranslation=`<script>const dict=${JSON.stringify(dict)};const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);const ns=[];while(w.nextNode())ns.push(w.currentNode);for(const n of ns){let v=n.nodeValue;v=v.replace(/(\\d+d \\d+h) avg\\. hold/g,'平均持仓 $1');for(const [k,t] of Object.entries(dict))v=v.split(k).join(t);n.nodeValue=v;}document.documentElement.lang='zh-CN';</script>`;
 fomo=fomo.replace('</body>',sourceTranslation+'</body>');
 login=login.replace('lang="en"','lang="zh-CN"').replace('>Log in<','>登录<');
 gmgn=gmgn.replace('lang="en"','lang="zh-CN"').replaceAll('Friends Only','仅看好友').replaceAll('>Track<','>追踪<');
}
const CA='0x39dbed3a2bd333467115de45665cc57f813c4571',AUTH='0x1111111111111111111111111111111111111111',UNAVAILABLE='0x2222222222222222222222222222222222222222';
const SLOW_MULTI='0x7777777777777777777777777777777777777777',FAST_MULTI='0x8888888888888888888888888888888888888888';
const HYDRATING='0x9999999999999999999999999999999999999999';
const MANY_THESIS='0x6666666666666666666666666666666666666666';
const manyThesis=fomo.replace('</body>',()=>`<script>
const firstHolder=document.querySelector('#holders .hrow');
for(let i=0;i<37;i++){
 const row=firstHolder.cloneNode(true),author=row.querySelector('.htrader');
 author.textContent='mirror_user_'+i;author.href='/profile/mirror_user_'+i;
 row.querySelector('.hpos').textContent='$'+(10+i);
 row.querySelector('.hthesis').textContent=(70-i)+' Unique mirror thesis '+i;
 firstHolder.parentElement.appendChild(row);
}
</script></body>`);
const edgeCaps=new Map([
 ['0x3333333333333333333333333333333333333333','$200M'],
 ['0x4444444444444444444444444444444444444444','$440K'],
 ['0x5555555555555555555555555555555555555555','$329.6K'],
]);
let authenticated=false;
const seen=[],checks=[],errors=[];
const server=https.createServer({key:fs.readFileSync(temp+'/key'),cert:fs.readFileSync(temp+'/cert')},(req,res)=>{
 const u=new URL(req.url,'https://'+req.headers.host),reply=(body,type='text/html',status=200)=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store'});res.end(body)};
 if(u.hostname===SITE_HOST)return reply(gmgn);
 if(u.hostname==='gmgn.ai'||u.hostname==='pro.xxyy.io'||u.hostname==='www.xxyy.io')return reply(gmgn);
 if(u.hostname==='fomo.family'||u.hostname==='reference.fomo.family'){
  if(u.pathname.endsWith('/'+MANY_THESIS)){if(u.hostname==='fomo.family')seen.push(u.pathname);return reply(manyThesis)}
  if(u.hostname==='reference.fomo.family'){const cap=edgeCaps.get(u.pathname.split('/').at(-1));return reply(cap?fomo.replace('id="mc-val">$300K','id="mc-val">'+cap):fomo)}
  seen.push(u.pathname);
  if(u.pathname.endsWith('/'+AUTH)&&!authenticated)return reply(login);
  if(u.pathname.endsWith('/'+UNAVAILABLE))return reply('<!doctype html><title>Temporarily unavailable</title><p>Try later</p>','text/html',503);
  if(u.pathname.endsWith('/'+SLOW_MULTI)){setTimeout(()=>reply(fomo),2300);return}
  if(u.pathname.endsWith('/'+HYDRATING)){
   if(u.searchParams.has('owner'))return reply('<!doctype html><html><body><p>Loading holders…</p></body></html>');
   const head=fomo.match(/<head>([\s\S]*?)<\/head>/i)[1],body=fomo.match(/<body>([\s\S]*?)<\/body>/i)[1];
   return reply('<!doctype html><html><head>'+head+'</head><body><button>Log in</button><template id="ready-content">'+body+'</template><script>const ready=document.querySelector("#ready-content").innerHTML;setTimeout(()=>{document.body.innerHTML=ready},1700)</script></body></html>');
  }
  const cap=edgeCaps.get(u.pathname.split('/').at(-1));if(cap)return reply(fomo.replace('id="mc-val">$300K','id="mc-val">'+cap));
  return reply(u.pathname.includes('/bnb/')?fomo.replaceAll('$29.4K','$39.4K'):fomo);
 }
 if(u.hostname==='api.dexscreener.com')return reply('{"pairs":[]}','application/json');
 return reply('{"code":-1,"error":"not covered"}','application/json');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,ok,details)=>{checks.push({name,ok:!!ok,...(!ok?{details}:{})});console.log((ok?'PASS ':'FAIL ')+name+(!ok?' '+JSON.stringify(details):''))};
async function until(fn,timeout=12000){const end=Date.now()+timeout;let last;while(Date.now()<end){last=await fn();if(last)return last;await sleep(180)}return null}
async function snapshot(page,selector='.card'){
 const c=await page.createCDPSession();try{
  const {root}=await c.send('DOM.getDocument',{depth:-1,pierce:true});let host;
  const visit=n=>{if((n.attributes||[]).includes('data-fomo-debot'))host=n;for(const k of [...(n.children||[]),...(n.shadowRoots||[])])visit(k)};visit(root);
  if(!host?.shadowRoots?.[0])return {missing:true,visible:false,text:'',allText:'',share:'',holders:'',thesis:'',links:[],holderTitles:[]};
  const {object}=await c.send('DOM.resolveNode',{nodeId:host.shadowRoots[0].nodeId});
  const {result}=await c.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(sel){const e=this.querySelector(sel);if(!e)return {missing:true,visible:false,text:""};const r=e.getBoundingClientRect(),norm=x=>(x?.textContent||"").replace(/\\s+/g," ").trim();return {visible:!e.hidden&&r.width>0&&r.height>0,text:e.innerText,allText:norm(e),rect:{x:r.x,y:r.y,w:r.width,h:r.height},tabs:[...this.querySelectorAll(".tlabel")].map(norm),share:norm(this.querySelector(".share-bar")),shareClass:this.querySelector(".share-bar")?.className,holders:norm(this.querySelector(".pane-holders")),thesis:norm(this.querySelector(".pane-views")),holderTitles:[...this.querySelectorAll(".pane-holders [title]")].map(e=>e.title),links:[...e.querySelectorAll("a")].map(a=>a.href)}}',arguments:[{value:selector}],returnByValue:true});return result.value;
 }finally{await c.detach()}
}
async function click(page,sel){const s=await snapshot(page,sel);if(!s.visible)throw Error('Control missing: '+sel);await page.mouse.click(s.rect.x+s.rect.w/2,s.rect.y+s.rect.h/2);await sleep(200)}
async function setLanguage(browser,name){
 const worker=await until(async()=>{for(const t of browser.targets().filter(t=>t.type()==='service_worker')){try{const w=await t.worker();if(await w.evaluate(()=>chrome.runtime.getManifest().name)===name)return t}catch{}}return null});
 if(!worker)throw Error('Extension worker not found: '+name);
 const p=await browser.newPage();try{
  await p.setViewport({width:330,height:600});await p.goto('chrome-extension://'+new URL(worker.url()).host+'/popup.html');await p.select('#lang',LANG);await sleep(250);if(await p.$eval('#lang',e=>e.value)!==LANG)throw Error('Language not selected');
  if(name==='Fomo Lens'){
   const labels=await p.$$eval('[data-i18n]',es=>es.map(e=>e.textContent));
   check('settings labels and help follow the chosen language',LANG==='en'?labels.length>=18&&labels.every(s=>!/[\u3400-\u9fff]/.test(s)):labels.includes('默认语言'),labels);
   check('settings fit the popup width in the chosen language',await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   check('public settings omit custom sources and keep update control',await p.evaluate(()=>!document.querySelector('#analysisTemplate')&&!document.querySelector('#detailTemplate')&&!document.querySelector('#updateCheck').disabled));
   await p.evaluate(()=>window.scrollTo(0,0));await p.screenshot({path:OUT+'/settings.png',fullPage:true});
  }
 }finally{await p.close()}
}
let browser;
try{
 const hosts=['gmgn.ai','pro.xxyy.io','www.xxyy.io','fomo.family','reference.fomo.family','api.dexscreener.com','app.debot.ai','debot.ai','api.github.com','api.fxtwitter.com'];
 browser=await pp.launch({executablePath:'/usr/bin/chromium',headless:'new',userDataDir:temp+'/profile',acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage','--ignore-certificate-errors','--no-proxy-server',`--disable-extensions-except=${EXT},${refDir}`,`--load-extension=${EXT},${refDir}`,'--host-resolver-rules='+hosts.map(h=>`MAP ${h} 127.0.0.1:${server.address().port}`).join(', ')]});
 await setLanguage(browser,JSON.parse(fs.readFileSync(EXT+'/manifest.json')).name);await setLanguage(browser,'Fomo parity reference');
 const reference=await browser.newPage();await reference.setViewport({width:1280,height:900});await reference.goto('https://fomo.family/tokens/ethereum/'+CA,{waitUntil:'domcontentloaded'});
 const comparison=await browser.newPage();await comparison.setViewport({width:1280,height:900});await comparison.goto('https://reference.fomo.family/tokens/ethereum/'+CA,{waitUntil:'domcontentloaded'});
 const expected=await until(async()=>{const s=await snapshot(comparison);return s.visible&&s.share.includes('21.9%')?s:null});
 check('current Fomo reference renders holdings and share',!!expected,expected);
 check('unified package creates exactly one native Fomo card',await reference.evaluate(()=>document.querySelectorAll('[data-fomo-debot]').length)===1);
 const initialFomoReads=seen.length;
 const page=await browser.newPage();await page.setViewport({width:1280,height:900});page.on('pageerror',e=>errors.push(e.message));await page.goto(tokenUrl(CA),{waitUntil:'domcontentloaded'});
 let actual=await until(async()=>{const s=await snapshot(page);return s.visible&&s.share.includes('21.9%')?s:null});
 check('target site displays Meta, Thesis and Holders',actual?.tabs.join('|')==='Meta|Thesis|Holders',actual);
 check('Fomo share, numerator, cap, coverage and lower-bound marker match',!!actual&&!!expected&&actual.share===expected.share,{actual:actual?.share,expected:expected?.share});
 check('holders, position, PnL, duration and entry details match Fomo',!!actual&&!!expected&&actual.holders===expected.holders&&JSON.stringify(actual.holderTitles)===JSON.stringify(expected.holderTitles),{actual:actual?.holders,expected:expected?.holders});
 check('Thesis contents and order match the current Fomo plugin',!!actual&&!!expected&&actual.thesis===expected.thesis,{actual:actual?.thesis,expected:expected?.thesis});
 check('selected UI language covers share, hold duration, entry cost and Thesis sorting',!!actual&&actual.share.includes(COPY.share)&&actual.holders.includes(COPY.held)&&actual.holderTitles.some(t=>t.startsWith(COPY.cost))&&actual.thesis.includes(COPY.sort),{language:LANG,siteLanguage:SITE_LANG,share:actual?.share,thesis:actual?.thesis});
 check('existing same-token Fomo page is reused without opening another tab',seen.length===initialFomoReads,{before:initialFomoReads,after:seen.length});
 await click(page,'[data-tab="holders"]');const holders=await snapshot(page,'.pane-holders');check('holders are visibly usable after switching tabs',holders.visible&&holders.text.includes('$29.4K'),holders);await page.screenshot({path:OUT+'/holders.png'});
 await click(page,'[data-tab="views"]');const thesis=await snapshot(page,'.pane-views');check('Thesis is visibly usable after switching tabs',thesis.visible&&thesis.text.includes('You can now see which tokens distribute creator rewards'),thesis);await page.screenshot({path:OUT+'/thesis.png'});
 await reference.evaluate(()=>{document.querySelector('.hpos').textContent='$31.4K';window.scrollTo(0,70)});
 await click(reference,refreshSelector);
 const updatedReference=await until(async()=>{const s=await snapshot(reference);return s.holders.includes('$31.4K')?s:null});
 const ownerState=await reference.evaluate(()=>({url:location.href,scrollY,body:document.body.innerHTML}));
 await click(page,refreshSelector);
 actual=await until(async()=>{const s=await snapshot(page);return s.holders.includes('$31.4K')?s:null});
 check('refresh mirrors the existing page coverage and updated holdings',!!actual&&actual.holders===updatedReference?.holders&&seen.length===initialFomoReads,actual?.holders);
 const afterOwnerState=await reference.evaluate(()=>({url:location.href,scrollY,body:document.body.innerHTML}));
 check('reading an existing Fomo tab does not click, scroll or navigate it',JSON.stringify(ownerState)===JSON.stringify(afterOwnerState));
 await reference.goto('about:blank');
 await click(page,refreshSelector);
 actual=await until(async()=>{const s=await snapshot(page);return s.holders.includes('$29.4K')?s:null});
 check('without an existing token page the background fallback reads the same Fomo fields',!!actual&&actual.holders===expected?.holders&&actual.thesis===expected?.thesis&&actual.share===expected?.share,{actual:actual?.holders,expected:expected?.holders});
 for(const [edgeCa,cap] of edgeCaps){
  await reference.goto('https://fomo.family/tokens/ethereum/'+edgeCa,{waitUntil:'domcontentloaded'});
  await comparison.goto('https://reference.fomo.family/tokens/ethereum/'+edgeCa,{waitUntil:'domcontentloaded'});
  const ref=await until(async()=>{const s=await snapshot(comparison);return s.visible&&s.share.includes(cap)?s:null});
  await page.evaluate(url=>history.pushState({},'',url),tokenPath(edgeCa));
  const mirror=await until(async()=>{const s=await snapshot(page);return s.share.includes(cap)?s:null});
  check('rounded percentage and stars match Fomo at market cap '+cap,!!ref&&!!mirror&&ref.share===mirror.share&&ref.shareClass===mirror.shareClass,{ref:ref?.share,mirror:mirror?.share,refClass:ref?.shareClass,mirrorClass:mirror?.shareClass});
 }
 await reference.goto('https://fomo.family/tokens/ethereum/'+MANY_THESIS,{waitUntil:'domcontentloaded'});
 await comparison.goto('https://reference.fomo.family/tokens/ethereum/'+MANY_THESIS,{waitUntil:'domcontentloaded'});
 check('large Thesis fixture contains all 43 holder rows',await comparison.$$eval('#holders .hrow .htrader',rows=>rows.length)===43);
 const manyReference=await until(async()=>{const s=await snapshot(comparison);return s.thesis.includes('Unique mirror thesis')&&s.thesis.includes('40')?s:null});
 await page.evaluate(url=>history.pushState({},'',url),tokenPath(MANY_THESIS));
 const manyMirror=await until(async()=>{const s=await snapshot(page);return s.thesis.includes('Unique mirror thesis')?s:null});
 const expectedBadge=await snapshot(comparison,'[data-tab="views"]'),actualBadge=await snapshot(page,'[data-tab="views"]');
 check('more than 30 Thesis preserve the native total, top rows and truncation notice',!!manyReference&&!!manyMirror&&manyMirror.thesis===manyReference.thesis&&actualBadge.text===expectedBadge.text&&/40/.test(actualBadge.text),{reference:manyReference?.thesis,actual:manyMirror?.thesis,expectedBadge:expectedBadge.text,actualBadge:actualBadge.text});
 await click(page,'[data-tab="views"]');await page.screenshot({path:OUT+'/thesis-many.png'});
 await page.evaluate(url=>history.pushState({},'',url),tokenPath(AUTH));
 actual=await until(async()=>{const s=await snapshot(page);return s.allText?.includes(COPY.login)?s:null},9000);
 await click(page,'[data-tab="holders"]');const auth=await snapshot(page,'.pane-holders');
 check('missing Fomo login keeps a visible login action and correct token link',auth.visible&&auth.text.includes(COPY.login)&&auth.links.includes('https://fomo.family/tokens/ethereum/'+AUTH),auth);
 check('login failure clears prior holdings and does not invent zero share',!!actual&&!actual.share&&!actual.holders.includes('$29.4K')&&!actual.holders.includes('0.0%'),actual);await page.screenshot({path:OUT+'/login-required.png'});
 authenticated=true;const count=seen.length;await click(page,refreshSelector);
 actual=await until(async()=>{const s=await snapshot(page);return s.share.includes('21.9%')?s:null});
 check('refresh after Fomo login bypasses negative cache and restores data',!!actual&&seen.length>count&&!actual.holders.includes(COPY.login),actual);
 await page.evaluate(url=>history.pushState({},'',url),tokenPath(CA,'bsc'));
 actual=await until(async()=>{const s=await snapshot(page);return s.holders.includes('$39.4K')?s:null});
 check('same EVM address on BSC uses the Fomo bnb page and fresh holdings',!!actual&&seen.includes('/tokens/bnb/'+CA)&&!actual.holders.includes('$29.4K'),actual);
 await page.reload({waitUntil:'domcontentloaded'});
 actual=await until(async()=>{const s=await snapshot(page);return s.holders.includes('$39.4K')?s:null});
 check('selected language and Fomo data survive a full page reload',!!actual&&actual.share.includes(COPY.share)&&actual.holders.includes(COPY.held),actual?.share);
 const other=await browser.newPage();await other.setViewport({width:1280,height:900});await other.goto('https://'+(TARGET==='xxyy'?'gmgn.ai/eth/token/':'pro.xxyy.io/eth/')+SLOW_MULTI,{waitUntil:'domcontentloaded'});
 await until(async()=>seen.includes('/tokens/ethereum/'+SLOW_MULTI));
 await page.evaluate(url=>history.pushState({},'',url),tokenPath(FAST_MULTI));
 const concurrent=await until(async()=>{const [a,b]=await Promise.all([snapshot(page),snapshot(other)]);return a.share.includes('21.9%')&&b.share.includes('21.9%')?{a:a.share,b:b.share}:null},10000);
 check('GMGN and xxyy finish simultaneous Fomo reads independently',!!concurrent,concurrent);await other.close();
 if(LANG==='en'&&SITE_LANG==='en'){
  await reference.goto('https://fomo.family/tokens/ethereum/'+HYDRATING+'?owner=1',{waitUntil:'domcontentloaded'});
  await page.evaluate(url=>history.pushState({},'',url),tokenPath(HYDRATING));
  const hydrated=await until(async()=>{const s=await snapshot(page);return s.share.includes('21.9%')?s:null},10000);
  check('pending existing page cannot consume the new page login-hydration grace',!!hydrated&&!hydrated.holders.includes(COPY.login),hydrated?.holders);
 }
 await page.evaluate(url=>history.pushState({},'',url),tokenPath(UNAVAILABLE));
 actual=await until(async()=>{const s=await snapshot(page);return s.holders.includes(COPY.unavailable)?s:null},33000);
 check('unavailable Fomo prompts opening Fomo and checking login, without false zero',!!actual&&!actual.share&&actual.holders.includes(COPY.unavailable),actual);
 const closed=await until(async()=>{const ps=await browser.pages();return ps.filter(p=>p!==reference&&p.url().startsWith('https://fomo.family/')).length===0},4000);
 check('temporary Fomo tabs close while existing Fomo page is preserved',!!closed&&!reference.isClosed());
 check('no product test flags or page errors',await page.evaluate(()=>!window.__FOMO_DEBOT_TEST__&&!window.__fomoDebotTestHandle)&&errors.length===0,errors);
}catch(e){check('installed Fomo data acceptance runs to completion',false,e.stack)}
finally{if(browser)await browser.close();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true})}
const result={at:new Date().toISOString(),version:JSON.parse(fs.readFileSync(EXT+'/manifest.json')).version,language:LANG,siteLanguage:SITE_LANG,targetSite:TARGET,referenceHashes:hashes,checks,seen,errors};fs.writeFileSync(OUT+'/receipt.json',JSON.stringify(result,null,2)+'\n');
process.exit(checks.every(c=>c.ok)?0:1);
