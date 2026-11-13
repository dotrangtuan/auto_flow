const {test}=require('node:test');
const assert=require('node:assert/strict');
const P=require('../flow-protocol.js');
const {setup}=require('./worker-harness.cjs');
const F=require('./rpc-fixtures.cjs');
const collection='https://flow.google.com/project/project-fixture/collection/collection-fixture';
test('collection composer URL is accepted, while other subpages remain excluded',()=>{
  assert.ok(P.projectKey(collection));
  assert.equal(P.projectKey(collection+'/?view=grid#bottom'),P.projectKey(collection));
  assert.notEqual(P.projectKey(collection),P.projectKey(collection.replace('collection-fixture','other-collection')));
  assert.notEqual(P.projectKey(collection),P.projectKey('https://flow.google.com/project/project-fixture'));
  for(const u of [collection+'/edit',collection.replace('/collection/collection-fixture','/collection/'),
    collection.replace('flow.google.com','flow.google.com.evil.test')]) assert.equal(P.projectKey(u),null);
});
test('worker starts and correlates an image inside a collection without read-project failure',async()=>{
  const e=setup({projectUrl:collection});
  assert.equal((await e.send({type:'DEBUG_START'})).ok,true);
  assert.equal((await e.send({type:'DEBUG_SUBMIT',id:0,prompt:'collection image',x:1,y:1})).ok,true);
  await e.event('Network.requestWillBeSent',{requestId:'collection-request',type:'Fetch',request:{method:'POST',url:F.rpcUrl,postData:F.request('collection image')}});
  e.responses.set('collection-request',{body:F.response('collection-result'),base64Encoded:false});
  await e.event('Network.responseReceived',{requestId:'collection-request',response:{status:200}});
  await e.event('Network.loadingFinished',{requestId:'collection-request',encodedDataLength:500});
  assert.equal((await e.send({type:'DEBUG_POLL'})).results[0].mediaId,'collection-result');
  await e.send({type:'DEBUG_STOP'});
});
test('switching collections stops input; a query-only change within the same collection does not',async()=>{
  const e=setup({projectUrl:collection});assert.equal((await e.send({type:'DEBUG_START'})).ok,true);
  e.navigate(collection+'?view=grid');
  assert.equal((await e.send({type:'DEBUG_POLL'})).fatal,'');
  e.navigate(collection.replace('collection-fixture','other-collection'));
  const state=await e.send({type:'DEBUG_POLL'});assert.ok(state.fatal);
  assert.equal((await e.send({type:'DEBUG_SUBMIT',id:0,prompt:'wrong collection',x:1,y:1})).ok,false);
  assert.equal(e.commands.filter(c=>c.method.startsWith('Input.')).length,0);
  await e.send({type:'DEBUG_STOP'});
});
