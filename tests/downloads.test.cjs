const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function setup({early=true,storage={}}={}) {
  const listeners=[];let determine;let erase;let next=0;
  const files=new Map(),options=[];
  const chrome={runtime:{id:'this-extension',onMessage:{addListener(fn){listeners.push(fn);}}},
    storage:{session:{async set(o){Object.assign(storage,JSON.parse(JSON.stringify(o)));},async get(k){return {[k]:storage[k]};},async remove(k){delete storage[k];}}},
    downloads:{onDeterminingFilename:{addListener(fn){determine=fn;}},onErased:{addListener(fn){erase=fn;}},
      async download(opts){
        options.push(opts);const id=++next;
        const item={id,url:opts.url,byExtensionId:'this-extension',mime:'image/jpeg',filename:'C:/Downloads/uuid.jfif',state:'in_progress'};
        files.set(id,item);
        if(early) await suggest(item);
        return id;
      },async search({id}){return files.has(id)?[files.get(id)]:[];}}};
  async function suggest(item) {
    let calls=0;let suggestion;
    await new Promise(resolve=>determine(item,result=>{calls++;suggestion=result;resolve();}));
    assert.equal(calls,1);
    if(suggestion){item.filename='C:/Downloads/'+suggestion.filename;}
    return suggestion;
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../downloads.js'),'utf8'),{chrome,console,Map,Promise});
  const send=msg=>new Promise(resolve=>{for(const fn of listeners)fn(msg,{},resolve);});
  return {send,files,options,suggest,storage,erase};
}
const start=(s,num,url='https://fixture.invalid/image')=>s.send({type:'DOWNLOAD_IMAGE',url,filename:`h2dev_flow/${String(num).padStart(3,'0')}_scene.png`});
test('filename event before download response keeps prompt number and correct JPEG extension',async()=>{
  const s=setup();const r=await start(s,7);assert.equal(r.ok,true);
  const item=s.files.get(r.downloadId);assert.equal(item.filename,'C:/Downloads/h2dev_flow/007_scene.jpg');
  let result=await s.send({type:'DOWNLOAD_STATUS',downloadId:r.downloadId});assert.equal(result.state,'in_progress');
  item.state='complete';result=await s.send({type:'DOWNLOAD_STATUS',downloadId:r.downloadId});assert.equal(result.ok,true);assert.equal(result.state,'complete');
});
test('three concurrent identical URLs receive separate names; late events match download IDs',async()=>{
  const s=setup({early:false});const rs=await Promise.all([start(s,3),start(s,1),start(s,2)]);
  for(const i of [2,0,1])await s.suggest(s.files.get(rs[i].downloadId));
  for(const [i,n] of [3,1,2].entries()){
    const item=s.files.get(rs[i].downloadId);assert.ok(item.filename.endsWith(`00${n}_scene.jpg`));
  }
});
test('persisted naming survives worker restart without retaining signed URLs or image bytes',async()=>{
  const s=setup({early:false});const r=await start(s,8,'data:image/png;base64,AAA');
  assert.equal(JSON.stringify(s.storage).includes('base64'),false);
  const fresh=setup({storage:s.storage});
  const item=s.files.get(r.downloadId);item.mime='image/png';
  await fresh.suggest(item);assert.ok(item.filename.endsWith('008_scene.png'));
});
test('manual downloads and other extensions are not renamed',async()=>{
  const s=setup();await start(s,1);
  for(const byExtensionId of [undefined,'another-extension']){
    const item={id:55,url:'https://fixture.invalid/image',byExtensionId,mime:'image/jpeg',filename:'uuid.jfif'};
    assert.equal(await s.suggest(item),undefined);assert.equal(item.filename,'uuid.jfif');
  }
});
test('actual UUID filename and interrupted downloads report errors, uniqueness suffix is accepted',async()=>{
  const s=setup();const r=await start(s,2);const item=s.files.get(r.downloadId);item.state='complete';
  item.filename='C:\\Users\\Admin\\Downloads\\h2dev_flow\\002_scene (1).jpg';
  assert.equal((await s.send({type:'DOWNLOAD_STATUS',downloadId:r.downloadId})).ok,true);
  item.filename='C:/Downloads/uuid.jfif';let result=await s.send({type:'DOWNLOAD_STATUS',downloadId:r.downloadId});
  assert.equal(result.ok,false);assert.equal(result.state,'name_mismatch');assert.match(result.error,/002_scene.jpg/);
  item.state='interrupted';item.error='NETWORK_FAILED';result=await s.send({type:'DOWNLOAD_STATUS',downloadId:r.downloadId});assert.equal(result.ok,false);assert.match(result.error,/NETWORK_FAILED/);
});
test('unsafe paths are rejected; erasing a download removes its metadata',async()=>{
  const s=setup();assert.equal((await s.send({type:'DOWNLOAD_IMAGE',url:'https://fixture.invalid/img',filename:'../001.png'})).ok,false);
  const r=await start(s,1);s.erase(r.downloadId);assert.equal(s.storage[`h2flow.download.${r.downloadId}`],undefined);
});
