// Download ownership and naming live in the worker, independently of the panel.
(() => {
  const records = new Map();
  const key = id => `h2flow.download.${id}`;
  let launching = null;
  let launchChain = Promise.resolve();
  const imageExt = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/jfif': 'jpg',
    'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif' };
  function nameFor(record, mime) {
    const ext = imageExt[String(mime || '').split(';')[0].toLowerCase()];
    return ext ? record.requested.replace(/\.[^.\/]+$/, `.${ext}`) : record.requested;
  }
  function validName(name) {
    return typeof name === 'string' && name.length > 0 && !name.startsWith('/') &&
      !/[\\\x00-\x1f:*?"<>|]/.test(name) && !name.split('/').some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s));
  }
  async function persist(id, record) {
    records.set(id, record);
    await chrome.storage.session.set({ [key(id)]: { requested: record.requested, expected: record.expected, id } });
  }
  async function read(id) {
    return records.get(id) || (await chrome.storage.session.get(key(id)))[key(id)] || null;
  }
  function matchesName(actual, expected) {
    const file = String(actual || '').replace(/\\/g, '/');
    const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dot = escaped.lastIndexOf('\\.');
    // Chrome may append " (1)" to resolve an existing file, without removing its prefix.
    const pattern = dot < 0 ? escaped : escaped.slice(0, dot) + '(?: \\(\\d+\\))?' + escaped.slice(dot);
    return new RegExp('(?:^|/)' + pattern + '$', 'i').test(file);
  }
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (item.byExtensionId !== chrome.runtime.id) { suggest(); return; }
    const known = records.get(item.id) ||
      (launching && launching.url === item.url && (launching.id == null || launching.id === item.id) ? launching : null);
    const apply = record => {
      if (!record) { suggest(); return; }
      record.id = item.id;
      record.expected = nameFor(record, item.mime);
      records.set(item.id, record);
      suggest({ filename: record.expected, conflictAction: 'uniquify' });
      persist(item.id, record).catch(e => console.warn('[auto_flow] download metadata:', e));
    };
    if (known) { apply(known); return; }
    read(item.id).then(apply, () => suggest());
    return true;
  });
  async function start(msg) {
    if (!validName(msg.filename)) throw new Error('Tên file không hợp lệ.');
    if (!/^(https?:\/\/|data:image\/)/i.test(msg.url || '')) throw new Error('Địa chỉ ảnh không hợp lệ.');
    const record = { url: msg.url, requested: msg.filename, expected: msg.filename, id: null };
    launching = record;
    try {
      const id = await chrome.downloads.download({ url: record.url, filename: record.requested,
        conflictAction: 'uniquify', saveAs: false });
      record.id = id;
      // Retain metadata across service-worker suspension. Do not store image bytes.
      await persist(id, { ...record, url: undefined });
      return { ok: true, downloadId: id };
    } finally { launching = null; }
  }
  async function status(id) {
    const record = await read(id);
    if (!record) throw new Error('Không còn thông tin lượt tải. Kiểm tra Downloads của trình duyệt.');
    const [item] = await chrome.downloads.search({ id });
    if (!item) throw new Error('Không tìm thấy lượt tải trong trình duyệt.');
    if (item.state === 'interrupted') throw new Error('Tải ảnh bị gián đoạn: ' + (item.error || 'không rõ nguyên nhân'));
    if (item.state !== 'complete') return { ok: true, state: 'in_progress' };
    const expected = nameFor(record, item.mime);
    const actual = item.filename || '';
    if (!matchesName(actual, expected)) {
      return { ok: false, state: 'name_mismatch', actualFilename: actual,
        error: `Tên file tải về không đúng: ${actual.split(/[\\/]/).pop()}. Tên cần lưu: ${expected}. Kiểm tra tiện ích quản lý tải xuống hoặc tên đã sửa trong hộp lưu file.` };
    }
    return { ok: true, state: 'complete', filename: actual, downloadId: id };
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'DOWNLOAD_IMAGE') {
      const task = launchChain.then(() => start(msg));
      launchChain = task.catch(() => {});
      task.then(sendResponse, e => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg?.type === 'DOWNLOAD_STATUS') {
      status(msg.downloadId).then(sendResponse, e => sendResponse({ ok: false, error: e.message }));
      return true;
    }
  });
  chrome.downloads.onErased.addListener(id => {
    records.delete(id);
    chrome.storage.session.remove(key(id)).catch(() => {});
  });
})();
