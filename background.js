importScripts("downloads.js", "flow-protocol.js", "rpc-tracker.js", "worker-network.js");

// ============================================================
//  auto_flow — background service worker
//  Dùng chrome.debugger để GÕ CHỮ THẬT vào ô prompt (Slate),
//  Slate chỉ nhận sự kiện thật nên phải đi đường này.
// ============================================================

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn("[auto_flow] setPanelBehavior:", e));
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let attachedTab = null;
let session = null;
let sending = false;
let inFlight = null;
function assertSession(id) {
  if (!session || session.id !== id || session.stopped) throw new Error("Hàng đợi đã dừng.");
}

// v1.3.1: preserve the actual failed startup step. Do not diagnose every failure as F12.
function startupFailure(error, stage) {
  const raw = String(error?.message || error || 'Unknown browser error');
  const detail = raw.replace(/https?:\/\/[^\s"<>]+/g, '[URL]')
    .replace(/\b(cookie|authorization|token|signature|at)\s*[:=]\s*[^\s,;]+/gi, '$1=[hidden]')
    .replace(/[\r\n]+/g, ' ').slice(0, 240);
  let hint;
  if (/another debugger|already attached|devtools/i.test(raw)) {
    hint = 'Tab Flow đang có bộ gỡ lỗi khác. Đóng DevTools và tắt tiện ích Flow khác đang chạy.';
  } else if (/policy|restricted|not allowed|permission|denied/i.test(raw)) {
    hint = 'Trình duyệt đang chặn quyền gỡ lỗi. Kiểm tra quyền tiện ích và chính sách của trình duyệt.';
  } else if (/no tab|no target|closed|cannot access|invalid tab/i.test(raw)) {
    hint = 'Tab Flow đã đóng hoặc không truy cập được. Mở lại đúng tab project rồi thử lại.';
  } else if (stage === 'read-project') {
    hint = 'Hãy mở màn hình nhập prompt trong project Flow, rồi F5 trang.';
  } else if (stage === 'network-enable') {
    hint = 'Đã kết nối bộ gỡ lỗi nhưng chưa bật được theo dõi mạng.';
  } else {
    hint = 'Không khởi động được bộ theo dõi Flow.';
  }
  return { ok: false, stage, detail, error: `${hint} [${stage}] ${detail}` };
}

// Nếu người dùng bấm Hủy thanh vàng -> debugger tự tách -> reset trạng thái
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === attachedTab) {
    console.warn("[auto_flow] debugger bị tách khỏi tab", source.tabId);
    attachedTab = null;
    haltRpcCapture('Bộ theo dõi bị ngắt (DevTools hoặc thanh gỡ lỗi đã đóng). Kiểm tra Flow; không tự gửi lại.');
  }
});

