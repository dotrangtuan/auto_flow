// ============================================================
//  Flow Batch — sidepanel.js
//  Fixed groups: submit up to 10, finish/retry the entire group, then advance.
// ============================================================

const $ = (id) => document.getElementById(id);
const els = {
  prompts: $("prompts"),
  count: $("count"),
  firstPrompt: $("firstPrompt"),
  loadTxt: $("loadTxt"),
  txtFile: $("txtFile"),
  folder: $("folder"),
  serial: $("serial"),
  concurrency: $("concurrency"),
  delayMin: $("delayMin"),
  delayMax: $("delayMax"),
  start: $("start"),
  stop: $("stop"),
  rescan: $("rescan"),
  queue: $("queue"),
  progress: $("progress"),
  pfill: $("pfill"),
  conn: $("conn"),
  connText: $("connText"),
};

let running = false;
let currentRun = null;
let items = []; // [{prompt, status}]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Lưu / khôi phục cài đặt ----------
function saveSettings() {
  chrome.storage.local.set({
    prompts: els.prompts.value,
    folder: els.folder.value,
    serial: els.serial.checked,
    batchSize: els.concurrency.value,
    delayMin: els.delayMin.value,
    delayMax: els.delayMax.value,
  });
}
async function loadSettings() {
  const s = await chrome.storage.local.get();
  if (s.prompts != null) els.prompts.value = s.prompts;
  if (s.folder) els.folder.value = s.folder;
  if (s.serial != null) els.serial.checked = s.serial;
  if (s.delayMin != null) els.delayMin.value = s.delayMin;
  if (s.delayMax != null) els.delayMax.value = s.delayMax;
  els.concurrency.value = String(Math.min(10, Math.max(1, Number(s.batchSize) || 10)));
  refreshCount();
}

// ---------- Đếm prompt ----------
function parsePrompts() {
  return els.prompts.value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}
function refreshCount() {
  els.count.textContent = `${parsePrompts().length} prompt`;
}

// ---------- Tìm tab Google Flow ----------
function isFlowProject(rawUrl) {
  return !!FlowProtocol.projectKey(rawUrl);
}
async function getFlowTab() {
  const tabs = await chrome.tabs.query({ url: ['https://flow.google.com/*', 'https://flow.google/*', 'https://labs.google/fx/*'] });
  const projects = tabs.filter(t => isFlowProject(t.url || ''));
  const active = await chrome.tabs.query({ active: true, currentWindow: true });
  const selected = projects.find(t => active.some(a => a.id === t.id));
  if (selected) return selected;
  if (projects.length === 1) return projects[0];
  if (projects.length > 1) throw new Error('Đang mở nhiều project Flow. Chọn tab project muốn chạy rồi bấm Bắt đầu.');
  return null;
}

// ---------- Gửi tin nhắn tới content script ----------
function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
}

// gửi cho background (nơi điều khiển chrome.debugger)
function sendToBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
}

// ---------- Kiểm tra kết nối ----------
async function checkConnection() {
  let tab;
  try { tab = await getFlowTab(); }
  catch (e) { setConn(false, e.message); return null; }
  if (!tab) return setConn(false, "Hãy mở project trên flow.google.com hoặc labs.google rồi bấm Bắt đầu");

  // thử ping
  let resp = await sendToTab(tab.id, { type: "PING" });

  // không thấy content script -> tự tiêm lại rồi ping lần nữa (tự chữa)
  if (!resp) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      await new Promise((r) => setTimeout(r, 400));
      resp = await sendToTab(tab.id, { type: "PING" });
    } catch (e) {
      console.warn("[auto_flow] Không tiêm được content script:", e);
    }
  }

  if (!resp?.ok) return setConn(false, "Không kết nối được. Tải lại extension, cho phép truy cập Flow và F5 trang rồi thử lại.");
  if (resp.protocol !== 4) return setConn(false, 'Trang Flow còn mã cũ. Tải lại extension và F5 Flow trước khi chạy nhóm.');
  // PING ok => coi như đã kết nối (lúc chạy bot sẽ focus để ô prompt hiện ra)
  if (resp.hasInput) setConn(true, "Đã kết nối với Google Flow");
  else setConn(true, "Đã kết nối (ô prompt sẽ nhận diện khi chạy)");
  return tab;
}
function setConn(on, text) {
  els.conn.className = "conn " + (on ? "conn--on" : "conn--off");
  els.connText.textContent = text;
}

