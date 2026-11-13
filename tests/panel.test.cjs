const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await delay(5);}throw new Error('Condition timed out');}
function setup(tabs=[{id:7,url:"https://flow.google.com/project/test"}]){
  const elements=new Map();
  function el(){return {value:'',checked:false,disabled:false,textContent:'',innerHTML:'',style:{},addEventListener(){},appendChild(){}};}
  const document={getElementById(id){if(!elements.has(id))elements.set(id,el());return elements.get(id);},createElement:el};
  const sent=[],results=[],downloads=[],waiting=[];
  let fatal='';
  let inflight=0,maximumSenders=0,clockOffset=0;
  class Clock extends Date { static now(){return Date.now()+clockOffset;} }
  const chrome={storage:{local:{get:async()=>({}),set(){}}},
    tabs:{query:async query=>{
      if(query.url){assert.ok(query.url.includes('https://flow.google.com/*'));assert.ok(query.url.includes('https://labs.google/fx/*'));return tabs;}
      return tabs.filter(t=>t.active);
    },sendMessage(id,msg,cb){
      const response=msg.type==='POLL_JOBS'?{ok:true,results:results.map(r=>({attempt:1,...r}))}:{ok:true,protocol:4,hasInput:true,x:1,y:1};queueMicrotask(()=>cb(response));}},
    runtime:{sendMessage(msg,cb){
      if(msg.type==='DEBUG_POLL') {
        queueMicrotask(()=>cb({ok:true,results:results.map(r=>({attempt:1,...r})),waiting,fatal}));
      } else if(msg.type==='DOWNLOAD_IMAGE') {
        downloads.push(msg);queueMicrotask(()=>cb({ok:true,downloadId:downloads.length}));
      } else if(msg.type==='DOWNLOAD_STATUS') {
        queueMicrotask(()=>cb({ok:true,state:'complete',filename:'C:/Downloads/'+downloads[msg.downloadId-1].filename}));
      } else if(msg.type==='DEBUG_SUBMIT'){
        inflight++;maximumSenders=Math.max(maximumSenders,inflight);sent.push(msg.prompt);
        setTimeout(()=>{inflight--;cb({ok:true});},2);
      }else queueMicrotask(()=>cb({ok:true}));}},
    downloads:{download:async opts=>{downloads.push(opts);return downloads.length;}}};
  const ctx=vm.createContext({document,chrome,console,URL,Date:Clock,crypto:require('node:crypto').webcrypto,
    setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,5)),setInterval(){}});
  for(const f of ['flow-protocol.js','queue.js','sidepanel.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',f),'utf8'),ctx);
  return {ctx,elements,sent,results,downloads,waiting,fail(reason){fatal=reason;},advance(ms){clockOffset+=ms;},get max(){return maximumSenders;}};
}
test('fatal network state still downloads confirmed images and sends no next group',async()=>{
  const env=setup();await delay(5);
  env.elements.get('prompts').value='first\nsecond';env.elements.get('concurrency').value='1';
  const task=vm.runInContext('run()',env.ctx);await until(()=>env.sent.length===1);
  env.results.push({id:0,status:'done',src:'https://fixture.invalid/confirmed.png'});env.fail('Disconnected');
  await task;assert.equal(env.downloads.length,1);assert.equal(env.sent.length,1);
  assert.match(env.elements.get('connText').textContent,/Disconnected/);
});
test('panel waits for the whole group and retries only its failed prompt before sending group 2',async()=>{
  const env=setup();await delay(5);
  env.elements.get('prompts').value=Array.from({length:25},(_,i)=>`prompt-${i+1}`).join('\n');
  env.elements.get('concurrency').value='10';env.elements.get('serial').checked=true;
  const task=vm.runInContext('run()',env.ctx);
  await until(()=>env.sent.length===10);
  env.results.push({id:6,attempt:1,status:'done',src:'https://fixture.invalid/seven.png'});
  await delay(30);assert.equal(env.sent.length,10);
  assert.equal(env.downloads.length,1);assert.match(env.downloads[0].filename,/007_prompt-7/);
  env.results.push({id:2,attempt:1,status:'error',error:'Generation failed'});
  for(const id of [0,1,3,4,5,7,8,9])env.results.push({id,attempt:1,status:'done',src:`https://fixture.invalid/${id}.png`});
  await delay(30);assert.equal(env.sent.length,10);
  env.advance(6000);await until(()=>env.sent.length===11);
  assert.equal(env.sent[10],'prompt-3'); // It is a retry, not prompt 11.
  await delay(30);assert.equal(env.sent.length,11); // Stale attempt-1 errors are ignored.
  env.results.push({id:2,attempt:2,status:'done',src:'https://fixture.invalid/retry.png'});
  await until(()=>env.sent.length===21);assert.equal(env.sent[11],'prompt-11');assert.equal(env.sent[20],'prompt-20');
  assert.equal(env.downloads.filter(d=>d.filename.includes('003_prompt-3')).length,1);
  assert.equal(env.max,1);
  await vm.runInContext('stop()',env.ctx);await task;assert.equal(env.sent.length,21);
  assert.equal(env.elements.get('start').disabled,false);
});
test('project URL detection supports screenshot domain, legacy and localized paths',async()=>{
  const env=setup();await delay(5);
  for(const url of ['https://flow.google.com/project/2a5bc9c1-97a5-4f26-9ee4-3e7dcc2af759','https://flow.google/project/legacy', 'https://labs.google/fx/tools/flow/project/abc','https://labs.google/fx/vi/tools/flow/project/abc']){
    assert.equal(vm.runInContext(`isFlowProject(${JSON.stringify(url)})`,env.ctx),true,url);
  }
  for(const url of ['https://flow.google.com/','https://flow.google.com/project/','https://flow.google.com.evil.test/project/a','https://labs.google/fx/tools/flow','invalid']){
    assert.equal(vm.runInContext(`isFlowProject(${JSON.stringify(url)})`,env.ctx),false,url);
  }
});
test('panel selects a collection composer and uses the same URL rules as the worker',async()=>{
  const url='https://flow.google.com/project/project-fixture/collection/collection-fixture';
  const env=setup([{id:9,url,active:true}]);await delay(5);
  assert.equal((await vm.runInContext('getFlowTab()',env.ctx)).id,9);
  for(const bad of [url+'/edit','https://flow.google.com/project/project-fixture/characters']) {
    assert.equal(vm.runInContext(`isFlowProject(${JSON.stringify(bad)})`,env.ctx),false);
  }
});
test('choose active Flow project, reject ambiguous background projects',async()=>{
  const tabs=[{id:1,url:'https://labs.google/fx/tools/flow/project/old'}, {id:2,url:'https://flow.google.com/project/new',active:true}];
  const env=setup(tabs);await delay(5);
  assert.equal((await vm.runInContext('getFlowTab()',env.ctx)).id,2);
  tabs[1].active=false;
  await assert.rejects(vm.runInContext('getFlowTab()',env.ctx),/nhiều project/);
});
test('missing project leaves Start usable and does not submit',async()=>{
  const env=setup([]);await delay(5);
  env.elements.get('prompts').value='Test';
  await vm.runInContext('run()',env.ctx);
  assert.equal(env.sent.length,0);assert.equal(env.elements.get('start').disabled,false);
  assert.match(env.elements.get('connText').textContent,/flow.google.com/);
});
test('packaged permissions cover both Flow domains and every selector value is correct',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../manifest.json'),'utf8'));
  assert.ok(manifest.host_permissions.includes('https://flow.google.com/*'));
  assert.ok(manifest.content_scripts[0].matches.includes('https://flow.google.com/*'));
  assert.ok(manifest.content_scripts[0].matches.includes('https://labs.google/fx/*'));
  const html=fs.readFileSync(path.join(__dirname,'../sidepanel.html'),'utf8');
  const values=[...html.matchAll(/<option value="(\d+)"(?: selected)?>(\d+) prompt<\/option>/g)];
  assert.equal(values.length,10);
  values.forEach((m,i)=>{assert.equal(Number(m[1]),i+1);assert.equal(m[1],m[2]);});
});
test('an interrupted transfer still allows a later confirmed sibling download before stopping',async()=>{
  const env=setup();await delay(5);
  env.elements.get('prompts').value='one\ntwo\nthree';
  env.elements.get('concurrency').value='2';
  const task=vm.runInContext('run()',env.ctx);await until(()=>env.sent.length===2);
  env.waiting.push({id:1,attempt:1,bound:true,reason:'waiting'});
  env.results.push({id:0,status:'uncertain',error:'interrupted'});
  env.fail('interrupted'); await delay(25);
  assert.equal(env.elements.get('start').disabled,true);
  env.waiting.length=0;
  env.results.push({id:1,status:'done',src:'https://fixture.invalid/two.png'});
  await task;
  assert.deepEqual(env.sent,['one','two']);
  assert.equal(env.downloads.length,1);
  assert.match(env.downloads[0].filename,/two/);
});
test('resume at line 41 submits only that suffix, keeps IDs and prefix 041',async()=>{
  const env=setup();await delay(5);
  env.elements.get('prompts').value=Array.from({length:42},(_,i)=>'scene '+(i+1)).join('\n');
  env.elements.get('firstPrompt').value='41';
  env.elements.get('concurrency').value='1';
  env.elements.get('serial').checked=true;
  const task=vm.runInContext('run()',env.ctx);
  await until(()=>env.sent.length===1);
  env.results.push({id:40,status:'done',src:'https://fixture.invalid/41.png'});
  await until(()=>env.sent.length===2);
  env.results.push({id:41,status:'done',src:'https://fixture.invalid/42.png'});
  await task;
  assert.deepEqual(env.sent,['scene 41','scene 42']);
  assert.match(env.downloads[0].filename,/041_scene-41/);
  assert.match(env.downloads[1].filename,/042_scene-42/);
});
test('rejects a resume position past the end without sending',async()=>{
  const env=setup();await delay(5);
  env.elements.get('prompts').value='one';env.elements.get('firstPrompt').value='41';
  await vm.runInContext('run()',env.ctx);assert.deepEqual(env.sent,[]);
  assert.match(env.elements.get('connText').textContent,/từ 1 đến 1/);
});