function sendCmd(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

async function ensureAttached(tabId) {
  if (attachedTab === tabId) return;
  if (attachedTab !== null) {
    try {
      await chrome.debugger.detach({ tabId: attachedTab });
    } catch (_) {}
    attachedTab = null;
  }
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
  attachedTab = tabId;
}

async function detach() {
  if (attachedTab !== null) {
    try {
      await chrome.debugger.detach({ tabId: attachedTab });
    } catch (_) {}
    attachedTab = null;
  }
}

// Probe the Flow composer immediately before choosing one submit gesture.
function locateFlowSubmit() {
  const editor = document.activeElement;
  const buttons = [...document.querySelectorAll('button.generate-icon-button[type="submit"]')];
  if (!buttons.length && !document.querySelector('flow-generate-icon-button, div.ProseMirror')) return { legacy: true };
  const form = editor?.closest('form');
  const visible = buttons.filter(b => (!form || form.contains(b)) && b.getClientRects().length);
  if (visible.length !== 1) return { error: 'Không xác định được một nút gửi trong ô Flow.' };
  const button = visible[0];
  if (button.disabled || button.getAttribute('aria-disabled') === 'true') return { busy: true };
  if (![...button.querySelectorAll("mat-icon, i, [class*='symbols']")].some(i => i.textContent.trim() === 'arrow_forward')) {
    return { error: 'Nút tạo ảnh trên Flow chưa hiện mũi tên gửi.' };
  }
  const rect = button.getBoundingClientRect();
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  if (!button.contains(document.elementFromPoint(x, y))) return { error: 'Nút gửi trên Flow đang bị che.' };
  return { x, y };
}

// Gõ prompt + Enter bằng input THẬT qua CDP
async function debugTypeAndSubmit(tabId, x, y, prompt, batchId) {
  assertSession(batchId);
  if (session.tabId !== tabId) throw new Error("Sai tab Flow.");
  const cmd = async (method, params) => { assertSession(batchId); return sendCmd(tabId, method, params); };
  await ensureAttached(tabId);
  assertSession(batchId);
  const cap = requireRpcCapture(batchId);
  await verifyRpcProject(cap);
  if (cap.tracker.fatal) throw new Error(cap.tracker.fatal);

  // 1) click vào ô để đặt con trỏ (focus thật)
  await cmd( "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 1,
  });
  await cmd( "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 1,
  });
  await wait(180);

  // 2) chọn hết (Ctrl+A) để xoá nội dung cũ nếu có
  await cmd( "Input.dispatchKeyEvent", {
    type: "keyDown", modifiers: session.modifiers || 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65,
  });
  await cmd( "Input.dispatchKeyEvent", {
    type: "keyUp", modifiers: session.modifiers || 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65,
  });
  await wait(60);

  // 3) Insert text through the debugger input channel.
  await cmd( "Input.insertText", { text: prompt });
  await wait(250);

  let target;
  const readyUntil = Date.now() + 5000;
  do {
    const probe = await cmd('Runtime.evaluate', {returnByValue: true, expression: `(${locateFlowSubmit.toString()})()`});
    target = probe?.result?.value;
    if (!target?.busy) break;
    await wait(200);
  } while (Date.now() < readyUntil);
  if (!target?.legacy && !(Number.isFinite(target?.x) && Number.isFinite(target?.y))) {
    throw new Error((target?.error || 'Nút gửi trên Flow chưa sẵn sàng.') + ' Chưa bấm gửi.');
  }

  // Read back the focused editor; never submit if Flow ignored the inserted text.
  const readBack = await cmd('Runtime.evaluate', { returnByValue: true,
    expression: `(() => { const el = document.activeElement;
      if (!el || !(el.matches('textarea, input') || el.isContentEditable)) return null;
      const spans = el.querySelectorAll('[data-slate-string]');
      return spans.length ? [...spans].map(n => n.textContent).join('')
        : el.matches('textarea, input') ? el.value : el.innerText || el.textContent || ''; })()` });
  if (FlowProtocol.normalize(readBack?.result?.value) !== FlowProtocol.normalize(prompt)) {
    throw new Error('Ô prompt không nhận đúng nội dung. Chưa nhấn gửi; kiểm tra giao diện Flow.');
  }

  // 4) Enter để gửi (key thật)
  await verifyRpcProject(cap);
  assertSession(batchId);
  if (cap.tracker.fatal) throw new Error(cap.tracker.fatal);
  if (!target.legacy) {
    const point = { x: target.x, y: target.y, button: 'left', clickCount: 1 };
    await cmd('Input.dispatchMouseEvent', { ...point, type: 'mousePressed' });
    await cmd('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased' });
    return;
  }
  await cmd( "Input.dispatchKeyEvent", {
    type: "rawKeyDown", key: "Enter", code: "Enter",
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await cmd( "Input.dispatchKeyEvent", {
    type: "keyUp", key: "Enter", code: "Enter",
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'DEBUG_START') {
    if (sending || (session && !session.stopped)) {
      sendResponse({ ok: false, error: 'Một hàng đợi khác đang hoạt động.' });
    } else {
      session = { id: msg.batchId, tabId: msg.tabId, stopped: false };
      (async () => {
        let stage = 'attach-debugger';
        try {
          await ensureAttached(msg.tabId);
          assertSession(msg.batchId);
          // Platform detection is optional. Its failure must not block Network capture.
          let os = '';
          try { os = (await chrome.runtime.getPlatformInfo())?.os || ''; } catch (_) {}
          session.modifiers = os === 'mac' || /Mac/i.test(globalThis.navigator?.platform || '') ? 4 : 2;
          stage = 'read-project';
          await startRpcCapture(msg, sendCmd);
          assertSession(msg.batchId);
          sendResponse({ ok: true, capture: 'network', protocol: 4 });
        } catch (error) {
          if (session?.id === msg.batchId) session.stopped = true;
          stopRpcCapture(msg.batchId);
          await detach();
          sendResponse(startupFailure(error, error?.startupStage || stage));
        }
      })();
    }
    return true;
  }
  if (msg.type === 'DEBUG_SUBMIT') {
    if (sending) { sendResponse({ ok: false, error: 'Bộ gửi đang bận.' }); return; }
    try {
      assertSession(msg.batchId);
      if (session.tabId !== msg.tabId) throw new Error('Sai tab Flow.');
      requireRpcCapture(msg.batchId).tracker.arm(msg.id, msg.attempt ?? 1, msg.prompt);
    } catch (e) { sendResponse({ ok: false, error: e.message }); return; }
    sending = true;
    inFlight = debugTypeAndSubmit(msg.tabId, msg.x, msg.y, msg.prompt, msg.batchId)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e.message || e) }))
      .finally(() => { sending = false; inFlight = null; });
    return true;
  }
  if (msg.type === 'DEBUG_POLL' || msg.type === 'DEBUG_CONFIRM') {
    (async () => {
      try {
        assertSession(msg.batchId);
        const cap = requireRpcCapture(msg.batchId);
        if (msg.type === 'DEBUG_POLL') {
          try { await verifyRpcProject(cap); } catch (_) { /* Return already-known images even after navigation. */ }
          const state = cap.tracker.poll();
          sendResponse(state);
          return;
        }
        const job = cap.tracker.jobs.get(cap.tracker.key(msg.id, msg.attempt ?? 1));
        if (!job) throw new Error('Không tìm thấy tác vụ theo dõi.');
        while (true) {
          assertSession(msg.batchId);
          cap.tracker.checkDeadline(job);
          if (cap.tracker.fatal) throw new Error(cap.tracker.fatal);
          if (job.requestId) { sendResponse({ ok: true, capture: 'network' }); return; }
          await wait(150);
        }
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (msg.type === 'DEBUG_STOP') {
    if (session?.id !== msg.batchId) { sendResponse({ ok: true }); return; }
    session.stopped = true;
    stopRpcCapture(msg.batchId);
    (async () => {
      // Let any already-dispatched input finish before detaching. Every next
      // input command checks the cancellation token, particularly Enter.
      if (inFlight) await inFlight;
      await detach();
      sendResponse({ ok: true });
    })();
    return true;
  }
});
