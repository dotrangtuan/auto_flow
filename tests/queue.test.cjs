const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FlowQueue } = require('../queue.js');
function fill(q, now=0) {const ids=[];let item;while((item=q.reserve(now))){ids.push(item.id);q.accepted(item.id);}return ids;}
test('10-prompt barrier: one or nine completions do not admit prompt 11',()=>{
  const q=new FlowQueue(Array.from({length:25},(_,i)=>`p${i}`),10);
  assert.deepEqual(fill(q),Array.from({length:10},(_,i)=>i));
  q.finish(6,'downloading');assert.equal(q.reserve(),null);
  for(const i of [0,1,2,3,4,5,7,8])q.finish(i,'downloading');
  assert.equal(q.reserve(),null);q.finish(9,'downloading');
  assert.equal(q.reserve().id,10);assert.equal(q.groupNumber,2);
});
test('215 prompts advance in complete groups for every group size 1–10; last group may be partial',()=>{
  for(let size=1;size<=10;size++){
    const q=new FlowQueue(Array.from({length:215},(_,i)=>`p${i}`),size);
    let completed=0;
    while(!q.complete){
      const ids=fill(q);assert.equal(ids.length,Math.min(size,215-completed));
      for(const id of ids.slice(1).reverse()){q.finish(id,'downloading');assert.equal(q.reserve(),null);}
      q.finish(ids[0],'downloading');completed+=ids.length;
    }
    assert.equal(completed,215);
  }
});
test('failed prompt retries indefinitely without advancing or regenerating successful prompts',()=>{
  const q=new FlowQueue(['one','two','three','next-group'],3);fill(q);
  q.finish(0,'downloading');q.finish(1,'error',0);q.finish(2,'downloading');
  assert.equal(q.reserve(4999),null);
  for(let attempt=2;attempt<=25;attempt++){
    const item=q.reserve(q.items[1].retryAt);assert.equal(item.id,1);assert.equal(item.attempts,attempt);
    q.accepted(1);q.finish(1,'error',attempt*100000);
    assert.equal(q.groupNumber,1);assert.equal(q.items[0].attempts,1);assert.equal(q.items[2].attempts,1);
    assert.ok(q.items[1].retryAt-attempt*100000<=60000);
  }
  const item=q.reserve(q.items[1].retryAt);q.accepted(item.id);q.finish(item.id,'downloading');
  assert.equal(q.reserve().id,3);
});
test('first wave is sent completely; retries wait for other in-flight attempts',()=>{
  const q=new FlowQueue(['one','two','three','four'],3);
  q.reserve();q.accepted(0);q.finish(0,'error',0);
  assert.equal(q.reserve().id,1);q.accepted(1);
  assert.equal(q.reserve().id,2);q.accepted(2);
  assert.equal(q.reserve(999999),null);q.finish(1,'downloading');q.finish(2,'downloading');
  assert.equal(q.reserve(999999).id,0);
});
test('two failures both must succeed; Stop during retry wait never dispatches',()=>{
  const q=new FlowQueue(['one','two','next'],2);fill(q);q.finish(0,'error',0);q.finish(1,'error',0);
  assert.equal(q.reserve(5000).id,0);q.accepted(0);q.finish(0,'downloading');
  assert.equal(q.reserve(5000).id,1);q.accepted(1);q.finish(1,'error',5000);
  q.stop();assert.equal(q.reserve(999999),null);assert.equal(q.complete,false);
});
test('download failure does not retry generation; uncertain state blocks the group',()=>{
  const q=new FlowQueue(['one','two','next'],2);fill(q);q.finish(0,'downloading');q.items[0].status='error';
  q.uncertain(1);assert.equal(q.reserve(999999),null);assert.equal(q.items[0].generated,true);
  assert.equal(q.items[0].attempts,1);assert.equal(q.complete,false);
});
test('duplicate prompts are serialized inside the group; duplicate completion cannot change state',()=>{
  const q=new FlowQueue(['same   prompt','same prompt','next'],2);assert.equal(q.reserve().id,0);q.accepted(0);
  assert.equal(q.reserve(),null);q.finish(0,'downloading');assert.equal(q.finish(0,'error'),false);
  assert.equal(q.reserve().id,1);q.accepted(1);assert.equal(q.reserve(),null);q.finish(1,'downloading');
  assert.equal(q.reserve().id,2);
});
