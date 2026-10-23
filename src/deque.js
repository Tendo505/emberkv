// Growable ring buffer: O(1) push/pop at both ends and O(1) random access.
// Backs Redis lists (LPUSH on a plain JS array is O(n) because of unshift)
// and the client's pending-reply queue.

export class Deque {
  constructor(items = []) {
    this.capacity = 16;
    while (this.capacity < items.length) this.capacity *= 2;
    this.buf = new Array(this.capacity);
    this.head = 0;
    this.length = 0;
    for (const item of items) this.push(item);
  }

  #grow() {
    const next = new Array(this.capacity * 2);
    for (let i = 0; i < this.length; i++) next[i] = this.buf[(this.head + i) & (this.capacity - 1)];
    this.buf = next;
    this.head = 0;
    this.capacity *= 2;
  }

  push(item) {
    if (this.length === this.capacity) this.#grow();
    this.buf[(this.head + this.length) & (this.capacity - 1)] = item;
    this.length++;
  }

  unshift(item) {
    if (this.length === this.capacity) this.#grow();
    this.head = (this.head - 1 + this.capacity) & (this.capacity - 1);
    this.buf[this.head] = item;
    this.length++;
  }

  shift() {
    if (this.length === 0) return undefined;
    const item = this.buf[this.head];
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) & (this.capacity - 1);
    this.length--;
    return item;
  }

  pop() {
    if (this.length === 0) return undefined;
    const i = (this.head + this.length - 1) & (this.capacity - 1);
    const item = this.buf[i];
    this.buf[i] = undefined;
    this.length--;
    return item;
  }

  peek() {
    return this.length ? this.buf[this.head] : undefined;
  }

  at(index) {
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    return this.buf[(this.head + index) & (this.capacity - 1)];
  }

  set(index, value) {
    this.buf[(this.head + index) & (this.capacity - 1)] = value;
  }

  /** Copy of items in [start, end), like Array.prototype.slice for non-negative bounds. */
  slice(start = 0, end = this.length) {
    const out = [];
    for (let i = Math.max(0, start); i < Math.min(end, this.length); i++) out.push(this.at(i));
    return out;
  }

  /** Replace contents (used by LTRIM / LREM, which are O(n) in Redis too). */
  replace(items) {
    const fresh = new Deque(items);
    Object.assign(this, { capacity: fresh.capacity, buf: fresh.buf, head: 0, length: fresh.length });
  }

  toArray() {
    return this.slice();
  }

  [Symbol.iterator]() {
    let i = 0;
    return { next: () => (i < this.length ? { value: this.at(i++), done: false } : { value: undefined, done: true }) };
  }
}
