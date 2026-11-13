/* SPDX-License-Identifier: AGPL-3.0-only
 * Request/response schema adapted from AutoFlowCut, Copyright (C) 2026 Touchizen.
 * Source: electron/flow-rpc-protocol.js at 211a77933f299fc2f2520f8cb7ceeb161e72a315.
 * Modified 2026-11-04: standalone Chrome worker parser, image-only, strict correlation.
 * See LICENSE and THIRD_PARTY_NOTICES.md. No request is constructed or replayed.
 */
(() => {
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  class ProtocolError extends Error {
    constructor(kind, code = null) {
      super('Flow response: ' + kind);
      this.kind = kind;
      this.code = code;
    }
  }
  function projectKey(raw) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:') return null;
      const modern = ['flow.google.com', 'flow.google'].includes(u.hostname);
      // Collections have the same image composer, but must retain a separate
      // context key so changing collections during a batch cannot mix results.
      const m = modern ? u.pathname.match(/^\/project\/([^/]+)(?:\/all-media|\/collection\/([^/]+))?\/?$/)
        : u.hostname === 'labs.google' ? u.pathname.match(/^\/fx\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?tools\/flow\/project\/([^/]+)\/?$/i) : null;
      return m ? u.origin + ':' + m[1] + (m[2] ? ':collection:' + m[2] : '') : null;
    } catch (_) { return null; }
  }
  function imageRpc(raw) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' || !['flow.google.com', 'flow.google', 'labs.google'].includes(u.hostname)
        || !u.pathname.endsWith('/data/batchexecute')) return false;
      const ids = (u.searchParams.get('rpcids') || '').split(',');
      return ids.includes('ogiZ0b');
    } catch (_) { return false; }
  }
  function requestPrompt(body) {
    try {
      // Read only f.req; authentication parameters and headers are discarded.
      const outer = JSON.parse(new URLSearchParams(body).get('f.req'));
      if (!Array.isArray(outer?.[0]) || outer[0].length !== 1 || outer[0][0]?.[0] !== 'ogiZ0b') return null;
      const inner = JSON.parse(outer[0][0][1]);
      const items = inner?.[1];
      if (!Array.isArray(items) || items.length !== 1) return null;
      const segments = items[0]?.[8]?.[0];
      if (!Array.isArray(segments) || !segments.length || segments.some(s => !Array.isArray(s) || typeof s[0] !== 'string')) return null;
      return normalize(segments.map(s => s[0]).join(' '));
    } catch (_) { return null; }
  }
  function responsePayload(text) {
    if (typeof text !== 'string' || text.length > 4 * 1024 * 1024 || !text.startsWith(")]}'")) throw new ProtocolError('shape');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('[')) continue;
      let frames;
      try { frames = JSON.parse(line); } catch (_) { throw new ProtocolError('shape'); }
      if (!Array.isArray(frames)) continue;
      for (const f of frames) {
        if (!Array.isArray(f)) continue;
        if (f[0] === 'er') throw new ProtocolError('rpc', typeof f[9] === 'number' ? f[9] : null);
        if (f[0] !== 'wrb.fr' || f[1] !== 'ogiZ0b') continue;
        if (typeof f[2] === 'string') {
          try { return JSON.parse(f[2]); } catch (_) { throw new ProtocolError('shape'); }
        }
        if (typeof f[5]?.[0] === 'number') throw new ProtocolError('rpc', f[5][0]);
        throw new ProtocolError('shape');
      }
    }
    throw new ProtocolError('shape');
  }
  function imageResult(text) {
    const payload = responsePayload(text);
    if (!Array.isArray(payload?.[0]) || payload[0].length !== 1) throw new ProtocolError('image-count');
    const item = payload[0][0];
    const mediaId = item?.[0];
    const holder = item?.[6];
    const record = holder?.[0];
    const dims = holder?.[2];
    const src = record?.[13];
    if (typeof mediaId !== 'string' || !mediaId || !Array.isArray(dims) || dims.length < 2
      || !dims.slice(0, 2).every(n => Number.isInteger(n) && n > 0)) throw new ProtocolError('shape');
    let u;
    try { u = new URL(src); } catch (_) { throw new ProtocolError('shape'); }
    if (u.protocol !== 'https:' || u.hostname !== 'flow-content.google' || u.username || u.password || (u.port && u.port !== '443')) throw new ProtocolError('media-host');
    return { mediaId, src: u.href, width: dims[0], height: dims[1] };
  }
  const api = { normalize, ProtocolError, projectKey, imageRpc, requestPrompt, imageResult };
  globalThis.FlowProtocol = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
