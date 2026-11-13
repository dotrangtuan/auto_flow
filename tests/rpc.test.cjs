const {test} = require('node:test');
const assert = require('node:assert/strict');
const P = require('../flow-protocol.js');
const {FlowRpcTracker} = require('../rpc-tracker.js');
const F = require('./rpc-fixtures.cjs');
test('matches the masked upstream AutoFlowCut capture schema',()=>{
  const fixture=require('./upstream-image.masked.json');
  assert.equal(P.requestPrompt(new URLSearchParams({'f.req':fixture.fReq}).toString()),'궁정안에 있는 왕');
  const image=P.imageResult(fixture.response);
  assert.equal(image.width,1376);assert.equal(image.height,768);
});
test('request parser supports Unicode and encoded + without retaining authentication fields',()=>{
  assert.equal(P.requestPrompt(F.request('A + 日本語\n fox')), 'A + 日本語 fox');
  assert.equal(P.requestPrompt(F.request('x',2)),null);
  assert.equal(P.requestPrompt('f.req=broken&at=SECRET'),null);
});
test('RPC and project URLs require exact origin and composer paths',()=>{
  assert.equal(P.imageRpc(F.rpcUrl),true);
  for(const u of ['https://evil.test/data/batchexecute?rpcids=ogiZ0b','https://flow.google.com.evil.test/data/batchexecute?rpcids=ogiZ0b',F.rpcUrl.replace('https:','http:')]) assert.equal(P.imageRpc(u),false);
  assert.equal(P.projectKey('https://flow.google.com/project/a/all-media'),P.projectKey('https://flow.google.com/project/a'));
  assert.equal(P.projectKey('https://flow.google.com/project/a/characters'),null);
});
test('parse only one real-sized image on exact media host, ignore stale frame lengths',()=>{
  assert.equal(P.imageResult(F.response()).mediaId,'fixture-media-1');
  for(const text of [F.response('x',2),F.response('x',0),F.response('x',1,'evil.test'),F.response().replace('https:','http:'),'private-broken-response']) assert.throws(()=>P.imageResult(text));
});
test('out of order completions remain attached to original prompt IDs',()=>{
  const t=new FlowRpcTracker(P);
  t.arm(0,1,'first'); t.bind('req-first',F.request('first'));
  t.arm(1,1,'second'); t.bind('req-second',F.request('second'));
  t.response('req-second',200,F.response('second-image'));
  t.response('req-first',200,F.response('first-image'));
  assert.deepEqual(t.poll().results.map(r=>[r.id,r.mediaId]),[[0,'first-image'],[1,'second-image']]);
  t.response('req-first',200,F.response('duplicate'));
  assert.equal(t.poll().results[0].mediaId,'first-image');
});
test('a different prompt cannot claim a single pending request; no image guessing',()=>{
  const t=new FlowRpcTracker(P);t.arm(0,1,'mine');
  assert.equal(t.bind('req',F.request('manual')),null);
  assert.equal(t.poll().results[0].status,'uncertain');assert.ok(t.fatal);
  assert.throws(()=>t.arm(1,1,'next'));
});
test('ambiguous equal prompts, multi-image requests and malformed request halt dispatch',()=>{
  for(const body of [F.request('a'),F.request('a',2),'f.req=broken']) {
    const t=new FlowRpcTracker(P);t.arm(0,1,'a');t.arm(1,1,'a');
    assert.equal(t.bind('req',body),null);assert.ok(t.fatal);
  }
});
test('only explicit transient RPC failures permit retry; quotas/auth/transport do not',()=>{
  for(const code of [8,16,7,3,13,14]) {
    const t=new FlowRpcTracker(P);t.arm(0,1,'a');t.bind('req',F.request('a'));
    t.response('req',200,F.failure(code));
    assert.equal(t.poll().results[0].status,[13,14].includes(code)?'error':'uncertain');
    if([13,14].includes(code)) assert.doesNotThrow(()=>t.arm(0,2,'a'));
    else assert.throws(()=>t.arm(0,2,'a'));
  }
  const t=new FlowRpcTracker(P);t.arm(0,1,'a');t.bind('req',F.request('a'));t.failed('req');
  assert.equal(t.poll().results[0].status,'uncertain');assert.throws(()=>t.arm(0,2,'a'));
});
test('send and result deadlines mark uncertain; timeout never frees a retry slot',()=>{
  let now=0;const t=new FlowRpcTracker(P,()=>now);t.arm(0,1,'a');
  now=30001;assert.equal(t.poll().results.length,0);
  now=100001;assert.equal(t.poll().results[0].status,'uncertain');assert.throws(()=>t.arm(0,2,'a'));
  const s=new FlowRpcTracker(P,()=>now);s.arm(0,1,'b');s.bind('b',F.request('b'));
  now+=600001;assert.equal(s.poll().results[0].status,'uncertain');
});
test('schema failure and duplicate media IDs never become downloads',()=>{
  for(const text of ['broken',F.response('a',2)]) {
    const t=new FlowRpcTracker(P);t.arm(0,1,'a');t.bind('r',F.request('a'));t.response('r',200,text);
    assert.equal(t.poll().results[0].status,'uncertain');
  }
  const t=new FlowRpcTracker(P);t.arm(0,1,'a');t.bind('a',F.request('a'));t.response('a',200,F.response('same'));
  t.arm(1,1,'b');t.bind('b',F.request('b'));t.response('b',200,F.response('same'));
  assert.equal(t.poll().results[1].status,'uncertain');
});
