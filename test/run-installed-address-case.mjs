// Reproduce the observed real DeBot behavior: mixed-case EVM queries are HTTP 404.
// The same CA comes from a checksummed pool response and a lowercase native hover row.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import https from 'node:https';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import pp from '/usr/local/lib/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
const DIR=path.dirname(fileURLToPath(import.meta.url)),EXT=process.env.FOMO_EXTENSION_DIR||path.resolve(DIR,'..'),OUT=process.env.FOMO_TEST_OUTPUT,BASELINE=process.env.FOMO_CASE_BASELINE==='1';fs.mkdirSync(OUT,{recursive:true});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fomo-case-'));execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',temp+'/key','-out',temp+'/cert','-days','2','-subj','/CN=www.xxyy.io'],{stdio:'ignore'});
const CA='0x6e401929BB5BEBB4807c462c8c9Fb8C6B76E1e18',LOWER=CA.toLowerCase(),POOL='0x1d767e12f99d8c7ac792749209868a1fafec6e1599b5cb9f4582bf5525793598',SOL='GygNPCFvqrMuPBM5R1siGKfrwqeJ8r5PYccx5EnNhcer';
const xxyy=fs.readFileSync(DIR+'/mock-xxyy.html','utf8').replaceAll('0x39dbed3a2bd333467115de45665cc57f813c4571',LOWER).replace("get chainId() { return 'sol'; }","get chainId() { return 'robin'; }");
const fomo=fs.readFileSync(DIR+'/mock-fomo-mirror.html','utf8'),template=JSON.parse(fs.readFileSync(DIR+'/fixtures/pons.json'));
const seen=[],checks=[],errors=[];let mismatch=false;
const server=https.createServer({key:fs.readFileSync(temp+'/key'),cert:fs.readFileSync(temp+'/cert')},(req,res)=>{
 const u=new URL(req.url,'https://'+req.headers.host);function reply(body,type='application/json',status=200){res.writeHead(status,{'content-type':type,'cache-control':'no-store'});res.end(typeof body==='string'?body:JSON.stringify(body))}
 if(['www.xxyy.io','pro.xxyy.io'].includes(u.hostname))return reply(xxyy,'text/html');
 if(u.hostname==='fomo.family')return reply(fomo,'text/html');
 if(u.hostname==='api.dexscreener.com')return reply(u.pathname.endsWith('/'+POOL)?{pairs:[{chainId:'robinhood',pairAddress:POOL,baseToken:{address:CA}}]}:{pairs:[]});
 if(u.pathname==='/api/v1/nitter/story/latest'){
  const ca=u.searchParams.get('ca_address');seen.push({ca,host:u.hostname});
  if(ca!==LOWER&&ca!==SOL)return reply({},'application/json',404);
  const value=structuredClone(template),h=value.data.history;h.ca_address=mismatch?'0x9999999999999999999999999999999999999999':ca;h.name=ca===SOL?'SOLANA_CASE':'BEAVER';h.story.project_name=h.name;h.story.contract_address=ca;h.story.background.origin.text=h.name+' verified narrative identity';h.source_tweets=[];
  return reply(value);
 }
 return reply({});
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const check=(name,ok,details)=>{checks.push({name,ok:!!ok,details});console.log((ok?'PASS ':'FAIL ')+name)};
async function shadow(p,body){const c=await p.createCDPSession();try{const {root}=await c.send('DOM.getDocument',{depth:1}),{nodeId}=await c.send('DOM.querySelector',{nodeId:root.nodeId,selector:'[data-fomo-debot]'});if(!nodeId)return null;const {node}=await c.send('DOM.describeNode',{nodeId,depth:1,pierce:true}),{object}=await c.send('DOM.resolveNode',{nodeId:node.shadowRoots[0].nodeId});const {result}=await c.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){'+body+'}',returnByValue:true});return result.value}finally{await c.detach()}}
const snap=p=>shadow(p,`return {visible:!this.querySelector('.card').hidden,preview:!this.querySelector('.pv').hidden,meta:this.querySelector('.slot-debot').textContent,holders:this.querySelector('.pane-holders').textContent,thesis:this.querySelector('.pane-views').textContent,name:this.querySelector('.name').textContent};`);
const refresh=p=>shadow(p,`this.querySelector('button[title="重新抓取"],button[title="Refresh"]').click();return true;`);
async function until(fn,ms=9000){const end=Date.now()+ms;while(Date.now()<end){const r=await fn();if(r)return r;await sleep(120)}return null}
let browser;try{
 const hosts=['www.xxyy.io','pro.xxyy.io','fomo.family','api.dexscreener.com','app.debot.ai','debot.ai','api.github.com','api.fxtwitter.com'];browser=await pp.launch({executablePath:'/usr/bin/chromium',headless:'new',enableExtensions:true,userDataDir:temp+'/profile',acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage','--ignore-certificate-errors','--no-proxy-server',`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,'--host-resolver-rules='+hosts.map(h=>`MAP ${h} 127.0.0.1:${server.address().port}`).join(', ')]});
 const p=await browser.newPage();await p.setViewport({width:1280,height:900});p.on('pageerror',e=>errors.push(e.message));
 for(const host of ['www.xxyy.io','pro.xxyy.io']){
  // Each host starts cold; the preceding successful hover must not mask a bad default request.
  const target=await browser.waitForTarget(t=>t.type()==='service_worker');
  await (await target.worker()).evaluate(async()=>{memCache.clear();await chrome.storage.session.clear()});
  const begin=seen.length;await p.mouse.move(1000,700);await p.goto('https://'+host+'/robin/'+POOL,{waitUntil:'domcontentloaded'});
  const current=await until(async()=>{const s=await snap(p);return s?.visible&&(BASELINE?s.meta.includes('这段暂时读不到'):s.meta.includes('BEAVER verified narrative identity'))?s:null});
  check(host+(BASELINE?' old default reproduces the narrative error':' current pool page reads the actual narrative'),!!current,current||await snap(p));
  if(!BASELINE){await refresh(p);check(host+' refresh uses the same readable CA',!!await until(async()=>(await snap(p))?.meta.includes('BEAVER verified narrative identity')))}
  await p.goto('https://'+host+'/meme',{waitUntil:'domcontentloaded'});await sleep(450);await p.hover('#xx-row-pons .sym');
  const hover=await until(async()=>{const s=await snap(p);return s?.visible&&s.preview&&s.meta.includes('BEAVER verified narrative identity')?s:null});check(host+' hover reads the SAME CA',!!hover,hover||await snap(p));
  check(host+(BASELINE?' confirms different query casing between the two routes':' default and hover use identical narrative query identity'),BASELINE?seen.slice(begin).some(v=>v.ca===CA)&&seen.slice(begin).some(v=>v.ca===LOWER):seen.slice(begin).length>0&&seen.slice(begin).every(v=>v.ca===LOWER),seen.slice(begin));
  if(!BASELINE)check(host+' complete narrative matches default versus same-token hover',current?.meta===hover?.meta,{current:current?.meta,hover:hover?.meta});
 }
 if(!BASELINE){
  await p.mouse.move(1000,700);await p.goto('https://www.xxyy.io/sol/'+SOL,{waitUntil:'domcontentloaded'});
  check('Solana mixed-case address remains byte-identical and readable',!!await until(async()=>(await snap(p))?.meta.includes('SOLANA_CASE verified narrative identity'))&&seen.some(x=>x.ca===SOL)&&!seen.some(x=>x.ca===SOL.toLowerCase()),seen);
  mismatch=true;await refresh(p);check('a response for another CA is still rejected',!!await until(async()=>{const s=await snap(p);return s?.meta.includes('这段暂时读不到')&&!s.meta.includes('verified narrative identity')?s:null}),await snap(p));
 }
 check('no page exceptions or product test globals',errors.length===0&&await p.evaluate(()=>!window.__FOMO_DEBOT_TEST__&&!window.__fomoDebotTestHandle),errors);await p.screenshot({path:OUT+'/case-parity.png'});
}catch(e){check('address case suite executes',false,e.stack)}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true})}
fs.writeFileSync(OUT+'/receipt.json',JSON.stringify({version:JSON.parse(fs.readFileSync(EXT+'/manifest.json')).version,baseline:BASELINE,checks,seen,errors},null,2));process.exit(checks.every(c=>c.ok)?0:1);
