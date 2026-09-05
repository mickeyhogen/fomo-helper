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
const pageFixture=fs.readFileSync(DIR+'/mock-xxyy.html','utf8');
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
 if(u.hostname==='pro.xxyy.io')return reply(pageFixture);
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
 const hosts=['pro.xxyy.io','fomo.family','api.dexscreener.com','app.debot.ai','debot.ai','api.github.com','api.fxtwitter.com'];
 browser=await pp.launch({executablePath:'/usr/bin/chromium',headless:'new',userDataDir:temp+'/profile',acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage','--no-proxy-server','--ignore-certificate-errors',`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,'--host-resolver-rules='+hosts.map(h=>`MAP ${h} 127.0.0.1:${server.address().port}`).join(', ')]});
 const p=await browser.newPage();await p.setViewport({width:1280,height:900});p.on('pageerror',e=>errors.push(e.message));
 await p.goto('https://pro.xxyy.io/eth/'+POOL,{waitUntil:'domcontentloaded'});await sleep(1900);
 let s=await snapshot(p);check('default card is visible while pool resolution is still pending',s.visible,s);
 check('unresolved pool never reaches Fomo during the loading frame',!requests.length,requests.slice());
 await p.keyboard.press('Escape');await sleep(3900);s=await snapshot(p);
 check('closing during resolution prevents a late automatic reopen',!s.visible,s);
 await p.goto('https://pro.xxyy.io/eth/'+RACEPOOL,{waitUntil:'domcontentloaded'});
 const point=await p.$eval('#xx-row-cashcat .sym',e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}});
 await p.mouse.move(point.x,point.y);await sleep(1000);
 const previewStarted=await snapshot(p);await sleep(4000);s=await snapshot(p);
 check('late URL resolution preserves the newer hover preview',previewStarted.preview&&s.visible&&s.preview,{before:previewStarted,after:s});
 await p.mouse.move(1050,90);await sleep(1200);s=await snapshot(p);
 check('leaving the preview restores the already-resolved URL card',s.visible&&!s.preview,s);
 await p.goto('https://pro.xxyy.io/eth/'+PARTIAL,{waitUntil:'domcontentloaded'});
 s=await until(async()=>{const a=await snapshot(p);return a.thesis.includes('You can now see which tokens')&&a.share.includes('21.9%')?a:null},7500);
 check('late Thesis and market-cap fields are included after logged-in hydration',!!s,s||await snapshot(p));
 await p.goto('https://pro.xxyy.io/eth/'+SLOW,{waitUntil:'domcontentloaded'});
 await until(async()=>requests.some(v=>v.endsWith('/'+SLOW)));
 const other=await browser.newPage();await other.setViewport({width:1280,height:900});await other.goto('https://pro.xxyy.io/eth/'+FAST,{waitUntil:'domcontentloaded'});
 s=await until(async()=>{const [a,b]=await Promise.all([snapshot(p),snapshot(other)]);return a.thesis.includes('You can now see which tokens')&&b.thesis.includes('You can now see which tokens')?{a:a.thesis,b:b.thesis}:null},8500);
 check('opening a second xxyy token does not strand the first in reading state',!!s,s||{first:await snapshot(p),second:await snapshot(other)});
 await other.close();
 await p.goto('https://pro.xxyy.io/robin/'+V4POOL,{waitUntil:'domcontentloaded'});
 s=await until(async()=>{const a=await snapshot(p);return a.visible&&a.share.includes('21.9%')?a:null});
 check('owner V4 pool URL auto-opens and resolves to a token before reading Fomo',!!s&&requests.includes('/tokens/robinhood/'+CA)&&!requests.some(v=>v.includes(V4POOL)),s);
 await p.keyboard.press('Escape');await sleep(1100);s=await snapshot(p);
 check('V4 reference is stable across URL polling and remains closed after Escape',!s.visible,s);
 await p.goto('https://pro.xxyy.io/robin/'+V4POOL.toUpperCase(),{waitUntil:'domcontentloaded'});
 s=await until(async()=>{const a=await snapshot(p);return a.visible&&a.share.includes('21.9%')?a:null});
 check('V4 pool ID hexadecimal case does not change its identity',!!s,s);
 await p.goto('https://pro.xxyy.io/robin/'+V4MISS,{waitUntil:'domcontentloaded'});
 s=await until(async()=>{const a=await snapshot(p);return a.visible&&a.text.includes('暂时无法识别这个池子的代币')?a:null});
 check('missing V4 pool stays visible with a retry message and no fake Fomo request',!!s&&s.visible&&!s.share&&!requests.some(v=>v.includes(V4MISS)),s);
 await p.goto('https://pro.xxyy.io/robin/'+V4RETRY,{waitUntil:'domcontentloaded'});
 s=await until(async()=>{const a=await snapshot(p);return a.visible&&a.text.includes('暂时无法识别这个池子的代币')?a:null});
 check('resolver rejects a pair from a different chain',!!s&&!requests.some(v=>v.includes(V4RETRY)),s);
 retryPoolReady=true;
 const c=await p.createCDPSession();const {root}=await c.send('DOM.getDocument',{depth:-1,pierce:true});let refresh;
 const visit=n=>{if((n.attributes||[]).includes('重新抓取'))refresh=n;for(const child of [...(n.children||[]),...(n.shadowRoots||[])])visit(child)};visit(root);
 const {object}=await c.send('DOM.resolveNode',{nodeId:refresh.nodeId});await c.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){this.click()}',returnByValue:true});await c.detach();
 s=await until(async()=>{const a=await snapshot(p);return a.visible&&a.share.includes('21.9%')?a:null});
 check('a failed V4 lookup is not cached and refresh recovers',!!s,s);
 check('no product globals or page errors',errors.length===0&&await p.evaluate(()=>!window.__FOMO_DEBOT_TEST__&&!window.__fomoDebotTestHandle),errors);
 await p.screenshot({path:OUT+'/simultaneous.png'});
}catch(e){check('regression executes',false,e.stack)}
finally{if(browser)await browser.close();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true})}
fs.writeFileSync(OUT+'/receipt.json',JSON.stringify({version:JSON.parse(fs.readFileSync(EXT+'/manifest.json')).version,checks,requests,errors},null,2));
process.exit(checks.every(c=>c.ok)?0:1);
