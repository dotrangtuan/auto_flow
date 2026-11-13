const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup}=require('./worker-harness.cjs');
const F=require('./rpc-fixtures.cjs');
async function bind(e,id,prompt,body=F.request(prompt)) {
  await e.event('Network.requestWillBeSent',{requestId:id,type:'XHR',request:{method:'POST',url:F.rpcUrl,postData:body}});
}
async function finish(e,id,text,base64Encoded=false) {
  e.responses.set(id,{body:base64Encoded?Buffer.from(text).toString('base64'):text,base64Encoded});
  await e.event('Network.responseReceived',{requestId:id,response:{status:200}});
  await e.event('Network.loadingFinished',{requestId:id,encodedDataLength:500});
}
test('worker binds Chrome requestId, confirms without a DOM card, decodes a Unicode base64 result',async()=>{
  const e=setup();assert.equal((await e.send({type:'DEBUG_START'})).ok,true);
  assert.ok(e.commands.some(c=>c.method==='Network.enable'));
  assert.equal((await e.send({type:'DEBUG_SUBMIT',id:0,attempt:1,prompt:'日本語 fox',x:1,y:1})).ok,true);
  await bind(e,'request-1','日本語 fox');
  assert.equal((await e.send({type:'DEBUG_CONFIRM',id:0,attempt:1})).ok,true);
  await finish(e,'request-1',F.response('correct-image'),true);
  const state=await e.send({type:'DEBUG_POLL'});
  assert.equal(state.results[0].mediaId,'correct-image');assert.equal(state.results[0].source,'network');
  assert.ok(!JSON.stringify(state).includes('NOT_A_REAL_TOKEN'));
  assert.ok(!e.commands.some(c=>c.method.includes('replay')||c.method==='Fetch.enable'));
  await e.send({type:'DEBUG_STOP'});
});
test('missing inline postData uses getRequestPostData and fetch requests use the same pipeline',async()=>{
  const e=setup();await e.send({type:'DEBUG_START'});await e.send({type:'DEBUG_SUBMIT',id:0,prompt:'a',x:1,y:1});
  e.postData.set('fetch-1',F.request('a'));
  await e.event('Network.requestWillBeSent',{requestId:'fetch-1',type:'Fetch',request:{method:'POST',url:F.rpcUrl}});
  await finish(e,'fetch-1',F.response());
  assert.equal((await e.send({type:'DEBUG_POLL'})).results[0].status,'done');await e.send({type:'DEBUG_STOP'});
});
test('Stop while typing prevents Enter and rejects a stale submission',async()=>{
  const e=setup();await e.send({type:'DEBUG_START'});
  const task=e.send({type:'DEBUG_SUBMIT',id:0,prompt:'a',x:1,y:1});
  await new Promise(r=>setTimeout(r,20));await e.send({type:'DEBUG_STOP'});
  assert.equal((await task).ok,false);assert.equal(e.commands.filter(c=>c.params.key==='Enter').length,0);
  assert.equal((await e.send({type:'DEBUG_SUBMIT',id:1,prompt:'b'})).ok,false);
});
test('detaching, project switches, reloads and lost requests halt without another Enter',async()=>{
  for(const action of ['detach','navigate','reload','networkFail']) {
    const e=setup();await e.send({type:'DEBUG_START'});await e.send({type:'DEBUG_SUBMIT',id:0,prompt:'a',x:1,y:1});
    await bind(e,'a','a');
    if(action==='detach') e.detach();
    if(action==='navigate') e.navigate('https://flow.google.com/project/other');
    if(action==='reload') await e.event('Network.requestWillBeSent',{requestId:'doc',type:'Document',request:{url:'https://flow.google.com/project/fixture'}});
    if(action==='networkFail') await e.event('Network.loadingFailed',{requestId:'a'});
    const state=await e.send({type:'DEBUG_POLL'});
    assert.ok(!state.ok || state.results.some(r=>r.status==='uncertain'));
    await e.send({type:'DEBUG_STOP'});
  }
});
test('readback mismatch does not press Enter',async()=>{
  const e=setup();await e.send({type:'DEBUG_START'});e.readback('wrong');
  assert.equal((await e.send({type:'DEBUG_SUBMIT',id:0,prompt:'right',x:1,y:1})).ok,false);
  assert.equal(e.commands.filter(c=>c.params.key==='Enter').length,0);await e.send({type:'DEBUG_STOP'});
});
test('interrupted stream returns the matching image from buffered bytes and late chunks', async () => {
  let enableStream;
  const e = setup({streamCommand(id, cb) { enableStream = cb; }});
  await e.send({type:'DEBUG_START'});
  await e.send({type:'DEBUG_SUBMIT',id:0,prompt:'狐',x:1,y:1});
  await bind(e,'r','狐');
  await e.event('Network.responseReceived',{requestId:'r',response:{status:200}});
  const bytes = Buffer.from(F.response('狐'));
  const split = bytes.indexOf(Buffer.from('狐')) + 1;
  await e.event('Network.dataReceived',{requestId:'unrelated',data:'invalid'});
  await e.event('Network.dataReceived',{requestId:'r',data:bytes.subarray(split).toString('base64')});
  enableStream({bufferedData:bytes.subarray(0,split).toString('base64')});
  await e.event('Network.loadingFailed',{requestId:'r',errorText:'net::ERR_ABORTED',canceled:true});
  const state = await e.send({type:'DEBUG_POLL'});
  assert.equal(state.fatal,'');
  assert.equal(state.results[0].mediaId,'狐');
  assert.equal(e.commands.filter(c=>c.params.type==='rawKeyDown' && c.params.key==='Enter').length,1);
  await e.send({type:'DEBUG_STOP'});
});
test('truncated or unsuccessful frames on failure keep the prompt uncertain and show only the Chrome code', async () => {
  for (const bytes of [F.response().slice(0,70),F.failure(14)]) {
    const e = setup({streamCommand(id,cb){cb({bufferedData:Buffer.from(bytes).toString('base64')});}});
    await e.send({type:'DEBUG_START'});
    await e.send({type:'DEBUG_SUBMIT',id:2,prompt:'test',x:1,y:1});
    await bind(e,'r','test');
    await e.event('Network.responseReceived',{requestId:'r',response:{status:200}});
    await e.event('Network.loadingFailed',{requestId:'r',errorText:'net::ERR_ABORTED secret-url',canceled:true});
    const state = await e.send({type:'DEBUG_POLL'});
    assert.match(state.fatal,/Prompt 3 \[net::ERR_ABORTED, canceled, HTTP 200\]/);
    assert.doesNotMatch(JSON.stringify(state),/secret-url/);
    assert.equal(state.results[0].status,'uncertain');
    await e.send({type:'DEBUG_STOP'});
  }
});
