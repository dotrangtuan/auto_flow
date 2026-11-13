// v1.3: input discovery plus legacy tracker; the panel uses worker network results.
(() => {
if (window.__H2DEV_FLOW_LISTENER__) return;
window.__H2DEV_FLOW_LISTENER__ = true;
const CONFIG = {
  // Optional exact selector for ONE generation card after a Flow UI change.
  resultCardSelector: "",
  // Để trống ("") thì tool TỰ DÒ. Nếu tự dò sai, điền selector vào đây.
  promptSelector: "",        // vd: 'textarea[placeholder*="create"]'
  // Ảnh kết quả thường to; bỏ qua icon/avatar nhỏ hơn ngưỡng này (pixel)
  minImageSize: 256,

  // Maximum time before an unresolved task halts further dispatch
  maxWaitMs: 600000,         // 10 minutes; timeout never frees a slot

  // Chờ thêm sau khi thấy ảnh mới, để ảnh load đầy đủ trước khi tải
  settleMs: 1800,
};

let STOP = false;

// ---------- Tiện ích nhỏ ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const s = getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
}

function area(el) {
  const r = el.getBoundingClientRect();
  return r.width * r.height;
}

function srcKey(img) {
  return img.currentSrc || img.src || "";
}

// ---------- 1. Tìm ô nhập prompt ----------
// kiểm tra "đang hiện" kiểu lỏng hơn (Slate khi trống vẫn có client rect)
function isShown(el) {
  if (!el) return false;
  if (isVisible(el)) return true;
  return el.getClientRects().length > 0; // dự phòng
}

function findPromptInput() {
  if (CONFIG.promptSelector) {
    const e = document.querySelector(CONFIG.promptSelector);
    if (e) return e;
  }
  // Thử lần lượt các "địa chỉ" ổn định của ô prompt Flow (Slate.js)
  const selectors = [
    '[data-slate-editor="true"]',
    '[contenteditable="true"][role="textbox"]',
    '[role="textbox"][aria-multiline="true"]',
    'div[role="textbox"]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    "textarea",
  ];
  for (const sel of selectors) {
    const all = [...document.querySelectorAll(sel)];
    if (!all.length) continue;
    const shown = all.filter(isShown);
    const list = shown.length ? shown : all; // ưu tiên cái đang hiện, không thì lấy đại
    const hint = /create|prompt|imagine|describe|tạo|生成|描述|생성|作成/i;
    const byText = list.find((e) =>
      hint.test(
        (e.getAttribute("placeholder") || "") +
          (e.getAttribute("aria-label") || "") +
          (e.dataset?.placeholder || "")
      )
    );
    if (byText) return byText;
    list.sort((a, b) => area(b) - area(a));
    return list[0];
  }
  return null;
}

// Đánh thức ô prompt: Slate chỉ "mọc" editor khi vùng prompt được click.
// Hàm này click vào vùng prompt (cạnh trái nút mũi tên) để editor xuất hiện.
async function wakePromptBox() {
  let ed = findPromptInput();
  if (ed) {
    clickFully(ed);
    ed.focus?.();
    await sleep(150);
    return findPromptInput();
  }
  // editor chưa mount -> click vào vùng ô prompt cạnh nút arrow_forward
  const arrow = [...document.querySelectorAll('button, [role="button"]')].find(
    (b) => /arrow_forward/i.test((b.getAttribute("aria-label") || "") + b.textContent)
  );
  if (arrow) {
    const r = arrow.getBoundingClientRect();
    const points = [
      [r.left - 150, r.top + r.height / 2],
      [r.left - 300, r.top + r.height / 2],
      [r.left - 80, r.top + r.height / 2],
    ];
    for (const [x, y] of points) {
      const t = document.elementFromPoint(x, y);
      if (!t) continue;
      ["mousedown", "mouseup", "click"].forEach((type) =>
        t.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y,
          })
        )
      );
      t.focus?.();
      await sleep(250);
      ed = findPromptInput();
      if (ed) {
        console.log("[auto_flow] ✓ Đánh thức được ô prompt bằng cú click.");
        return ed;
      }
    }
  }
  return findPromptInput();
}

function inputText(el) {
  if (!el) return null;
  if (!el.isContentEditable) return el.value || "";
  const strings = el.querySelectorAll('[data-slate-string]');
  if (strings.length) return [...strings].map(n => n.textContent).join('');
  if (el.querySelector('[data-slate-placeholder]')) return '';
  return el.innerText || el.textContent || '';
}
function clickFully(el) { el.click(); }

