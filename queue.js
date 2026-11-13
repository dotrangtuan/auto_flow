/* Fixed groups: finish every generation in a group before starting the next. */
class FlowQueue {
  constructor(prompts, size) {
    this.limit = Math.min(10, Math.max(1, Math.trunc(Number(size)) || 10));
    this.items = prompts.map((prompt, id) => ({ id, prompt, status: 'pending', attempts: 0, generated: false }));
    this.groupStart = 0;
    this.halted = false;
  }
  get group() { return this.items.slice(this.groupStart, this.groupStart + this.limit); }
  get groupNumber() { return Math.floor(this.groupStart / this.limit) + 1; }
  get groupCount() { return Math.ceil(this.items.length / this.limit); }
  get active() { return this.items.filter(i => ['submitting', 'generating', 'uncertain'].includes(i.status)); }
  reserve(now = Date.now()) {
    if (this.halted || this.complete) return null;
    if (this.group.every(i => i.generated)) this.groupStart += this.limit;
    const group = this.group;
    // Finish sending the original prompts in this group first.
    let item = group.find(i => i.status === 'pending');
    if (!item) {
      // Let all current attempts finish, then retry failed prompts individually.
      if (this.active.length) return null;
      item = group.filter(i => i.status === 'retry_wait' && i.retryAt <= now)
        .sort((a, b) => a.retryAt - b.retryAt || a.id - b.id)[0];
    }
    if (!item || this.active.length >= this.limit) return null;
    const normalized = s => s.replace(/\s+/g, ' ').trim();
    if (this.active.some(i => normalized(i.prompt) === normalized(item.prompt))) return null;
    item.status = 'submitting';
    item.attempts++;
    item.error = '';
    return item;
  }
  accepted(id) {
    const item = this.items[id];
    if (item?.status === 'submitting') item.status = 'generating';
  }
  finish(id, status, now = Date.now()) {
    const item = this.items[id];
    if (!item || !['submitting', 'generating'].includes(item.status)) return false;
    if (status === 'downloading') {
      item.generated = true;
      item.status = 'downloading';
      item.error = '';
      return true;
    }
    if (status === 'error') {
      item.status = 'retry_wait';
      // Unlimited retries with a bounded pause; never skip a failed prompt.
      item.retryAt = now + Math.min(60000, 5000 * 2 ** Math.min(4, item.attempts - 1));
      return true;
    }
    return false;
  }
  uncertain(id) {
    if (this.items[id] && ['submitting', 'generating'].includes(this.items[id].status)) {
      this.items[id].status = 'uncertain';
    }
    this.halted = true;
  }
  stop() { this.halted = true; }
  get complete() { return this.items.every(i => i.generated); }
}
if (typeof module !== 'undefined') module.exports = { FlowQueue };
