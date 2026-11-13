const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8')
  .replace('settleMs: 1800', 'settleMs: 20').replace('maxWaitMs: 600000', 'maxWaitMs: 3000');
async function setup() {
  const browser = await chromium.launch({headless:true, args:['--no-sandbox']});
  const page = await browser.newPage();
  await page.route('https://fixture.invalid/**', r => r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="green"/></svg>'}));
  await page.setContent('<style>article {width:300px;height:300px} [role=progressbar]{width:200px;height:150px}</style><textarea></textarea><main></main>');
  await page.evaluate(() => { window.listener = null; window.chrome = {runtime:{onMessage:{addListener(fn){window.listener = fn;}}}}; });
  await page.addScriptTag({content:source});
  const msg = payload => page.evaluate(m => new Promise(r => window.listener(m, {}, r)), {batchId:'test', ...payload});
  assert.equal((await msg({type:'BATCH_START'})).ok,true);
  return {browser,page,msg};
}
async function addJob(ctx,id,prompt) {
  assert.equal((await ctx.msg({type:'PREPARE_JOB',id,prompt})).ok,true);
  await ctx.page.evaluate(({id,prompt}) => {
    const el = document.createElement('article'); el.dataset.generationId = id; el.id = `job${id}`;
    const label = document.createElement('p'); label.textContent = prompt; el.append(label);
    const busy = document.createElement('div'); busy.setAttribute('role','progressbar'); el.append(busy);
    document.querySelector('main').append(el);
  },{id,prompt});
  assert.equal((await ctx.msg({type:'CONFIRM_JOB',id})).ok,true);
}
async function complete(ctx,id) {
  await ctx.page.evaluate(async id => {
    const card = document.getElementById(`job${id}`); card.querySelector('[role=progressbar]').remove();
    const img = new Image(); img.src=`https://fixture.invalid/${id}.png`; card.append(img); await img.decode();
  }, id);
  await ctx.msg({type:'POLL_JOBS'}); await ctx.page.waitForTimeout(30);
  return ctx.msg({type:'POLL_JOBS'});
}
test('DOM: out-of-order result maps to its own prompt, no global-image fallback, repeat injection is safe', async () => {
  const ctx = await setup();
  try {
    await addJob(ctx,0,'Prompt one'); await addJob(ctx,1,'Prompt two');
    await ctx.page.evaluate(async () => { const img = new Image(); img.src='https://fixture.invalid/unrelated.png'; document.body.append(img); await img.decode(); });
    assert.equal((await ctx.msg({type:'POLL_JOBS'})).results.length,0);
    let poll = await complete(ctx,1);
    assert.deepEqual(poll.results.map(r=>r.id),[1]);
    assert.equal(poll.results[0].src,'https://fixture.invalid/1.png');
    poll = await complete(ctx,0); assert.equal(poll.results.length,2);
    await ctx.page.addScriptTag({content:source});
    assert.equal((await ctx.msg({type:'PING'})).ok,true);
  } finally {await ctx.browser.close();}
});
test('DOM: failed task is terminal, Stop rejects prepares, unresolved session blocks restart', async () => {
  const ctx = await setup();
  try {
    await addJob(ctx,0,'Task failure'); await addJob(ctx,1,'Still running');
    await ctx.page.evaluate(() => {
      const card=document.getElementById('job0'); card.querySelector('[role=progressbar]').remove();
      const err=document.createElement('div'); err.setAttribute('role','alert'); err.textContent='Generation failed'; card.append(err);
    });
    const poll=await ctx.msg({type:'POLL_JOBS'}); assert.equal(poll.results[0].status,'error');
    await ctx.msg({type:'STOP'});
    assert.equal((await ctx.msg({type:'PREPARE_JOB',id:2,prompt:'Must not send'})).ok,false);
    assert.equal((await ctx.msg({type:'BATCH_START',batchId:'new'})).ok,false);
  } finally {await ctx.browser.close();}
});
test('DOM: new placeholder can track a card without visible prompt text', async () => {
  const ctx=await setup();
  try {
    await ctx.msg({type:'PREPARE_JOB',id:0,prompt:'Hidden prompt'});
    await ctx.page.evaluate(() => {document.querySelector('main').innerHTML='<article id="job0"><div role="progressbar"></div></article>';});
    await ctx.msg({type:'CONFIRM_JOB',id:0});
    const poll=await complete(ctx,0); assert.equal(poll.results[0].id,0); assert.equal(poll.results[0].status,'done');
  } finally {await ctx.browser.close();}
});
