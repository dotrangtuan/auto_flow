/* SPDX-License-Identifier: AGPL-3.0-only
 * Observe Flow's own requests using CDP. No Fetch interception or request replay.
 */
let rpcCapture = null;
async function startRpcCapture(msg, command) {
  const tab = await chrome.tabs.get(msg.tabId);
  const project = FlowProtocol.projectKey(tab.url);
  if (!project) throw new Error('Hãy mở trang tạo ảnh trong một project Flow.');
  const cap = { id: msg.batchId, tabId: msg.tabId, project, active: true,
    tracker: new FlowRpcTracker(FlowProtocol), requests: new Map(), command };
  rpcCapture = cap;
  try {
    try {
      await command(msg.tabId, 'Network.enable', {
        maxTotalBufferSize: 16 * 1024 * 1024,
        maxResourceBufferSize: 5 * 1024 * 1024,
        maxPostDataSize: 1024 * 1024,
      });
    } catch (error) {
      // Some Chromium variants reject optional buffer parameters. Only retry that case.
      if (!/invalid parameters|invalid params|unknown parameter|-32602/i.test(String(error?.message || ''))) throw error;
      await command(msg.tabId, 'Network.enable', {});
    }
  } catch (error) {
    error.startupStage = 'network-enable';
    throw error;
  }
  return cap;
}
function requireRpcCapture(id) {
  if (!rpcCapture || rpcCapture.id !== id || !rpcCapture.active) throw new Error('Phiên theo dõi đã dừng.');
  return rpcCapture;
}
async function verifyRpcProject(cap) {
  if (cap !== rpcCapture || !cap.active) throw new Error('Phiên đã dừng.');
  const tab = await chrome.tabs.get(cap.tabId);
  if (FlowProtocol.projectKey(tab.url) !== cap.project) {
    cap.tracker.failAll('Trang Flow đã đổi project hoặc collection. Dừng hàng đợi và mở lại đúng trang.');
    throw new Error(cap.tracker.fatal);
  }
}
function haltRpcCapture(reason) {
  if (rpcCapture?.active) rpcCapture.tracker.failAll(reason);
}
function stopRpcCapture(id) {
  if (rpcCapture?.id === id) {
    rpcCapture.active = false;
    rpcCapture.requests.clear();
  }
}
// Chrome can deliver a complete image-result frame before a transfer is canceled.
const MAX_RPC_BYTES = 4 * 1024 * 1024;
function addResponseChunk(stream, encoded, prefix = false) {
  if (!encoded || !stream.valid) return;
  // Check the size before decoding and retain only bytes from this image RPC.
  if (encoded.length > 4 * Math.ceil((MAX_RPC_BYTES - stream.bytes) / 3)) {
    stream.valid = false;
  } else {
    try {
      const binary = atob(encoded);
      stream.bytes += binary.length;
      if (stream.bytes <= MAX_RPC_BYTES && stream.chunks.length < 8192) {
        if (prefix) stream.chunks.unshift(binary);
        else stream.chunks.push(binary);
        return;
      }
    } catch (_) { /* Ignore an unusable buffer and fall back to getResponseBody. */ }
    stream.valid = false;
  }
  stream.chunks.length = 0;
}
function decodeBody(response) {
  return response.base64Encoded
    ? new TextDecoder().decode(Uint8Array.from(atob(response.body), c => c.charCodeAt(0))) : response.body;
}
async function handleRpcNetwork(source, method, params) {
  const cap = rpcCapture;
  if (!cap?.active || source.tabId !== cap.tabId || source.sessionId) return;
  const live = () => cap === rpcCapture && cap.active;
  if (method === 'Network.requestWillBeSent') {
    if (params.type === 'Document') {
      // A reload or navigation destroys the document owning in-flight requests.
      cap.tracker.failAll('Trang Flow vừa tải lại hoặc chuyển trang. Dừng gửi; kiểm tra tác vụ trước khi chạy mới.');
      return;
    }
    const request = params.request;
    if (request?.method !== 'POST' || !FlowProtocol.imageRpc(request.url)) return;
    if (cap.requests.has(params.requestId)) {
      cap.tracker.failAll('Request tạo ảnh bị chuyển hướng hoặc lặp ID. Kiểm tra Flow trước khi chạy tiếp.');
      return;
    }
    const rec = { job: null, status: 0, ready: null };
    cap.requests.set(params.requestId, rec);
    rec.ready = (async () => {
      let body = request.postData;
      if (typeof body !== 'string') {
        try { body = (await cap.command(cap.tabId, 'Network.getRequestPostData', { requestId: params.requestId })).postData; }
        catch (_) { body = null; }
      }
      if (!live()) return;
      rec.job = cap.tracker.bind(params.requestId, typeof body === 'string' && body.length <= 1024 * 1024 ? body : null);
      // Do not retain body, headers, cookies, authentication fields, or raw events.
    })();
    await rec.ready;
    return;
  }
  const rec = cap.requests.get(params.requestId);
  if (!rec) return;
  if (method === 'Network.responseReceived') {
    rec.status = params.response?.status || 0;
    if (rec.status === 200 && !rec.stream) {
      const stream = rec.stream = { valid: true, bytes: 0, chunks: [] };
      stream.ready = cap.command(cap.tabId, 'Network.streamResourceContent', { requestId: params.requestId })
        .then(result => addResponseChunk(stream, result.bufferedData, true))
        .catch(() => { stream.valid = false; stream.chunks.length = 0; });
    }
    return;
  }
  if (method === 'Network.dataReceived') {
    if (rec.stream) addResponseChunk(rec.stream, params.data);
    return;
  }
  if (!['Network.loadingFinished', 'Network.loadingFailed'].includes(method)) return;
  await rec.ready;
  if (!live()) return;
  try {
    if (!rec.job) return;
    const interrupted = method === 'Network.loadingFailed';
    if (interrupted && rec.status !== 200) { cap.tracker.failed(params.requestId, params, rec.status); return; }
    if (rec.status !== 200) { cap.tracker.response(params.requestId, rec.status, ''); return; }
    if (params.encodedDataLength > 5 * 1024 * 1024) {
      cap.tracker.uncertain(rec.job, 'Phản hồi Flow vượt giới hạn đọc. Kiểm tra ảnh trên Flow; không tự gửi lại.');
      return;
    }
    let body;
    try {
      body = decodeBody(await cap.command(cap.tabId, 'Network.getResponseBody', { requestId: params.requestId }));
    } catch (_) { /* A canceled request may only have streamed data. */ }
    if (!live()) return;
    if (!interrupted && body) {
      cap.tracker.response(params.requestId, rec.status, body);
      return;
    }
    // On a transport failure, only a validated success frame is conclusive.
    if (rec.stream) await rec.stream.ready;
    if (!live()) return;
    let buffered;
    if (rec.stream?.valid && rec.stream.bytes) {
      const bytes = Uint8Array.from(rec.stream.chunks.join(''), c => c.charCodeAt(0));
      buffered = new TextDecoder().decode(bytes);
    }
    for (const candidate of [body, buffered]) {
      if (!candidate) continue;
      try { FlowProtocol.imageResult(candidate); } catch (_) { continue; }
      cap.tracker.response(params.requestId, rec.status, candidate);
      return;
    }
    if (interrupted) cap.tracker.failed(params.requestId, params, rec.status);
    else if (buffered) cap.tracker.response(params.requestId, rec.status, buffered);
    else cap.tracker.uncertain(rec.job, 'Không đọc được phản hồi từ trình duyệt. Kiểm tra ảnh trên Flow.');
  } finally { cap.requests.delete(params.requestId); }
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  handleRpcNetwork(source, method, params).catch(() => haltRpcCapture('Mất dấu phản hồi Flow. Dừng gửi để tránh nhầm ảnh.'));
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  const cap = rpcCapture;
  if (!cap?.active || tabId !== cap.tabId) return;
  if (change.status === 'loading' || (change.url && FlowProtocol.projectKey(change.url) !== cap.project)) {
    cap.tracker.failAll('Tab Flow vừa tải lại hoặc đổi project/collection. Kiểm tra các ảnh đã gửi trước khi chạy mới.');
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (rpcCapture?.active && rpcCapture.tabId === tabId) haltRpcCapture('Tab Flow đã đóng.');
});
