// Install the previous public release, retain its ID/settings, then load the exact new package.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pp from '/usr/local/lib/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const DIR=path.dirname(fileURLToPath(import.meta.url));
const EXT=process.env.FOMO_EXTENSION_DIR||path.resolve(DIR,'..');
const PREVIOUS=process.env.FOMO_PREVIOUS_EXTENSION_DIR;
const OUT=process.env.FOMO_TEST_OUTPUT;
if(!PREVIOUS||!OUT)throw new Error('Set FOMO_PREVIOUS_EXTENSION_DIR and FOMO_TEST_OUTPUT');
fs.mkdirSync(OUT,{recursive:true});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fomo-public-upgrade-'));
const install=temp+'/extension';fs.mkdirSync(install);
const runtime=['manifest.json','content.js','background.js','popup.html','popup.js','icons'];
const copyRuntime=source=>{for(const f of runtime)fs.cpSync(path.join(source,f),path.join(install,f),{recursive:true});};
copyRuntime(PREVIOUS);
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',temp+'/key','-out',temp+'/cert','-days','2','-subj','/CN=fomo.family'],{stdio:'ignore'});
const fixture=fs.readFileSync(DIR+'/mock-fomo.html','utf8');
const story=JSON.parse(fs.readFileSync(DIR+'/fixtures/pons.json'));
const CA=story.data.history.ca_address;
const checks=[],hits=[],errors=[];
const check=(name,ok,details)=>{checks.push({name,ok:!!ok,details});console.log((ok?'PASS ':'FAIL ')+name);};
const server=https.createServer({key:fs.readFileSync(temp+'/key'),cert:fs.readFileSync(temp+'/cert')},(req,res)=>{
 const u=new URL(req.url,'https://'+req.headers.host);hits.push({host:u.hostname,path:u.pathname});
 const reply=(v,type='application/json')=>{res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(typeof v==='string'?v:JSON.stringify(v));};
 if(u.hostname==='fomo.family')return reply(fixture,'text/html');
 if(u.hostname==='api.github.com')return reply({tag_name:'v0.9.23',html_url:'https://github.com/mickeyhogen/fomo-helper/releases/tag/v0.9.23',body:'- Next stable release for testing.'});
 if(u.pathname==='/api/v1/nitter/story/latest')return reply(story);
 return reply({pairs:[]});
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=9000){const end=Date.now()+ms;while(Date.now()<end){try{const r=await fn();if(r)return r;}catch{}await sleep(100);}return null;}
async function shadow(p,body){const c=await p.createCDPSession();try{
 const {root}=await c.send('DOM.getDocument',{depth:1});
 const {nodeId}=await c.send('DOM.querySelector',{nodeId:root.nodeId,selector:'[data-fomo-debot]'});if(!nodeId)return null;
 const {node}=await c.send('DOM.describeNode',{nodeId,depth:1,pierce:true});
 const {object}=await c.send('DOM.resolveNode',{nodeId:node.shadowRoots[0].nodeId});
 const {result}=await c.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){'+body+'}',returnByValue:true});return result.value;
}finally{await c.detach();}}
let browser;
try{
 const hosts=['fomo.family','gmgn.ai','www.xxyy.io','pro.xxyy.io','app.debot.ai','debot.ai','api.dexscreener.com','api.fxtwitter.com','api.github.com','legacy-analysis.example'];
 browser=await pp.launch({executablePath:'/usr/bin/chromium',headless:'new',enableExtensions:true,protocolTimeout:15000,userDataDir:temp+'/profile',acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage','--no-proxy-server','--ignore-certificate-errors',`--disable-extensions-except=${install}`,`--load-extension=${install}`,'--host-resolver-rules='+hosts.map(h=>`MAP ${h} 127.0.0.1:${server.address().port}`).join(', ')]});
 let sw=await(await browser.waitForTarget(t=>t.type()==='service_worker')).worker();
 const original=await sw.evaluate(async()=>{await chrome.storage.sync.set({openMode:'full',lang:'en',hoverPreview:true,updateCheck:false,analysisTemplate:'https://legacy-analysis.example/{ca}',detailTemplate:'https://legacy-analysis.example/{ca}',allowPrivateAnalysisSource:true});await chrome.storage.local.set({displayBrightness:111,displayOpacity:67});return {id:chrome.runtime.id,version:chrome.runtime.getManifest().version};});
 check('baseline is the previous public release',original.version===JSON.parse(fs.readFileSync(PREVIOUS+'/manifest.json')).version,original);
 const p=await browser.newPage();await p.setViewport({width:1280,height:900});p.on('pageerror',e=>errors.push(e.message));
 await p.goto('https://fomo.family/tokens/robinhood/'+CA,{waitUntil:'domcontentloaded'});
 await until(()=>shadow(p,'return !this.querySelector(".card").hidden;'));
 copyRuntime(EXT);
 console.log('Upgrade bytes copied; reloading extension');
 const control=await browser.newPage();await control.goto('chrome-extension://'+original.id+'/popup.html');
 await control.evaluate(()=>{setTimeout(()=>chrome.runtime.reload(),50);});await sleep(1600);if(!control.isClosed())await control.close();
 console.log('Wake the reloaded service worker through its popup');
 const wake=await browser.newPage();await wake.goto('chrome-extension://'+original.id+'/popup.html');
 console.log('Inspect reloaded extension through its own settings page');
 const now=await wake.evaluate(async()=>({id:chrome.runtime.id,manifest:chrome.runtime.getManifest(),sync:await chrome.storage.sync.get(['openMode','lang','hoverPreview','updateCheck']),local:await chrome.storage.local.get(['displayBrightness','displayOpacity']),permissions:await chrome.permissions.getAll()}));
 check('upgrade keeps the fixed extension ID and loads v0.9.22',now.id===original.id&&now.manifest.version===JSON.parse(fs.readFileSync(EXT+'/manifest.json')).version);
 check('language, open mode, hover, update and appearance settings survive',now.sync.hoverPreview===true&&now.sync.lang==='en'&&now.sync.openMode==='full'&&now.sync.updateCheck===false&&now.local.displayBrightness===111&&now.local.displayOpacity===67,now);
 check('new site access is available without wildcard optional permissions',now.permissions.origins.length===9&&!now.manifest.optional_host_permissions&&['https://gmgn.ai/*','https://pro.xxyy.io/*','https://www.xxyy.io/*'].every(x=>now.permissions.origins.includes(x))&&now.manifest.permissions.join(',')==='storage,scripting',now.permissions);
 await p.reload({waitUntil:'domcontentloaded'});
 check('old page works after the documented one-time refresh',!!await until(()=>shadow(p,'return !this.querySelector(".card").hidden && this.querySelector(".slot-debot").textContent.includes("PONS");')));
 await wake.close();
 const popup=await browser.newPage();await popup.goto('chrome-extension://'+original.id+'/popup.html');
 check('English settings include the working update switch and exclude retired sources',await popup.evaluate(()=>document.documentElement.lang==='en'&&document.querySelector('[data-i18n="edition"]').textContent==='Check for updates'&&!document.querySelector('#updateCheck').disabled&&!document.querySelector('#analysisTemplate')&&document.querySelector('#openMode').value==='full'));
 const disabled=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'analysis-doc',ca:'0x39dbed3a2bd333467115de45665cc57f813c4571'}));
 check('legacy custom-source settings cannot activate a request',disabled.kind==='disabled'&&!hits.some(x=>x.host==='legacy-analysis.example'),disabled);
 check('disabled update checking issues no GitHub requests',!hits.some(x=>x.host==='api.github.com'));
 await popup.click('#updateCheck');
 check('enabling updates shows the newer stable release in the card',!!await until(()=>shadow(p,'const a=this.querySelector(".upd");return a&&a.textContent.includes("v0.9.23")&&a.href==="https://github.com/mickeyhogen/fomo-helper/releases/tag/v0.9.23";')));
 await popup.select('#lang','zh');
 check('popup switches to Chinese and retains the version',await popup.evaluate(()=>document.documentElement.lang==='zh-CN'&&document.querySelector('[data-i18n="edition"]').textContent.includes('检查更新')&&document.querySelector('#bver').textContent.includes('0.9.22')));
 await popup.screenshot({path:OUT+'/popup-zh.png'});
 await popup.select('#lang','en');await popup.screenshot({path:OUT+'/popup-en.png'});
 await popup.click('#updateCheck');
 check('turning update checking off removes its notice',!!await until(()=>shadow(p,'return !this.querySelector(".upd");')));
 const before=hits.filter(x=>x.host==='api.github.com').length;
 await popup.evaluate(()=>chrome.storage.local.remove('updateCheckCache'));
 await p.reload({waitUntil:'domcontentloaded'});await sleep(650);
 check('disabled preference also survives a fresh page load',hits.filter(x=>x.host==='api.github.com').length===before);
 check('no unexpected page errors',errors.length===0,errors);
}catch(e){check('public upgrade acceptance executes',false,e.stack);}
finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});}
fs.writeFileSync(OUT+'/receipt.json',JSON.stringify({checks,hits,errors},null,2));
process.exit(checks.every(c=>c.ok)?0:1);
