/* SPDX-License-Identifier: AGPL-3.0-only
 * Image request correlation. Never generates or resends a Flow request.
 */
(() => {
  class FlowRpcTracker {
    constructor(protocol, now = () => Date.now()) {
      this.protocol = protocol;
      this.now = now;
      this.jobs = new Map();
      this.requests = new Map();
      this.claimed = new Set();
      this.fatal = '';
    }
    key(id, attempt) { return `${id}:${attempt}`; }
    arm(id, attempt, prompt) {
      if (this.fatal) throw new Error(this.fatal);
      if (!Number.isInteger(id) || id < 0 || !Number.isInteger(attempt) || attempt < 1 || !this.protocol.normalize(prompt)) throw new Error('Tác vụ không hợp lệ.');
      if (this.jobs.has(this.key(id, attempt))) throw new Error('Tác vụ đã được gửi; không gửi trùng.');
      const prior = this.jobs.get(this.key(id, attempt - 1));
      if (attempt > 1 && prior?.result?.status !== 'error') throw new Error('Chỉ thử lại khi server xác nhận lỗi có thể thử lại.');
      const job = { id, attempt, prompt: this.protocol.normalize(prompt), started: this.now(), requestId: null, result: null };
      this.jobs.set(this.key(id, attempt), job);
      return job;
    }
    bind(requestId, body) {
      const prompt = this.protocol.requestPrompt(body);
      const open = [...this.jobs.values()].filter(j => !j.requestId && !j.result);
      const matches = open.filter(j => j.prompt === prompt);
      if (matches.length !== 1) {
        this.failAll(prompt ? 'Request Flow không khớp duy nhất với prompt đang gửi. Dừng để tránh ghép sai ảnh.'
          : 'Flow gửi định dạng khác hoặc đang chọn nhiều ảnh / prompt. Chọn 1 ảnh; bản này chỉ hỗ trợ chế độ tạo ảnh thông thường.');
        return null;
      }
      const job = matches[0];
      job.requestId = requestId;
      job.sentAt = this.now();
      this.requests.set(requestId, job);
      return job;
    }
    uncertain(job, error) {
      if (!job || job.result?.status === 'done' || job.result?.status === 'error') return;
      job.result = { id: job.id, attempt: job.attempt, status: 'uncertain', error };
      this.fatal ||= error;
    }
    failAll(error) {
      this.fatal = error;
      for (const job of this.jobs.values()) this.uncertain(job, error);
    }
    response(requestId, status, text) {
      const job = this.requests.get(requestId);
      if (!job || job.result) return;
      if (status !== 200) {
        this.uncertain(job, `Flow trả HTTP ${Number(status) || 0}. Kiểm tra phiên đăng nhập, hạn mức và ảnh trên Flow; không tự gửi lại.`);
        return;
      }
      try {
        const image = this.protocol.imageResult(text);
        if (this.claimed.has(image.mediaId)) throw new Error('duplicate');
        this.claimed.add(image.mediaId);
        job.result = { id: job.id, attempt: job.attempt, status: 'done', ...image, source: 'network' };
      } catch (e) {
        // Only explicit transient server errors enter the existing retry queue.
        if (e.kind === 'rpc' && [13, 14].includes(e.code)) {
          job.result = { id: job.id, attempt: job.attempt, status: 'error', error: `Server Flow báo lỗi tạm thời (${e.code}); sẽ thử lại sau.` };
        } else {
          const reason = e.kind === 'image-count' ? 'Kết quả không phải đúng 1 ảnh. Chọn 1 ảnh / prompt trong Flow.'
            : e.kind === 'rpc' ? `Flow báo lỗi RPC${Number.isInteger(e.code) ? ' ' + e.code : ''}. Kiểm tra đăng nhập / hạn mức / nội dung prompt.`
            : 'Không đọc được kết quả Flow theo định dạng đã biết. Ảnh có thể đã tạo; kiểm tra Flow, không tự gửi lại.';
          this.uncertain(job, reason);
        }
      }
    }
    failed(requestId, details = {}, status = 0) {
      const job = this.requests.get(requestId);
      if (!job) return;
      const code = String(details.errorText || '').match(/\bnet::ERR_[A-Z0-9_]{1,64}\b/)?.[0];
      const signals = [code || 'loadingFailed', details.canceled && 'canceled', status && 'HTTP ' + status].filter(Boolean);
      this.uncertain(job, `Prompt ${job.id + 1} [${signals.join(', ')}]. Chrome chưa cung cấp đủ kết quả ảnh. Kiểm tra ảnh trên Flow trước khi gửi lại.`);
    }
    checkDeadline(job) {
      if (job.result) return;
      if (!job.requestId && this.now() - job.started > 100000) {
        this.uncertain(job, `Prompt ${job.id + 1}: chưa thấy yêu cầu tạo ảnh sau 100 giây. Kiểm tra ảnh, tác vụ và thông báo trên Flow trước khi chọn dòng chạy tiếp.`);
      }
      if (job.requestId && this.now() - job.sentAt > 600000) this.uncertain(job, 'Request đã gửi nhưng chưa nhận đủ kết quả sau 10 phút. Kiểm tra Flow trước khi chạy lại.');
    }
    poll() {
      for (const job of this.jobs.values()) this.checkDeadline(job);
      return {
        ok: true, fatal: this.fatal,
        results: [...this.jobs.values()].filter(j => j.result).map(j => j.result),
        waiting: [...this.jobs.values()].filter(j => !j.result).map(j => ({ id: j.id, attempt: j.attempt,
          bound: !!j.requestId, reason: j.requestId ? 'Flow đã nhận request; đang chờ phản hồi tạo ảnh.' : 'Đang chờ request tạo ảnh từ Flow.' })),
      };
    }
  }
  globalThis.FlowRpcTracker = FlowRpcTracker;
  if (typeof module !== 'undefined') module.exports = { FlowRpcTracker };
})();
