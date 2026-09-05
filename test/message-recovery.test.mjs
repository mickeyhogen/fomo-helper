import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the real transport boundary with a deterministic clock, including a
// callback that arrives after timeout (which a network-only fixture cannot model).
const source = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const transport = source.slice(source.indexOf('  function sendMsg('), source.indexOf('  const requestPairs ='));
function harness(sendMessage, id='extension') {
  let serial=0; const timers=new Map();
  const context=vm.createContext({disposed:false, TEST:false, chrome:{runtime:{id,sendMessage}},
    setTimeout(fn){timers.set(++serial,fn);return serial;},clearTimeout(id){timers.delete(id);}});
  vm.runInContext(transport+';globalThis.send=sendMsg;',context);
  return {context,timers,expire(){for(const [id,fn] of [...timers]){timers.delete(id);fn();}}};
}
test('a lost callback terminates once, and a late success cannot replace it',()=>{
  let reply; const h=harness((_msg,cb)=>{reply=cb;}); const results=[];
  h.context.send({type:'debot-story'},r=>results.push(r));
  assert.equal(results.length,0); assert.equal(h.timers.size,1);
  h.expire(); assert.equal(results.length,1); assert.equal(results[0].kind,'message_timeout');
  reply({ok:true}); assert.equal(results.length,1);
});
test('a timely response cancels the watchdog',()=>{
  const h=harness((_msg,cb)=>cb({ok:true})); const results=[];
  h.context.send({},r=>results.push(r));h.expire();
  assert.equal(results.length,1);assert.equal(results[0].ok,true);assert.equal(h.timers.size,0);
});
test('invalidated extension context is distinct from a transient connection error',()=>{
  for(const [id,kind] of [[undefined,'context_invalidated'],['extension','connection']]){
    const h=harness(()=>{throw new Error('disconnected');});h.context.chrome.runtime.id=id;
    const results=[];h.context.send({},r=>results.push(r));
    assert.equal(results[0].kind,kind);assert.equal(h.timers.size,0);
  }
});
test('disposing an old UI silences its pending response',()=>{
  let reply;const h=harness((_msg,cb)=>{reply=cb;});const results=[];
  h.context.send({},r=>results.push(r));h.context.disposed=true;reply({ok:true});h.expire();
  assert.equal(results.length,0);
});