// ---------- Vẽ hàng đợi ----------
function renderQueue() {
  els.queue.innerHTML = "";
  items.forEach((it) => {
    const li = document.createElement("li");
    li.className = "qitem " + it.status;
    li.innerHTML = `
      <span class="num">${it.serial}</span>
      <span class="txt">${escapeHtml(it.prompt)}</span>
      <span class="tag ${it.status}">${statusLabel(it.status)}${it.attempts > 1 ? " · lần " + it.attempts : ""}</span>`;
    li.title = it.error || it.filename || it.prompt;
    if (it.error || it.filename || it.status === "retry_wait" || (['submitting', 'generating'].includes(it.status) && it.note)) {
      const detail = document.createElement('small');
      detail.className = 'qdetail';
      detail.textContent = it.status === 'retry_wait'
        ? `Lỗi tạo ảnh: ${it.error || 'Flow báo thất bại'}. Thử lại sau ít nhất ${Math.max(0, Math.ceil((it.retryAt - Date.now()) / 1000))} giây; giữ nguyên nhóm này.`
        : (it.error || (it.filename ? it.filename.split(/[\\/]/).pop() : it.note || ''));
      li.appendChild(detail);
    }
    els.queue.appendChild(li);
  });
  const done = items.filter((i) => i.status === "done").length;
  const finished = items.filter((i) =>
    ["done", "error", "timeout"].includes(i.status)
  ).length;
  const q = currentRun?.queue;
  els.progress.textContent = !items.length ? '—' : q
    ? `Nhóm ${q.groupNumber}/${q.groupCount} · ${q.group.filter(i => i.generated).length}/${q.group.length} ảnh · ${done}/${items.length} đã tải`
    : `${done}/${items.length} đã tải`;
  if (els.pfill) {
    els.pfill.style.width = items.length
      ? Math.round((finished / items.length) * 100) + "%"
      : "0%";
  }
}
function statusLabel(s) {
  return {
    pending: "Chờ nhóm",
    retry_wait: "Chờ thử lại",
    submitting: "Đang gửi",
    generating: "Đang tạo",
    downloading: "Đang tải",
    uncertain: "Cần kiểm tra",
    done: "Xong",
    error: "Lỗi",
    timeout: "Quá giờ",
  }[s] || s;
}
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

// ---------- Tên file ----------
function safeName(s) {
  return s
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 50)
    .replace(/[-. ]+$/, "")
    .replace(/^\.+/, "");
}
function buildFilename(serial, prompt) {
  const folder = safeName(els.folder.value || "auto_flow") || "auto_flow";
  const snippet = safeName(prompt) || "image";
  const num = els.serial.checked ? String(serial).padStart(3, "0") + "_" : "";
  return `${folder}/${num}${snippet}.png`;
}

// ---------- Tải ảnh ----------
async function downloadImage(src, serial, prompt, tabId) {
  let url = src;
  // blob: thì nhờ content script đổi sang dataURL
  if (!/^https?:/i.test(src)) {
    const r = await sendToTab(tabId, { type: "TODATAURL", src });
    if (r && r.dataUrl) url = r.dataUrl;
    else throw new Error("Không tải được ảnh blob");
  }
  const started = await sendToBg({ type: 'DOWNLOAD_IMAGE', url,
    filename: buildFilename(serial, prompt) });
  if (!started?.ok) throw new Error(started?.error || 'Không khởi tạo được lượt tải ảnh.');
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const result = await sendToBg({ type: 'DOWNLOAD_STATUS', downloadId: started.downloadId });
    if (!result?.ok) throw new Error(result?.error || 'Không kiểm tra được file tải về.');
    if (result.state === 'complete') return result.filename;
    await sleep(500);
  }
  throw new Error('Tải ảnh quá 2 phút. Kiểm tra Downloads; tool không tự tải lại để tránh trùng file.');
}

// ---------- Delay ngẫu nhiên ----------
function randDelay() {
  const a = Math.max(0, parseInt(els.delayMin.value) || 0);
  const b = Math.max(a, parseInt(els.delayMax.value) || 0);
  return (a + Math.random() * (b - a)) * 1000;
}

