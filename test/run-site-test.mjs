// Exercise the exact public page, including stale/unavailable GitHub metadata.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pp from '/usr/local/lib/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
const DIR=path.dirname(fileURLToPath(import.meta.url)),OUT=process.env.FOMO_TEST_OUTPUT;
fs.mkdirSync(OUT,{recursive:true});
const html=fs.readFileSync(path.resolve(DIR,'../docs/index.html'));
const CURRENT='v'+JSON.parse(fs.readFileSync(path.resolve(DIR,'../manifest.json'))).version;
const nextParts=CURRENT.slice(1).split('.').map(Number);nextParts[nextParts.length-1]++;
const NEXT='v'+nextParts.join('.');
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const checks=[],errors=[],browser=await pp.launch({executablePath:'/usr/bin/chromium',headless:'new',args:['--no-sandbox','--disable-dev-shm-usage']});
const check=(name,ok,details)=>{checks.push({name,ok:!!ok,details});console.log((ok?'PASS ':'FAIL ')+name);};
const asset=tag=>'https://github.com/mickeyhogen/fomo-helper/releases/download/'+tag+'/fomo-helper-'+tag+'.zip';
try{
 for(const mode of ['stale','offline','valid','untrusted']){
  const p=await browser.newPage();p.on('pageerror',e=>errors.push(e.message));await p.setRequestInterception(true);
  p.on('request',req=>{
   if(!req.url().startsWith('https://api.github.com/'))return req.continue();
   if(mode==='offline')return req.abort();
   const tag=mode==='stale'?'v0.9.8':NEXT;
   req.respond({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify({tag_name:tag,draft:false,prerelease:false,assets:[{name:'fomo-helper-'+tag+'.zip',browser_download_url:mode==='untrusted'?'https://example.com/download.zip':asset(tag)}]})});
  });
  for(const width of mode==='stale'?[1280,375]:[1280]){
   await p.setViewport({width,height:900});
   for(const lang of mode==='stale'?['zh','en']:['en']){
    await p.goto('http://127.0.0.1:'+server.address().port+'/?lang='+lang,{waitUntil:'networkidle0'});
    const expected=mode==='valid'?NEXT:CURRENT;
    const s=await p.evaluate(()=>({lang:document.documentElement.lang,title:document.title,href:document.querySelector('#dl').href,zh:document.querySelector('#dl .zh').textContent,en:document.querySelector('#dl .en').textContent,version:document.querySelector('#ver').textContent,width:innerWidth,scroll:document.documentElement.scrollWidth,images:[...document.images].every(x=>x.complete&&x.naturalWidth>0),text:document.body.innerText}));
    check(mode+' '+width+' '+lang+' download and both labels agree',s.href===asset(expected)&&s.zh.includes(expected)&&s.en.includes(expected)&&s.version.includes(expected),s.href);
    check(mode+' '+width+' '+lang+' layout and images render',s.scroll<=width&&s.images,{width,scroll:s.scroll,images:s.images});
    check(mode+' '+width+' '+lang+' chosen language is displayed',s.lang===(lang==='en'?'en':'zh-CN')&&s.text.includes(lang==='en'?'Download':'下载'));
    if(mode==='stale')await p.screenshot({path:OUT+'/'+width+'-'+lang+'.png',fullPage:true});
   }
  }
  await p.click('#langsw [data-lang="zh"]');check(mode+' language control changes the page',await p.evaluate(()=>document.documentElement.lang==='zh-CN'));
  await p.click('#tab-mac');check(mode+' macOS installation control works',await p.evaluate(()=>document.querySelector('#tab-mac').classList.contains('on')&&[...document.querySelectorAll('.os-win')].every(x=>x.hidden)));
  await p.click('#tab-win');check(mode+' Windows installation control works',await p.evaluate(()=>document.querySelector('#tab-win').classList.contains('on')&&[...document.querySelectorAll('.os-mac')].every(x=>x.hidden)));
  await p.close();
 }
 check('no page JavaScript errors',!errors.length,errors);
}catch(e){check('site acceptance executes',false,e.stack);}
finally{await browser.close();await new Promise(r=>server.close(r));}
fs.writeFileSync(OUT+'/receipt.json',JSON.stringify({checks,errors},null,2));process.exit(checks.every(x=>x.ok)?0:1);
