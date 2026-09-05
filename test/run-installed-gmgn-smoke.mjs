/** Real MV3 install, unmodified ISOLATED content script and service worker.
 * Only external HTTP responses are fixtures. Inspect the closed shadow DOM via
 * CDP; never enable product test flags or replace chrome.runtime messaging. */
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pp from '/usr/local/lib/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
const DIR=path.dirname(fileURLToPath(import.meta.url));
const EXT=path.resolve(process.env.FOMO_EXTENSION_DIR || path.join(DIR,'..'));
const OUT=path.resolve(process.env.FOMO_TEST_OUTPUT || path.join(DIR,'screenshots/installed-gmgn'));
fs.mkdirSync(OUT,{recursive:true});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fomo-gmgn-installed-'));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',temp+'/key','-out',temp+'/cert','-days','2','-subj','/CN=gmgn.ai'],{stdio:'ignore'});
const fixture=fs.readFileSync(DIR+'/mock-gmgn-installed.html');
const loginFixture=fs.readFileSync(DIR+'/mock-fomo-login.html');
const server=https.createServer({key:fs.readFileSync(temp+'/key'),cert:fs.readFileSync(temp+'/cert')},(q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end(String(q.headers.host).startsWith('fomo.family')?loginFixture:fixture)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const BASE='https://gmgn.ai:'+server.address().port;
const PONS='0x39dbed3a2bd333467115de45665cc57f813c4571', CASH='0x020bfc650a365f8bb26819deaabf3e21291018b4';
const SOL_A='GygNPCFvqrMuPBM5R1siGKfrwqeJ8r5PYccx5EnNhcer',SOL_B='So11111111111111111111111111111111111111112';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const checks=[],requests=[],errors=[];
let browser,apiDelay=0;
const check=(name,ok,actual)=>{checks.push({name,ok:!!ok,...(!ok?{actual}: {})});console.log((ok?'PASS ':'FAIL ')+name+(!ok?' '+JSON.stringify(actual):''))};
async function snapshot(page){
 const c=await page.createCDPSession();
 try{
  const {root}=await c.send('DOM.getDocument',{depth:-1,pierce:true});
  let card;
  function visit(n){const a=n.attributes||[];for(let i=0;i<a.length;i+=2)if(a[i]==='class'&&a[i+1].split(' ').includes('card'))card=n;for(const ch of [...(n.children||[]),...(n.shadowRoots||[])])visit(ch)}
  visit(root);if(!card)return {visible:false,missing:true};
  const {object}=await c.send('DOM.resolveNode',{nodeId:card.nodeId});
  const {result}=await c.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){const r=this.getBoundingClientRect();return {visible:!this.hidden&&r.width>0,text:this.innerText,name:this.querySelector(".name").textContent,rect:{x:r.x,y:r.y,w:r.width,h:r.height}}}',returnByValue:true});
  return result.value;
 }finally{await c.detach()}
}
async function go(page,p){
 await page.evaluate(p=>history.pushState({},'',p),p);await sleep(600);
 let s=await snapshot(page);
 // Initial URL cards intentionally wait up to 1.5 s for page readiness.
 if(p.includes('/token/')&&!s.visible){await sleep(1400);s=await snapshot(page)}
 return s;
}
async function point(page,sel){return page.evaluate(sel=>{const r=document.querySelector(sel).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}},sel)}
async function move(page,sel){const p=await point(page,sel);await page.mouse.move(p.x,p.y)}
async function click(page,sel){const p=await point(page,sel);await page.mouse.click(p.x,p.y)}
async function hover(page,sel,wait=950){await move(page,sel);await sleep(wait);return snapshot(page)}
try{
 browser=await pp.launch({executablePath:'/usr/bin/chromium',headless:'new',userDataDir:temp+'/profile',acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage','--ignore-certificate-errors','--no-proxy-server',`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,`--host-resolver-rules=MAP gmgn.ai 127.0.0.1, MAP fomo.family 127.0.0.1:${server.address().port}`]});
 const worker=await browser.waitForTarget(t=>t.type()==='service_worker',{timeout:30000});
 const wc=await worker.createCDPSession();
 await wc.send('Fetch.enable',{patterns:[{urlPattern:'https://*/*',requestStage:'Request'}]});
 wc.on('Fetch.requestPaused',async e=>{
  try{
   const u=new URL(e.request.url);requests.push(u.pathname+u.search);
   let body={};
   if(u.pathname.includes('/story/latest')){
    const ca=u.searchParams.get('ca_address');
    const name=ca===PONS?'PONS':ca===CASH?'CASHCAT':ca===SOL_A?'SOL_A':ca===SOL_B?'SOL_B':'NO_STORY';
    body=JSON.parse(fs.readFileSync(DIR+'/fixtures/pons.json','utf8'));
    Object.assign(body.data.history,{ca_address:ca,name});
    Object.assign(body.data.history.story,{project_name:name,contract_address:ca});
    if(apiDelay)await sleep(apiDelay);
   }else if(u.pathname.includes('/latest/dex/tokens/')){
    const ca=u.pathname.split('/').pop();
    body={pairs:['ethereum','bsc','solana'].map(chainId=>({chainId,baseToken:{address:ca},quoteToken:{address:'partner',symbol:chainId==='ethereum'?'ETHCHAIN':chainId==='bsc'?'BSCCHAIN':'SOLCHAIN'},liquidity:{usd:100},dexId:'fixture'}))};
   }else if(u.hostname==='api.github.com')body={tag_name:'v0.9.8',html_url:'https://github.com/mickeyhogen/fomo-helper/releases/tag/v0.9.8'};
   await wc.send('Fetch.fulfillRequest',{requestId:e.requestId,responseCode:200,responseHeaders:[{name:'content-type',value:'application/json'}],body:Buffer.from(JSON.stringify(body)).toString('base64')});
  }catch(err){errors.push(err.message)}
 });
 const page=await browser.newPage();await page.setViewport({width:1280,height:900});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(BASE+'/eth/token/'+PONS+'?empty-tracker=1&late-tracker=1',{waitUntil:'domcontentloaded'});await sleep(3300);
 const emptyCard=await snapshot(page),emptyRight=await page.evaluate(()=>document.querySelector('#tracker').getBoundingClientRect().right);
 check('late-loading empty real-layout tracker remains fully unobstructed',emptyCard.visible&&emptyCard.rect.x>=emptyRight+8,{card:emptyCard.rect,trackerRight:emptyRight});
 await page.evaluate(()=>document.querySelector('#tracker').style.width='540px');await sleep(600);
 let adjusted=await snapshot(page);
 check('default card follows independently resized tracker',adjusted.visible&&adjusted.rect.x>=548,adjusted.rect);
 const beforeDrag=adjusted.rect;
 await page.mouse.move(adjusted.rect.x+40,adjusted.rect.y+12);await page.mouse.down();
 await page.mouse.move(adjusted.rect.x+120,adjusted.rect.y+52,{steps:5});await page.mouse.up();await sleep(300);
 const dragged=await snapshot(page);
 await page.evaluate(()=>document.querySelector('#tracker').style.width='500px');await sleep(600);adjusted=await snapshot(page);
 check('tracker changes preserve a manually dragged card',Math.abs(dragged.rect.x-beforeDrag.x-80)<2&&Math.abs(adjusted.rect.x-dragged.rect.x)<2,adjusted.rect);
 await page.mouse.click(adjusted.rect.x+40,adjusted.rect.y+12,{count:2});await sleep(500);adjusted=await snapshot(page);
 check('resetting manual position restores current tracker dock',adjusted.visible&&Math.abs(adjusted.rect.x-508)<2,adjusted.rect);
 await page.goto(BASE+'/eth/token/'+PONS,{waitUntil:'domcontentloaded'});await sleep(1800);
 let s=await snapshot(page);
 check('real manifest injection renders DeBot through service worker',s.visible&&s.name==='PONS'&&s.text.includes('ETHCHAIN'),s);
 const trackerRight=await page.evaluate(()=>document.querySelector('#tracker').getBoundingClientRect().right);
 check('default card does not cover tracker rows',s.visible&&s.rect.x>=trackerRight+8,{card:s.rect,trackerRight});
 check('page cannot reach extension test globals',await page.evaluate(()=>!window.__fomoDebotTestHandle&&!window.__FOMO_DEBOT_TEST__),null);
 s=await go(page,'/bsc/token/'+PONS);
 check('same contract on another chain changes the card chain',s.visible&&s.text.includes('BSCCHAIN')&&!s.text.includes('ETHCHAIN'),s);
 const count=requests.length;await go(page,'/bsc/token/'+PONS+'?tab=dev_token');
 check('query-only tab change does not reload',requests.length===count,[count,requests.length]);
 s=await hover(page,'#anchor .price');check('hovering non-link cell resolves its own row',s.visible&&s.name==='CASHCAT',s);
 await click(page,'#filter');await sleep(650);s=await snapshot(page);
 check('Friends Only toggles and keeps the preview',await page.evaluate(()=>document.querySelector('#filter').getAttribute('aria-pressed')==='true')&&s.name==='CASHCAT'&&s.visible,s);
 await go(page,'/follow?chain=sol');await page.keyboard.press('Escape');
 s=await hover(page,'#react .sym');check('React non-link row works in ISOLATED world',s.visible&&s.name==='SOL_A',s);
 await page.evaluate(()=>setToken('So11111111111111111111111111111111111111112'));await sleep(1100);s=await snapshot(page);
 check('recycled row under stationary cursor updates contract',s.visible&&s.name==='SOL_B',s);
 await page.evaluate(()=>{
  const row=document.querySelector('#react'),holder={},oldRoot={stateNode:holder},newRoot={stateNode:holder};
  oldRoot.alternate=newRoot;newRoot.alternate=oldRoot;holder.current=newRoot;
  const old={memoizedProps:{token:{address:SOL_B},chain:'sol'},return:oldRoot,stateNode:row};
  const current={memoizedProps:{token:{address:SOL_A},chain:'sol'},return:newRoot,stateNode:row};
  old.alternate=current;current.alternate=old;
  row.__reactProps$installed={};row.__reactFiber$installed=old;
 });
 await sleep(1100);s=await snapshot(page);
 check('React alternate tree resolves committed token, not stale fiber',s.visible&&s.name==='SOL_A',s);
 await page.evaluate(()=>setToken(SOL_B));await sleep(650);
 await page.screenshot({path:OUT+'/02-hover.png'});
 await click(page,'#react .price');await sleep(700);s=await snapshot(page);
 check('non-link click follows actual SPA navigation',s.visible&&s.name==='SOL_B'&&page.url().includes('/sol/token/'+SOL_B),s);
 await page.keyboard.press('Escape');s=await hover(page,'#wallet .sym');
 check('wallet-only props never become a token preview',!s.visible,s);
 await go(page,'/eth/token/'+PONS);await page.keyboard.press('Escape');s=await hover(page,'#external a');
 check('external same-shaped URL never opens a token',!s.visible,s);
 await click(page,'#chart');await go(page,'/eth/token/'+PONS+'?reopen=1');
 // Explicitly reopen by navigating to a different token and back.
 await go(page,'/eth/token/'+CASH);await go(page,'/eth/token/'+PONS);
 await page.evaluate(()=>document.querySelector('#newtab a').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,ctrlKey:true})));
 await sleep(200);s=await snapshot(page);check('new-tab or modified click leaves current card unchanged',s.visible&&s.name==='PONS',s);
 await go(page,'/follow?chain=sol');await page.keyboard.press('Escape');
 await move(page,'#anchor .sym');await sleep(180);await page.keyboard.press('Escape');await sleep(1000);s=await snapshot(page);
 check('Escape cancels pending hover before it opens',!s.visible,s);
 await move(page,'#chart');await move(page,'#anchor .sym');await sleep(150);await go(page,'/bsc/token/'+PONS);await sleep(900);s=await snapshot(page);
 check('URL change invalidates pending hover',s.visible&&s.name==='PONS'&&s.text.includes('BSCCHAIN'),s);
 check('public GMGN edition checks its own release channel',requests.some(p=>p.includes('/repos/mickeyhogen/fomo-helper/releases/latest')),requests);
 await page.screenshot({path:OUT+'/01-card.png'});
 await page.setViewport({width:900,height:650});await sleep(400);s=await snapshot(page);
 check('card stays within smaller viewport',s.visible&&s.rect.w>=280&&s.rect.h>=100&&s.rect.x>=0&&s.rect.y>=0&&s.rect.x+s.rect.w<=902&&s.rect.y+s.rect.h<=652,s.rect);
 check('no page/runtime exceptions',errors.length===0,errors);
 await wc.detach();
}catch(e){check('installed suite execution',false,e.stack)}
finally{if(browser)await browser.close();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true})}
const result={version:JSON.parse(fs.readFileSync(EXT+'/manifest.json')).version,checks,requests,errors};
fs.writeFileSync(OUT+'/receipt.json',JSON.stringify(result,null,2));
console.log(`${checks.filter(c=>c.ok).length}/${checks.length} installed GMGN checks passed`);
process.exit(checks.every(c=>c.ok)?0:1);