// ---------- Fixed groups with a completion barrier and unlimited confirmed-failure retries ----------
function lockSettings(locked) {
  [els.firstPrompt, els.prompts, els.folder, els.serial, els.concurrency, els.delayMin, els.delayMax, els.loadTxt, els.txtFile].forEach(e => e.disabled = locked);
  els.start.disabled = locked;
  els.stop.disabled = !locked;
  els.rescan.disabled = !locked;
}
async function run() {
  if (running) return;
  running = true; lockSettings(true);
  const downloads = new Set();
  let ctx;
  try {
    const tab = await checkConnection();
    if (!tab || !running) return;
    const list = parsePrompts();
    if (!list.length) throw new Error('Chưa có prompt nào.');
    const start = Number(els.firstPrompt.value || 1);
    if (!Number.isInteger(start) || start < 1 || start > list.length) {
      throw new Error(`Chọn số prompt bắt đầu từ 1 đến ${list.length} trong danh sách đầy đủ.`);
    }
    ctx = { offset: start - 1, tabId: tab.id, batchId: crypto.randomUUID(), queue: new FlowQueue(list.slice(start - 1), els.concurrency.value) };
    currentRun = ctx;
    items = ctx.queue.items;
    for (const item of items) item.serial = start + item.id;
    renderQueue();
    const begun = await sendToTab(tab.id, { type: 'BATCH_START', batchId: ctx.batchId, network: true });
    if (!begun?.ok) throw new Error(begun?.error || 'Không khởi tạo được hàng đợi. Hãy F5 trang Flow.');
    if (!running) return;
    const bg = await sendToBg({ type: 'DEBUG_START', batchId: ctx.batchId, tabId: tab.id });
    if (!bg?.ok) throw new Error(bg?.error || 'Không khởi tạo được bộ gửi.');
    let nextSendAt = 0;
    while (running && !ctx.queue.complete) {
      const poll = await sendToBg({ type: 'DEBUG_POLL', batchId: ctx.batchId });
      if (!poll?.ok) throw new Error(poll?.error || 'Mất kết nối với Flow. Dừng gửi thêm.');
      for (const wait of poll.waiting || []) {
        const item = items[wait.id - ctx.offset];
        if (item && item.attempts === wait.attempt && item.status === 'generating') item.note = wait.reason;
      }
      for (const result of poll.results) {
        const item = items[result.id - ctx.offset];
        if (!item || result.attempt !== item.attempts || !['submitting', 'generating'].includes(item.status)) continue;
        if (result.status === 'uncertain') {
          ctx.queue.uncertain(item.id); item.error = result.error;
          setConn(false, result.error); continue;
        }
        if (result.status === 'error') {
          ctx.queue.finish(item.id, 'error'); item.error = result.error; continue;
        }
        if (result.status === 'done' && result.src && ctx.queue.finish(item.id, 'downloading')) {
          // Generation succeeds once. A download failure must never regenerate this image.
          const task = downloadImage(result.src, item.serial, item.prompt, tab.id)
            .then(filename => { item.status = 'done'; item.filename = filename; })
            .catch(e => { item.status = 'error'; item.error = 'Ảnh đã tạo nhưng tải lỗi: ' + e.message; })
            .finally(() => { downloads.delete(task); renderQueue(); });
          downloads.add(task);
        }
      }
      renderQueue();
      if (poll.fatal) {
        ctx.queue.stop();
        setConn(false, poll.fatal);
      }
      if (!running) break;
      if (ctx.queue.halted) {
        // Keep listening for other requests already sent before the first failure.
        if (!(poll.waiting || []).some(job => job.bound)) break;
        await sleep(250);
        continue;
      }
      const item = Date.now() >= nextSendAt ? ctx.queue.reserve() : null;
      if (!item) { await sleep(250); continue; }
      renderQueue();
      const box = await sendToTab(tab.id, { type: 'PREPARE_JOB', batchId: ctx.batchId, id: item.serial - 1, attempt: item.attempts, prompt: item.prompt });
      if (!running) break;
      if (!box?.ok) {
        item.status = 'error'; item.error = box?.error || 'Không tìm thấy ô prompt.';
        throw new Error(item.error);
      }
      const typed = await sendToBg({ type: 'DEBUG_SUBMIT', batchId: ctx.batchId, tabId: tab.id, id: item.serial - 1, attempt: item.attempts, x: box.x, y: box.y, prompt: item.prompt });
      if (!running) break;
      if (!typed?.ok) {
        const state = await sendToBg({ type: 'DEBUG_POLL', batchId: ctx.batchId });
        if (state?.fatal) continue;
        ctx.queue.uncertain(item.id);
        throw new Error(typed?.error || 'Không xác nhận được thao tác gửi. Kiểm tra Flow và đóng DevTools F12.');
      }
      item.note = 'Đã thao tác gửi. Đang chờ Flow phát yêu cầu tạo ảnh (tối đa 100 giây).';
      renderQueue();
      const accepted = await sendToBg({ type: 'DEBUG_CONFIRM', batchId: ctx.batchId, id: item.serial - 1, attempt: item.attempts });
      if (!running) break;
      if (!accepted?.ok) {
        const state = await sendToBg({ type: 'DEBUG_POLL', batchId: ctx.batchId });
        if (state?.fatal) continue;
        ctx.queue.uncertain(item.id);
        throw new Error(accepted?.error || 'Không xác nhận được Flow đã nhận prompt.');
      }
      ctx.queue.accepted(item.id);
      nextSendAt = Date.now() + randDelay();
      renderQueue();
    }
    if (ctx.queue.complete) setConn(true, 'Đã tạo hết ảnh. Đang kiểm tra các file tải về…');
  } catch (e) {
    if (ctx) { ctx.queue.stop(); ctx.queue.active.forEach(i => { i.status = 'uncertain'; i.error ||= e.message; }); }
    setConn(false, e.message);
  } finally {
    if (ctx) {
      await sendToBg({ type: 'DEBUG_STOP', batchId: ctx.batchId });
      await sendToTab(ctx.tabId, { type: 'STOP', batchId: ctx.batchId });
      ctx.queue.active.forEach(i => { i.status = 'uncertain'; });
    }
    await Promise.allSettled([...downloads]);
    if (ctx?.queue.complete && !ctx.queue.halted) {
      const errors = items.filter(i => i.status === 'error').length;
      setConn(!errors, errors ? `Có ${errors} mục lỗi. Xem chi tiết ở hàng đợi bên dưới.` : 'Đã tải xong và kiểm tra tên các file.');
    }
    running = false; currentRun = null; lockSettings(false); renderQueue();
  }
}
async function stop() {
  running = false;
  els.stop.disabled = true;
  const ctx = currentRun;
  if (ctx) {
    ctx.queue.stop();
    await sendToBg({ type: 'DEBUG_STOP', batchId: ctx.batchId });
    await sendToTab(ctx.tabId, { type: 'STOP', batchId: ctx.batchId });
  }
  setConn(false, 'Đã dừng gửi. Tác vụ đã gửi vẫn có thể chạy trên Flow; đợi xong trước khi chạy lại.');
}

