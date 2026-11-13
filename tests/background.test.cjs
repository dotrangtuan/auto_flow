const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {setup}=require('./worker-harness.cjs');
test('sender serializes writes and submits Enter exactly once',async()=>{
  const {send,commands}=setup(); await send({type:'DEBUG_START'});
  const first=send({type:'DEBUG_SUBMIT',id:0,attempt:1,x:1,y:1,prompt:'one'});
  assert.equal((await send({type:'DEBUG_SUBMIT',id:0,attempt:1,x:1,y:1,prompt:'two'})).ok,false);
  assert.equal((await first).ok,true);
  assert.equal(commands.filter(c=>c.method==='Input.insertText').length,1);
  assert.equal(commands.filter(c=>c.params.type==='rawKeyDown'&&c.params.key==='Enter').length,1);
  await send({type:'DEBUG_STOP'});
});
test('Stop during typing prevents Enter and old session cannot submit again',async()=>{
  const {send,commands}=setup(); await send({type:'DEBUG_START'});
  const first=send({type:'DEBUG_SUBMIT',id:0,attempt:1,x:1,y:1,prompt:'one'});
  await new Promise(r=>setTimeout(r,20)); await send({type:'DEBUG_STOP'});
  assert.equal((await first).ok,false);
  assert.equal(commands.filter(c=>c.params.key==='Enter').length,0);
  assert.equal((await send({type:'DEBUG_SUBMIT',id:0,attempt:1,prompt:'late'})).ok,false);
});
test('modern composer clicks the verified button once and never follows with Enter',async()=>{
  const e=setup({target:{x:53,y:62}});await e.send({type:'DEBUG_START'});
  assert.equal((await e.send({type:'DEBUG_SUBMIT',id:40,x:1,y:2,prompt:'41'})).ok,true);
  const press=e.commands.filter(c=>c.method==='Input.dispatchMouseEvent'&&c.params.x===53);
  assert.deepEqual(press.map(c=>c.params.type),['mousePressed','mouseReleased']);
  assert.equal(e.commands.filter(c=>c.params.key==='Enter').length,0);
  await e.send({type:'DEBUG_STOP'});
});
test('an obstructed modern submit button stops before submission',async()=>{
  const e=setup({target:{error:'Nút gửi trên Flow đang bị che.'}});await e.send({type:'DEBUG_START'});
  const result=await e.send({type:'DEBUG_SUBMIT',id:0,x:1,y:2,prompt:'one'});
  assert.equal(result.ok,false);assert.match(result.error,/Chưa bấm gửi/);
  assert.equal(e.commands.filter(c=>c.params.key==='Enter').length,0);
  await e.send({type:'DEBUG_STOP'});
});
