// Regression of owner-reported delayed auto-open and logged-in Fomo reads.
// The extension is installed unmodified; only HTTPS page/API responses are fixtures.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pp from '/usr/local/lib/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
const DIR=path.dirname(fileURLToPath(import.meta.url));
const EXT=process.env.FOMO_EXTENSION_DIR||path.resolve(DIR,'..');
const OUT=process.env.FOMO_TEST_OUTPUT;fs.mkdirSync(OUT,{recursive:true});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fomo-loading-'));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',temp+'/key','-out',temp+'/cert','-days','2','-subj','/CN=pro.xxyy.io'],{stdio:'ignore'});
const pageFixture=fs.readFileSync(DIR+'/mock-xxyy-layouts.html','utf8');
const fomo=fs.readFileSync(DIR+'/mock-fomo-mirror.html','utf8');
const CA='0x39dbed3a2bd333467115de45665cc57f813c4571';
const POOL='0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RACEPOOL='0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const PARTIAL='0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SLOW='0xcccccccccccccccccccccccccccccccccccccccc';
const FAST='0xdddddddddddddddddddddddddddddddddddddddd';
const V4POOL='0x1d767e12f99d8c7ac792749209868a1fafec6e1599b5cb9f4582bf5525793598';
const V4MISS='0x'+'9'.repeat(64);
const V4RETRY='0x'+'8'.repeat(64);
let retryPoolReady=false;
const delayed=fomo.replace('</body>',`<script>
const mc=document.querySelector('#mc-val'),texts=[...document.querySelectorAll('.hthesis')].map(e=>e.textContent);
mc.textContent='';document.querySelectorAll('.hthesis').forEach(e=>e.textContent='');
setTimeout(()=>{mc.textContent='$300K';document.querySelectorAll('.hthesis').forEach((e,i)=>e.textContent=texts[i])},1800);
</script></body>`);
const requests=[],checks=[],errors=[];
const server=https.createServer({key:fs.readFileSync(temp+'/key'),cert:fs.readFileSync(temp+'/cert')},(req,res)=>{
 const u=new URL(req.url,'https://'+req.headers.host);
 const reply=(body,type='text/html')=>{res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(body)};
 if(['pro.xxyy.io','www.xxyy.io'].includes(u.hostname)){if(u.pathname.startsWith('/fixtures/xxyy-live-vue/'))return reply(fs.readFileSync(DIR+u.pathname),'text/javascript');return reply(pageFixture)}
 if(u.hostname==='fomo.family'){
  requests.push(u.pathname);
  if(u.pathname.endsWith('/'+SLOW)){setTimeout(()=>reply(fomo),3200);return}
  return reply(u.pathname.endsWith('/'+PARTIAL)?delayed:fomo);
 }
 if(u.hostname==='api.dexscreener.com'){
  if((u.pathname.endsWith('/'+POOL)||u.pathname.endsWith('/'+RACEPOOL))&&u.pathname.includes('/pairs/')){
   setTimeout(()=>reply(JSON.stringify({pair:{chainId:'ethereum',pairAddress:u.pathname.split('/').at(-1),baseToken:{address:CA}}}),'application/json'),4200);return;
  }
  if(u.pathname.includes('/pairs/')){
   const ref=u.pathname.split('/').at(-1);
   if(ref.toLowerCase()===V4POOL||ref===V4RETRY&&retryPoolReady)return reply(JSON.stringify({pairs:[{chainId:'robinhood',pairAddress:ref,baseToken:{address:CA}}]}),'application/json');
   if(ref===V4RETRY)return reply(JSON.stringify({pairs:[{chainId:'ethereum',pairAddress:ref,baseToken:{address:CA}}]}),'application/json');
  }
  return reply('{"pairs":[]}','application/json');
 }
 return reply('{"code":-1}','application/json');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,ok,details)=>{checks.push({name,ok:!!ok,details});console.log((ok?'PASS ':'FAIL ')+name)};
async function snapshot(page){
 const c=await page.createCDPSession();try{
  const {root}=await c.send('DOM.getDocument',{depth:-1,pierce:true});let host;
  const visit=n=>{if((n.attributes||[]).includes('data-fomo-debot'))host=n;for(const k of [...(n.children||[]),...(n.shadowRoots||[])])visit(k)};visit(root);
  if(!host?.shadowRoots?.[0])return {visible:false,text:'',thesis:'',share:''};
  const {object}=await c.send('DOM.resolveNode',{nodeId:host.shadowRoots[0].nodeId});
  const {result}=await c.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){const card=this.querySelector(".card"),r=card.getBoundingClientRect();return {visible:!card.hidden&&r.width>0,preview:!this.querySelector(".pv").hidden,text:card.textContent,thesis:this.querySelector(".pane-views").textContent,share:this.querySelector(".share-bar")?.textContent||""}}',returnByValue:true});return result.value;
 }finally{await c.detach()}
}
async function until(fn,ms=12000){const end=Date.now()+ms;while(Date.now()<end){const r=await fn();if(r)return r;await sleep(150)}return null}
let browser;
try{
 const hosts=['pro.xxyy.io','www.xxyy.io','fomo.family','api.dexscreener.com','app.debot.ai','debot.ai','api.github.com','api.fxtwitter.com'];
 browser=await pp.launch({executablePath:'/usr/bin/chromium',headless:'new',userDataDir:temp+'/profile',acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage','--no-proxy-server','--ignore-certificate-errors',`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,'--host-resolver-rules='+hosts.map(h=>`MAP ${h} 127.0.0.1:${server.address().port}`).join(', ')]});
 const p=await browser.newPage();await p.setViewport({width:1280,height:900});p.on('pageerror',e=>errors.push(e.message));
 for(const host of ['www.xxyy.io','pro.xxyy.io']){
  await p.goto('https://'+host+'/meme',{waitUntil:'networkidle0'});
  check(host+' real Vue renderer initialized',await p.evaluate(()=>document.body.dataset.vueReady==='3.5.21'),errors);
  for(const [sel,n,chain] of [['#f1 .name',1,'base'],['#f2 .extra',2,'base'],['#trade .extra',3,'bnb'],['#transfer .name',4,'base'],['#multi .extra',5,'ethereum']]){
   await p.mouse.move(800,650);await p.keyboard.press('Escape');await sleep(130);const ca='0x'+String(n).repeat(40);await p.hover(sel);
   const shown=await until(async()=>{const s=await snapshot(p);return s.visible&&s.preview&&s.share.includes('21.9%')?s:null},7000);
   check(host+' '+sel+' opens same-token Fomo preview on row chain',!!shown&&requests.includes('/tokens/'+chain+'/'+ca),shown||await snapshot(p));
  }
  for(const sel of ['#native .name','#walletOnly .extra']){
   await p.mouse.move(800,650);await p.keyboard.press('Escape');await sleep(130);const before=requests.length;await p.hover(sel);await sleep(1100);const s=await snapshot(p);
   check(host+' '+sel+' never treats a wallet as a token',!s.visible&&requests.length===before,s);
  }
  await p.mouse.move(800,650);await p.keyboard.press('Escape');await sleep(130);await p.hover('#f1 .name');await sleep(280);await p.evaluate(()=>window.reuseFavorite());
  const recycled=await until(async()=>{const s=await snapshot(p);return s.visible&&s.preview&&requests.includes('/tokens/base/0x'+'6'.repeat(40))?s:null},5000);
  check(host+' actual sortable virtual row reuse resolves the replacement token',!!recycled,recycled||await snapshot(p));
  await p.reload({waitUntil:'networkidle0'});await p.evaluate(()=>window.staleHoistedFavorite());await p.mouse.move(800,650);await p.keyboard.press('Escape');await sleep(150);await p.hover('#f1 .name');
  const hoisted=await until(async()=>{const s=await snapshot(p);return s.visible&&s.preview? s:null},4000);
  check(host+' stale hoisted wrapper references still identify the exact favorite row',!!hoisted&&requests.includes('/tokens/base/0x'+'1'.repeat(40)),hoisted);
  await p.mouse.move(800,650);
  await p.goto('https://'+host+'/robin/'+V4POOL,{waitUntil:'domcontentloaded'});
  const auto=await until(async()=>{const s=await snapshot(p);return s.visible&&!s.preview&&s.share.includes('21.9%')?s:null});
  check(host+' direct V4 token URL auto-opens with all Fomo tabs',!!auto&&auto.thesis.includes('You can now see which tokens'),auto);
 }
 check('no extension test globals or page errors',errors.length===0&&await p.evaluate(()=>!window.__FOMO_DEBOT_TEST__&&!window.__fomoDebotTestHandle),errors);
 await p.screenshot({path:OUT+'/real-vue-layouts.png'});
}catch(e){check('layout regression executes',false,e.stack)}
finally{if(browser)await browser.close();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true})}
fs.writeFileSync(OUT+'/receipt.json',JSON.stringify({version:JSON.parse(fs.readFileSync(EXT+'/manifest.json')).version,checks,requests,errors},null,2));
process.exit(checks.every(c=>c.ok)?0:1);