// ---------- Sự kiện ----------
els.prompts.addEventListener("input", () => {
  els.firstPrompt.value = "1";
  refreshCount();
  saveSettings();
});
[els.folder, els.serial, els.concurrency, els.delayMin, els.delayMax].forEach((el) =>
  el.addEventListener("change", saveSettings)
);
els.loadTxt.addEventListener("click", () => els.txtFile.click());
els.txtFile.addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    els.prompts.value = reader.result;
    els.firstPrompt.value = "1";
    refreshCount();
    saveSettings();
  };
  reader.readAsText(f);
});
els.start.addEventListener("click", run);
els.stop.addEventListener("click", stop);
els.rescan.addEventListener('click', async () => {
  const ctx = currentRun;
  if (!running || !ctx) return;
  els.rescan.disabled = true;
  const result = await sendToBg({ type: 'DEBUG_POLL', batchId: ctx.batchId });
  if (!result?.ok) setConn(false, result?.error || 'Không kiểm tra được phản hồi Flow.');
  // The existing queue loop consumes results exactly once and starts downloads.
  els.rescan.disabled = !running;
});

// ---------- Khởi động ----------
loadSettings();
checkConnection();
// Do not overwrite actionable queue errors with periodic connection pings.
// checkConnection runs on load and before each batch.
// // tự kiểm tra kết nối mỗi 5s
