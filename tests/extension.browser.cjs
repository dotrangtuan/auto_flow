// Real Chromium extension smoke test, fully routed synthetic Flow, no live Google traffic.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require('playwright');
const F=require('./rpc-fixtures.cjs');
test('real extension captures XHR and fetch with no DOM result cards',async()=>{
  const extension=path.resolve(__dirname,'..');
  const ctx=await chromium.launchPersistentContext('',{headless:true,channel:'chromium',args:[
    '--no-sandbox',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,
  ]});
  try {
    const worker=ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
    const extId=new URL(worker.url()).hostname;
    const html=`<!doctype html><textarea style="width:500px;height:120px"></textarea>
      <p>Fixture: no result cards, images, or progress markers.</p><script>
      let n=0;document.querySelector('textarea').addEventListener('keydown',e=>{
        if(e.key!=='Enter')return;e.preventDefault();const text=e.target.value;e.target.value='';n++;
        const item=[];item[8]=[[[text]]];const body=new URLSearchParams({'f.req':JSON.stringify([[['ogiZ0b',JSON.stringify([null,[item]]),null,'generic']]])}).toString();
        const url='${F.rpcUrl}';
        if(n===1)fetch(new Request(url,{method:'POST',body})).catch(()=>{});
        else {const xhr=new XMLHttpRequest();xhr.open('POST',url);xhr.send(body);}
      });</script>`;
    let requestCount=0;
    await ctx.route('**/*',async route=>{
      const u=new URL(route.request().url());
      if(u.protocol==='chrome-extension:') return route.continue();
      if(u.hostname==='flow.google.com' && u.pathname.startsWith('/project/')) return route.fulfill({contentType:'text/html',body:html});
      if(u.hostname==='flow.google.com' && u.pathname.endsWith('/data/batchexecute')) {
        requestCount++;
        return route.fulfill({contentType:'application/json',body:F.response('chrome-image-'+requestCount)});
      }
      return route.abort();
    });
    const flow=await ctx.newPage();await flow.goto('https://flow.google.com/project/fixture');
    const panel=await ctx.newPage();await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    const send=msg=>panel.evaluate(m=>chrome.runtime.sendMessage(m),{batchId:'chrome-test',...msg});
    const [tab]=await panel.evaluate(()=>chrome.tabs.query({url:'https://flow.google.com/project/*'}));
    const content=msg=>panel.evaluate(({tabId,m})=>chrome.tabs.sendMessage(tabId,m),{tabId:tab.id,m:{batchId:'chrome-test',...msg}});
    assert.equal((await content({type:'PING'})).protocol,4);
    assert.equal((await content({type:'BATCH_START',network:true})).ok,true);
    assert.equal((await send({type:'DEBUG_START',tabId:tab.id})).ok,true);
    for(const [id,prompt] of ['watercolor 日本語 fox','second prompt'].entries()) {
      const box=await content({type:'PREPARE_JOB',id,prompt});assert.equal(box.ok,true);
      assert.equal((await send({type:'DEBUG_SUBMIT',tabId:tab.id,id,prompt,x:box.x,y:box.y})).ok,true);
      assert.equal((await send({type:'DEBUG_CONFIRM',id})).ok,true);
      let state;
      for(let n=0;n<100;n++) {
        state=await send({type:'DEBUG_POLL'});
        if(state.results?.some(r=>r.id===id))break;
        await new Promise(r=>setTimeout(r,50));
      }
      const result=state.results?.find(r=>r.id===id);
      assert.equal(result?.status,'done',JSON.stringify(state));
      assert.equal(result.mediaId,'chrome-image-'+(id+1));
    }
    assert.equal(requestCount,2);
    assert.equal(await flow.locator('img, article').count(),0);
    assert.equal((await send({type:'DEBUG_STOP'})).ok,true);
  } finally { await ctx.close(); }
});
