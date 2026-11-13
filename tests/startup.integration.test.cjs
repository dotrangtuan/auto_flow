const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup}=require('./worker-harness.cjs');
test('debugger conflict is diagnosed accurately before a prompt can be sent',async()=>{
  const e=setup({attachError:'Another debugger is already attached to the tab with id: 1.'});
  const result=await e.send({type:'DEBUG_START'});
  assert.equal(result.ok,false);assert.equal(result.stage,'attach-debugger');
  assert.match(result.error,/bộ gỡ lỗi khác/);assert.match(result.detail,/Another debugger/);
  assert.equal(e.commands.length,0);
});
test('browser policy is not misreported as an open DevTools window',async()=>{
  const e=setup({attachError:'Host access is restricted by policy.'});
  const result=await e.send({type:'DEBUG_START'});
  assert.equal(result.ok,false);assert.match(result.error,/chặn quyền/);
  assert.ok(!result.error.includes('Đóng DevTools'));
});
test('platform lookup failure or unavailable API does not block the watcher',async()=>{
  for(const options of [{platformError:true},{platformMissing:true}]) {
    const e=setup(options);assert.equal((await e.send({type:'DEBUG_START'})).ok,true);
    assert.ok(e.commands.some(c=>c.method==='Network.enable'));
    await e.send({type:'DEBUG_STOP'});
  }
});
test('Network.enable retries without optional parameters only on parameter rejection',async()=>{
  const e=setup({rejectBufferOptions:true});
  assert.equal((await e.send({type:'DEBUG_START'})).ok,true);
  const calls=e.commands.filter(c=>c.method==='Network.enable');assert.equal(calls.length,2);
  assert.equal(Object.keys(calls[1].params).length,0);await e.send({type:'DEBUG_STOP'});
});
test('other network failures retain the actual reason and do not retry or enter text',async()=>{
  const e=setup({networkError:'No target with given id found'});
  const r=await e.send({type:'DEBUG_START'});
  assert.equal(r.ok,false);assert.equal(r.stage,'network-enable');assert.match(r.detail,/No target/);
  assert.equal(e.commands.filter(c=>c.method==='Network.enable').length,1);
  assert.equal(e.commands.filter(c=>c.method.startsWith('Input.')).length,0);
});
test('non-composer URL is reported as a project error, not a debugger error',async()=>{
  const e=setup({projectUrl:'https://flow.google.com/project/fixture/characters'});
  const r=await e.send({type:'DEBUG_START'});
  assert.equal(r.ok,false);assert.equal(r.stage,'read-project');
  assert.match(r.error,/màn hình nhập prompt/);
});