// ---------- 7. Đổi ảnh sang dataURL (dùng cho blob:) ----------
async function toDataUrl(url) {
  const res = await fetch(url);
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

// Track each prompt separately. Never assign an arbitrary new image to a job.
const normalize = s => String(s || '').replace(/\s+/g, ' ').trim();
const BUSY = '[role="progressbar"], [aria-busy="true"], [data-state="loading"], [data-status="pending"], [data-status="generating"]';
const FAILED = '[data-status="failed"], [data-state="error"], [role="alert"]';
let batch = null;

function imageList(root = document) {
  // Bound cards can contain small preview thumbnails (e.g. 160x90).
  // Use the long edge for 16:9 images rather than requiring BOTH edges >=256.
  const edge = root === document ? CONFIG.minImageSize : 128;
  return [...root.querySelectorAll('img')].filter(img => img.complete &&
    Math.max(img.naturalWidth, img.naturalHeight) >= edge &&
    Math.min(img.naturalWidth, img.naturalHeight) >= 64 &&
    /^(https?:|blob:)/.test(srcKey(img)));
}
function freshImages(root, job) {
  // One asset may be mounted twice for hover/preview. Count unique sources.
  const unique = new Map();
  for (const img of imageList(root)) {
    const src = srcKey(img);
    if (!job.baseline.has(src) && !batch.claimed.has(src)) unique.set(src, img);
  }
  return [...unique.values()];
}
function isBusyMarker(node) {
  if (!isVisible(node)) return false;
  if (['complete', 'completed', 'success', 'succeeded', 'done'].includes(node.getAttribute('data-status') || node.getAttribute('data-state'))) return false;
  const value = node.getAttribute('aria-valuenow');
  const max = Number(node.getAttribute('aria-valuemax') || 100);
  if (value !== null && Number.isFinite(Number(value)) && max > 0 && Number(value) >= max) return false;
  const percent = normalize(node.textContent).match(/^(\d{1,3})\s*%$/);
  if (percent && Number(percent[1]) >= 100) return false;
  return true;
}
function busyMarkers() {
  const explicit = [...document.querySelectorAll(BUSY)];
  const percentages = [...document.querySelectorAll('span, div')].filter(n =>
    n.children.length === 0 && /^\s*\d{1,3}\s*%\s*$/.test(n.textContent));
  return [...new Set([...explicit, ...percentages])].filter(isBusyMarker);
}
const CARD_ID_ATTRS = ['data-generation-id', 'data-task-id'];
function cardIdentity(card) {
  for (const attr of CARD_ID_ATTRS) {
    const node = card.closest(`[${attr}]`);
    const value = node?.getAttribute(attr);
    if (value) return { attr, value };
  }
  return null;
}
function ownedByOther(card, job) {
  const identity = cardIdentity(card);
  return [...batch.jobs.values()].some(j => j !== job &&
    (j.card === card || (identity && j.identity?.attr === identity.attr && j.identity?.value === identity.value)));
}
function bindCard(job, card) {
  if (!card || ownedByOther(card, job)) return;
  job.card = card;
  job.identity = cardIdentity(card) || job.identity;
}
function recoverCard(job) {
  if (!job.identity) return null;
  const {attr, value} = job.identity;
  const matches = [...document.querySelectorAll(`[${attr}]`)].filter(n => n.getAttribute(attr) === value && !ownedByOther(n, job));
  return matches.length === 1 ? matches[0] : null;
}
function cardFor(marker) {
  if (CONFIG.resultCardSelector) return marker.closest(CONFIG.resultCardSelector);
  const named = marker.closest('[data-generation-id], [data-task-id], article');
  if (named && !named.querySelector('[contenteditable], textarea')) return named;
  for (let n = marker.parentElement; n && n !== document.body; n = n.parentElement) {
    if (n.querySelector('[contenteditable], textarea')) return null;
    const r = n.getBoundingClientRect();
    if (r.width >= 180 && r.height >= 100 && r.width <= 1000 &&
        n.querySelectorAll(BUSY).length <= 1) return n;
  }
  return null;
}
function promptIn(root, prompt) {
  const text = normalize(root.textContent);
  if (text.includes(prompt)) return true;
  return [root, ...root.querySelectorAll('[title], [aria-label], img[alt]')].some(n =>
    ['title', 'aria-label', 'alt'].some(a => normalize(n.getAttribute(a)).includes(prompt)));
}
function matchedCard(job) {
  const candidates = [];
  for (const marker of [...imageList(), ...busyMarkers(), ...document.querySelectorAll(FAILED)]) {
    for (let n = marker.parentElement; n && n !== document.body; n = n.parentElement) {
      if (n.querySelector('[contenteditable], textarea')) break;
      if (freshImages(n, job).length > 1) break; // Never guess between two different new assets.
      if ([...batch.jobs.values()].some(j => j !== job && j.card && n.contains(j.card))) break;
      if (promptIn(n, normalize(job.prompt))) {
        if ([...batch.jobs.values()].some(j => j !== job && !j.result && normalize(j.prompt) !== normalize(job.prompt) && promptIn(n, normalize(j.prompt)))) break;
        if (!ownedByOther(n, job)) candidates.push(n);
        break;
      }
    }
  }
  const unique = [...new Set(candidates)].filter(n => {
    const imgs = imageList(n);
    return !imgs.length || freshImages(n, job).length > 0;
  });
  return unique.length === 1 ? unique[0] : null;
}
function inspectJob(job) {
  if (job.result) return;
  // Recover the card by its generation/task ID if Flow has remounted it.
  const recovered = recoverCard(job);
  if (recovered) bindCard(job, recovered);
  if (!job.card?.isConnected) {
    const matched = matchedCard(job);
    if (matched) bindCard(job, matched);
  }
  let card = job.card;
  // A progress-only child may have been replaced while its task root survived.
  if (card?.isConnected && !imageList(card).length) {
    const matched = matchedCard(job);
    if (matched) { bindCard(job, matched); card = job.card; }
  }
  job.waitingReason = 'Chưa tìm lại được thẻ kết quả. Cuộn đến ảnh trong Flow rồi bấm Quét lại ảnh.';
  if (card?.isConnected) {
    for (const img of card.querySelectorAll('img')) {
      if (img.loading === 'lazy') img.loading = 'eager';
    }
    const failed = card.matches(FAILED) ? card : card.querySelector(FAILED);
    const explicitFailure = failed && ['failed', 'error'].includes(failed.getAttribute('data-status') || failed.getAttribute('data-state'));
    if (failed && (explicitFailure || /failed|error|unable|could not|something went wrong|lỗi|không thể|thất bại|không thành công|blocked/i.test(failed.textContent || ''))) {
      job.result = { id: job.id, attempt: job.attempt, status: 'error', error: normalize(failed.textContent) || 'Flow báo tạo ảnh thất bại.' };
      return;
    }
    const busy = busyMarkers().some(n => card.contains(n));
    const fresh = freshImages(card, job);
    const hasUnloaded = [...card.querySelectorAll('img')].some(img => !img.complete && !job.baseline.has(srcKey(img)));
    job.waitingReason = busy ? 'Flow vẫn có dấu hiệu đang tạo trên thẻ này.'
      : fresh.length > 1 ? 'Có nhiều ảnh mới khác nhau trong thẻ; chưa xác định được ảnh kết quả.'
      : hasUnloaded ? 'Ảnh xem trước chưa tải đủ dữ liệu. Đang chờ ảnh nạp xong.'
      : !fresh.length ? 'Chưa thấy ảnh kết quả hợp lệ trong thẻ đã theo dõi.'
      : 'Đã thấy ảnh kết quả, đang xác nhận ảnh ổn định.';
    if (!busy && fresh.length === 1) {
      const src = srcKey(fresh[0]);
      if (job.candidate !== src) { job.candidate = src; job.candidateAt = Date.now(); }
      if (Date.now() - job.candidateAt >= CONFIG.settleMs) {
        batch.claimed.add(src);
        job.result = { id: job.id, attempt: job.attempt, status: 'done', src };
        return;
      }
    } else { job.candidate = null; }
  }
  if (Date.now() - job.started > CONFIG.maxWaitMs) {
    job.result = { id: job.id, attempt: job.attempt, status: 'uncertain', error: 'Chờ quá 10 phút hoặc không nhận diện được thẻ kết quả. Dừng gửi thêm; kiểm tra Flow.' };
  }
}
function scan() {
  if (!batch) return;
  for (const job of batch.jobs.values()) inspectJob(job);
}
function requireBatch(msg) {
  if (!batch || batch.id !== msg.batchId) throw new Error('Phiên Flow đã đổi hoặc trang vừa tải lại.');
}
async function handle(msg) {
  if (msg.type === 'PING') return { ok: true, protocol: 4, hasInput: !!findPromptInput() };
  if (msg.type === 'BATCH_START') {
    if (batch) {
      scan();
      if ([...batch.jobs.values()].some(j => !j.result || j.result.status === 'uncertain')) {
        throw new Error('Phiên trước còn tác vụ chưa xác định. Đợi/hủy tác vụ trên Flow, sau đó F5 trang trước khi chạy mới.');
      }
    }
    if (busyMarkers().length) throw new Error('Flow còn tác vụ đang chạy. Hãy đợi xong trước khi bắt đầu.');
    STOP = false;
    batch = { id: msg.batchId, jobs: new Map(), claimed: new Set(), network: !!msg.network };
    return { ok: true };
  }
  if (msg.type === 'TODATAURL') return { dataUrl: await toDataUrl(msg.src) };
  requireBatch(msg);
  if (msg.type === 'STOP') { STOP = true; return { ok: true }; }
  if (msg.type === 'PREPARE_JOB') {
    if (STOP) throw new Error('Đã dừng.');
    const input = await wakePromptBox();
    if (!input) throw new Error('Không tìm thấy ô prompt.');
    if (STOP) throw new Error('Đã dừng.');
    if (batch.network) {
      const r = input.getBoundingClientRect();
      return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
    const attempt = msg.attempt ?? 1;
    if (!Number.isInteger(attempt) || attempt < 1) throw new Error('Số lần thử không hợp lệ.');
    const key = `${msg.id}:${attempt}`;
    const previous = batch.jobs.get(`${msg.id}:${attempt - 1}`);
    if (batch.jobs.has(key)) throw new Error('Mã tác vụ bị trùng.');
    if (attempt > 1 && previous?.result?.status !== 'error') {
      throw new Error('Chỉ tạo lại khi Flow đã xác nhận lần trước thất bại.');
    }
    const job = { id: msg.id, attempt, prompt: msg.prompt, baseline: new Set([...document.querySelectorAll("img")].map(srcKey)),
      busyBefore: new Set(busyMarkers().map(cardFor).filter(Boolean)), started: Date.now(), card: null };
    batch.jobs.set(key, job);
    const r = input.getBoundingClientRect();
    return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }
  if (msg.type === 'CONFIRM_JOB') {
    const job = batch.jobs.get(`${msg.id}:${msg.attempt ?? 1}`);
    if (!job) throw new Error('Không tìm thấy tác vụ.');
    const end = Date.now() + 12000;
    while (!STOP && Date.now() < end) {
      inspectJob(job);
      if (!job.card) {
        const fresh = [...new Set(busyMarkers().map(cardFor).filter(Boolean))].filter(n =>
          !job.busyBefore.has(n) && !ownedByOther(n, job));
        if (fresh.length === 1) bindCard(job, fresh[0]);
      }
      // Require a result card, not merely an empty editor: a cleared input
      // alone cannot identify which completion belongs to this prompt.
      if (job.card || job.result?.status === 'done') return { ok: true };
      await sleep(250);
    }
    return { ok: false, error: 'Không nhận diện được thẻ tác vụ mới trong Flow. Dừng để tránh gửi trùng; kiểm tra ảnh trên Flow.' };
  }
  if (msg.type === 'POLL_JOBS' || msg.type === 'RESCAN_JOBS') {
    scan();
    return { ok: true, results: [...batch.jobs.values()].filter(j => j.result).map(j => j.result),
      waiting: [...batch.jobs.values()].filter(j => !j.result).map(j => ({id: j.id, attempt: j.attempt, reason: j.waitingReason})) };
  }
  return { ok: false, error: 'Lệnh không được hỗ trợ.' };
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const supported = ['PING', 'BATCH_START', 'PREPARE_JOB', 'CONFIRM_JOB', 'POLL_JOBS', 'RESCAN_JOBS', 'STOP', 'TODATAURL'];
  if (!supported.includes(msg?.type)) return;
  handle(msg).then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;
});
// Capture results while a later prompt is being typed, even before panel polling.
setInterval(scan, 500);
console.log('[auto_flow] Network-ready input bridge v1.3.4.');
})();
