// Synthetic protocol fixture. No Google account, cookie, token or live media.
const rpcUrl = 'https://flow.google.com/_/FlowUi/data/batchexecute?rpcids=ogiZ0b';
function request(prompt, count = 1) {
  const item = []; item[8] = [[[prompt]]];
  return new URLSearchParams({ 'f.req': JSON.stringify([[['ogiZ0b', JSON.stringify([null, Array.from({length:count},()=>item)]), null, 'generic']]]), at: 'NOT_A_REAL_TOKEN' }).toString();
}
function response(id = 'fixture-media-1', count = 1, host = 'flow-content.google') {
  const record = []; record[1] = 123; record[13] = `https://${host}/image/${id}?fixture=1`;
  const item = [id, null, null, null, null, null, [record, null, [1280, 720]]];
  const payload = [Array.from({length:count},()=>item)];
  return ")]}'\n\n1\n" + JSON.stringify([['wrb.fr', 'ogiZ0b', JSON.stringify(payload), null, null, null, 'generic']]) + '\n';
}
function failure(code) { return ")]}'\n\n1\n" + JSON.stringify([['wrb.fr','ogiZ0b',null,null,null,[code],'generic']]) + '\n'; }
module.exports = { request, response, failure, rpcUrl };
