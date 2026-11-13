const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {Element}=require('./dom-fixture.cjs');
function setup() {
  let listener,now=100;
  const document=new Element('document'); document.body=document.append(new Element('body'));
  document.body.append(new Element('textarea'));
  const main=document.body.append(new Element('main'));
  const chrome={runtime:{onMessage:{addListener(fn){listener=fn;}}}};
  const window={};
  const source=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
  const context=vm.createContext({window,document,chrome,console,
    getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
    Date:{now:()=>now},setInterval:()=>{},setTimeout:fn=>{now+=250;queueMicrotask(fn);}});
  vm.runInContext(source,context);
  const send=msg=>new Promise(r=>listener({batchId:'test',...msg},{},r));
  const tick=()=>{now+=2000;};
  return {send,tick,main,document,context,source};
}
async function add(ctx,id,prompt,visible=true) {
  assert.equal((await ctx.send({type:'PREPARE_JOB',id,prompt})).ok,true);
  const card=ctx.main.append(new Element('article',{'data-generation-id':String(id)},visible?prompt:''));
  card.append(new Element('div',{role:'progressbar'}));
  assert.equal((await ctx.send({type:'CONFIRM_JOB',id})).ok,true);
  return card;
}
async function finish(ctx,card,id) {
  card.querySelector('[role="progressbar"]').remove();
  card.append(new Element('img',{src:`https://fixture.invalid/${id}.png`}));
  await ctx.send({type:'POLL_JOBS'});ctx.tick();return ctx.send({type:'POLL_JOBS'});
}
test('tracker: out-of-order completion, old/unrelated images excluded, duplicate polls stable',async()=>{
  const ctx=setup();
  ctx.main.append(new Element('article',{},'First')).append(new Element('img',{src:'https://fixture.invalid/old.png'}));
  assert.equal((await ctx.send({type:'BATCH_START'})).ok,true);
  const a=await add(ctx,0,'First');const b=await add(ctx,1,'Second');
  ctx.document.body.append(new Element('img',{src:'https://fixture.invalid/unrelated.png'}));
  assert.equal((await ctx.send({type:'POLL_JOBS'})).results.length,0);
  let p=await finish(ctx,b,1);assert.equal(p.results.length,1);assert.equal(p.results[0].id,1);
  p=await finish(ctx,a,0);assert.equal(p.results.length,2);
  assert.equal((await ctx.send({type:'POLL_JOBS'})).results.length,2);
  vm.runInContext(ctx.source,ctx.context);assert.equal((await ctx.send({type:'PING'})).ok,true);
});
test('tracker: anonymous placeholder, explicit failure, stop and unresolved restart guard',async()=>{
  const ctx=setup();await ctx.send({type:'BATCH_START'});
  const a=await add(ctx,0,'Hidden',false);
  const b=await add(ctx,1,'Fails');
  b.querySelector('[role="progressbar"]').remove();b.append(new Element('div',{role:'alert'},'Generation failed'));
  let p=await finish(ctx,a,0);assert.equal(p.results.find(r=>r.id===1).status,'error');
  await add(ctx,2,'Pending');
  await ctx.send({type:'STOP'});
  assert.equal((await ctx.send({type:'PREPARE_JOB',id:3,prompt:'Stopped'})).ok,false);
  assert.equal((await ctx.send({type:'BATCH_START',batchId:'new'})).ok,false);
});
test('tracker: timeout does not report success or free a slot',async()=>{
  const ctx=setup();await ctx.send({type:'BATCH_START'});await add(ctx,0,'Slow');
  for(let i=0;i<301;i++)ctx.tick();
  const p=await ctx.send({type:'POLL_JOBS'});assert.equal(p.results[0].status,'uncertain');
});
test('tracker: retry has a new attempt and cannot reuse the previous failed card',async()=>{
  const ctx=setup();await ctx.send({type:'BATCH_START'});
  const old=await add(ctx,0,'Retry me');
  old.querySelector('[role="progressbar"]').remove();old.append(new Element('div',{role:'alert'},'Generation failed'));
  let poll=await ctx.send({type:'POLL_JOBS'});assert.equal(poll.results[0].attempt,1);assert.equal(poll.results[0].status,'error');
  assert.equal((await ctx.send({type:'PREPARE_JOB',id:0,attempt:2,prompt:'Retry me'})).ok,true);
  const card=ctx.main.append(new Element('article',{'data-generation-id':'retry'},'Retry me'));
  card.append(new Element('div',{role:'progressbar'}));
  assert.equal((await ctx.send({type:'CONFIRM_JOB',id:0,attempt:2})).ok,true);
  poll=await ctx.send({type:'POLL_JOBS'});assert.equal(poll.results.length,1);
  poll=await finish(ctx,card,'retry');
  assert.equal(poll.results.length,2);assert.equal(poll.results.find(r=>r.attempt===2).status,'done');
  assert.equal((await ctx.send({type:'PREPARE_JOB',id:0,attempt:3,prompt:'Retry me'})).ok,false);
});
test('tracker: retry is refused while previous attempt is still running',async()=>{
  const ctx=setup();await ctx.send({type:'BATCH_START'});await add(ctx,0,'Still active');
  assert.equal((await ctx.send({type:'PREPARE_JOB',id:0,attempt:2,prompt:'Still active'})).ok,false);
});
test('tracker: explicit failed state is recognized even when the message uses different wording',async()=>{
  const ctx=setup();await ctx.send({type:'BATCH_START'});const card=await add(ctx,0,'Localized failure');
  card.querySelector('[role="progressbar"]').remove();card.append(new Element('div',{'data-status':'failed'},'Try again later'));
  const poll=await ctx.send({type:'POLL_JOBS'});assert.equal(poll.results[0].status,'error');
});
async function settle(ctx) {
  await ctx.send({type:'POLL_JOBS'});ctx.tick();return ctx.send({type:'POLL_JOBS'});
}
test('tracker: 100 percent text and completed ARIA progress no longer block a loaded image',async()=>{
  const ctx=setup();await ctx.send({type:'BATCH_START'});const card=await add(ctx,0,'Complete progress');
  const progress=card.querySelector('[role="progressbar"]');
  progress.attrs['aria-valuenow']='100';progress.attrs['aria-valuemax']='100';
  card.append(new Element('span',{},'100%'));
  card.append(new Element('img',{src:'https://fixture.invalid/complete.png'}));
  const poll=await settle(ctx);assert.equal(poll.results[0].status,'done');
});
test('tracker: a 256x144 image mounted twice with the same source is one result',async()=>{
  const ctx=setup();await ctx.send({type:'BATCH_START'});const card=await add(ctx,0,'Wide thumbnail');
  card.querySelector('[role="progressbar"]').remove();
  for(let i=0;i<2;i++){
    const img=new Element('img',{src:'https://fixture.invalid/wide.png'});img.naturalWidth=256;img.naturalHeight=144;card.append(img);
  }
  const poll=await settle(ctx);assert.equal(poll.results.length,1);assert.equal(poll.results[0].status,'done');
});
test('tracker: remounted card with the same generation ID recovers even if its prompt is hidden',async()=>{
  const ctx=setup();await ctx.send({type:'BATCH_START'});const old=await add(ctx,0,'Hidden after remount',false);
  old.remove();
  const replacement=ctx.main.append(new Element('article',{'data-generation-id':'0'}));
  const img=replacement.append(new Element('img',{src:'https://fixture.invalid/replaced.png'}));img.naturalWidth=160;img.naturalHeight=90;
  const poll=await settle(ctx);assert.equal(poll.results[0].src,'https://fixture.invalid/replaced.png');
});
test('tracker: two different new assets remain ambiguous and produce a waiting explanation',async()=>{
  const ctx=setup();await ctx.send({type:'BATCH_START'});const card=await add(ctx,0,'Ambiguous');
  card.querySelector('[role="progressbar"]').remove();
  card.append(new Element('img',{src:'https://fixture.invalid/a.png'}));card.append(new Element('img',{src:'https://fixture.invalid/b.png'}));
  const poll=await settle(ctx);assert.equal(poll.results.length,0);assert.match(poll.waiting[0].reason,/nhiều ảnh/);
});
test('tracker: rescan requests lazy image loading but waits for actual decoded data',async()=>{
  const ctx=setup();await ctx.send({type:'BATCH_START'});const card=await add(ctx,0,'Lazy image');
  card.querySelector('[role="progressbar"]').remove();
  const img=card.append(new Element('img',{src:'https://fixture.invalid/lazy.png'}));img.complete=false;img.loading='lazy';img.naturalWidth=0;img.naturalHeight=0;
  let poll=await ctx.send({type:'RESCAN_JOBS'});assert.equal(img.loading,'eager');assert.equal(poll.results.length,0);assert.match(poll.waiting[0].reason,/chưa tải đủ/);
  img.complete=true;img.naturalWidth=256;img.naturalHeight=144;
  poll=await settle(ctx);assert.equal(poll.results[0].status,'done');
});
test('tracker: a pre-existing reference image in the card does not hide the new result',async()=>{
  const ctx=setup();ctx.document.body.append(new Element('img',{src:'https://fixture.invalid/reference.png'}));
  await ctx.send({type:'BATCH_START'});const card=await add(ctx,0,'Result with reference');
  card.append(new Element('img',{src:'https://fixture.invalid/reference.png'}));
  const poll=await finish(ctx,card,'result');assert.equal(poll.results[0].src,'https://fixture.invalid/result.png');
});
