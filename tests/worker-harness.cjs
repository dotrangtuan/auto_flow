const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function setup(options={}) {
  const messages=[],commands=[],responses=new Map(),postData=new Map();
  let onDetach,onUpdated;
  let projectUrl=options.projectUrl || 'https://flow.google.com/project/fixture';
  let editor='',readbackOverride;
  const chrome={runtime:{id:'fixture-extension',getPlatformInfo:async()=>{if(options.platformError)throw new Error('Platform information unavailable');return {os:options.os||'win'};},onInstalled:{addListener(){}},onMessage:{addListener(fn){messages.push(fn);}}},
    debugger:{onDetach:{addListener(fn){onDetach=fn;}},onEvent:{addListener(){}},attach(t,v,cb){
      if(options.attachError)chrome.runtime.lastError={message:options.attachError};cb();delete chrome.runtime.lastError;
    },async detach(){},
      sendCommand(t,method,params,cb){
        commands.push({method,params});
        if(method==='Network.enable' && (options.networkError || (options.rejectBufferOptions && Object.keys(params).length))) {
          chrome.runtime.lastError={message:options.networkError||'Invalid parameters'};cb();delete chrome.runtime.lastError;return;
        }
        if(method==='Network.streamResourceContent' && options.streamCommand) {
          options.streamCommand(params.requestId, cb); return;
        }
        if(method==='Input.insertText') editor=params.text;
        if(method==='Runtime.evaluate') cb({result:{value:params.expression.includes('function locateFlowSubmit') ? (options.target || {legacy:true}) : readbackOverride??editor}});
        else if(method==='Network.getResponseBody') cb(responses.get(params.requestId)||{body:'',base64Encoded:false});
        else if(method==='Network.getRequestPostData') cb({postData:postData.get(params.requestId)});
        else cb({});
      }},
    tabs:{get:async()=>({url:projectUrl}),onUpdated:{addListener(fn){onUpdated=fn;}},onRemoved:{addListener(){}}},
    sidePanel:{setPanelBehavior:async()=>{}}};
  const ctx=vm.createContext({chrome,console,URL,URLSearchParams,TextDecoder,Uint8Array,atob,setTimeout,clearTimeout});
  if(options.platformMissing)delete chrome.runtime.getPlatformInfo;
  ctx.importScripts=(...files)=>files.filter(f=>f!=='downloads.js').forEach(f=>vm.runInContext(fs.readFileSync(path.join(__dirname,'..',f),'utf8'),ctx));
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../background.js'),'utf8'),ctx);
  const send=msg=>new Promise(r=>{for(const fn of messages) fn({batchId:'batch',tabId:1,...msg},{id:'fixture-extension'},r);});
  const event=async(method,params)=>{ctx.evt={source:{tabId:1},method,params};await vm.runInContext('handleRpcNetwork(evt.source,evt.method,evt.params)',ctx);};
  return {ctx,send,event,commands,responses,postData,detach(){onDetach({tabId:1});},navigate(url){projectUrl=url;onUpdated(1,{url});},readback(value){readbackOverride=value;}};
}
module.exports={setup};
