// Inspect the installed extension through CDP; interactions use real input events.
export async function lensEval(page, body, args = []) {
  const c = await page.createCDPSession();
  try {
    const {root} = await c.send('DOM.getDocument', {depth: 1});
    const {nodeId} = await c.send('DOM.querySelector', {nodeId: root.nodeId, selector: '[data-fomo-debot]'});
    if (!nodeId) return null;
    const {node} = await c.send('DOM.describeNode', {nodeId, depth: 1, pierce: true});
    const {object} = await c.send('DOM.resolveNode', {nodeId: node.shadowRoots[0].nodeId});
    const {result, exceptionDetails} = await c.send('Runtime.callFunctionOn', {
      objectId: object.objectId, functionDeclaration: `function(...args){${body}}`,
      arguments: args.map(value => ({value})), returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
  } finally { await c.detach(); }
}

export const lensSnapshot = page => lensEval(page, `
  const rect = el => {const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
  const card=this.querySelector('.card'), launcher=this.querySelector('.launcher');
  const r=rect(launcher), x=r.x+r.w/2, y=r.y+r.h/2;
  return {card:!card.hidden&&card.getBoundingClientRect().width>0,
    launcher:!launcher.hidden&&r.w>0, rect:r, cardRect:rect(card),
    inViewport:r.x>=0&&r.y>=0&&r.x+r.w<=innerWidth&&r.y+r.h<=innerHeight,
    hit:document.elementFromPoint(x,y)===this.host&&this.elementFromPoint(x,y)?.closest('.launcher')===launcher,
    name:this.querySelector('.name').textContent,
    label:launcher.querySelector('.launcher-label')?.textContent||'',
    hint:launcher.querySelector('small')?.textContent||'', aria:launcher.getAttribute('aria-label'),
    expanded:launcher.getAttribute('aria-expanded'),tab:this.querySelector('.tab.on')?.dataset.tab,
    tooltip:getComputedStyle(launcher.querySelector('.launcher-tip')).visibility,
    meta:this.querySelector('.slot-debot').textContent,
    preview:!this.querySelector('.pv').hidden};
`);

export async function lensPoint(page, selector) {
  const p = await lensEval(page, `const el=this.querySelector(args[0]);if(!el||el.hidden)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};`, [selector]);
  if (!p) throw new Error('Missing visible control: '+selector);
  return p;
}

export async function lensClick(page, selector) {
  const p=await lensPoint(page,selector);
  await page.mouse.click(p.x,p.y);
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
export async function until(fn,ms=10000) {
  const end=Date.now()+ms;
  while(Date.now()<end){const value=await fn();if(value)return value;await sleep(100);}
  return null;
}
