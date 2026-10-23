import { Deque } from "./deque.js";

// The keyspace: typed values with optional expiry.
//
// Expiry works the way Redis does it:
//   - lazily: every read checks the deadline and drops a stale key, and
//   - actively: a periodic cycle samples keys that have a TTL and deletes the
//     expired ones, repeating while more than 25% of the sample was stale.

export const WRONGTYPE = "WRONGTYPE Operation against a key holding the wrong kind of value";

export class WrongTypeError extends Error {
  constructor() { super(WRONGTYPE); }
}

const SAMPLE_SIZE = 20;
const REPEAT_THRESHOLD = 0.25;

export class Store {
  /** @param {{ now?: () => number }} [options] injectable clock for tests */
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.data = new Map();     // key -> { type: "string" | "list" | "hash", value }
    this.expires = new Map();  // key -> unix ms deadline
    this.dirty = 0;            // writes since last save
    this.stats = { expiredKeys: 0, hits: 0, misses: 0 };
  }

  // ---------- core access ----------

  #isExpired(key) {
    const deadline = this.expires.get(key);
    if (deadline !== undefined && deadline <= this.now()) {
      this.data.delete(key);
      this.expires.delete(key);
      this.stats.expiredKeys++;
      return true;
    }
    return false;
  }

  /** Raw entry lookup with lazy expiry. */
  entry(key) {
    if (this.#isExpired(key)) return undefined;
    return this.data.get(key);
  }

  /** Get a value, asserting its type. Returns undefined when missing. */
  get(key, type) {
    const e = this.entry(key);
    if (e === undefined) {
      this.stats.misses++;
      return undefined;
    }
    if (type && e.type !== type) throw new WrongTypeError();
    this.stats.hits++;
    return e.value;
  }

  /**
   * Get a container value (list/hash) for writing, creating it if absent.
   * Never resets TTL on an existing key.
   */
  getOrCreate(key, type, create) {
    const e = this.entry(key);
    if (e === undefined) {
      const value = create();
      this.data.set(key, { type, value });
      return value;
    }
    if (e.type !== type) throw new WrongTypeError();
    return e.value;
  }

  /** Overwrite a key. Like Redis SET, this clears any TTL unless keepTtl. */
  set(key, type, value, { keepTtl = false } = {}) {
    this.data.set(key, { type, value });
    if (!keepTtl) this.expires.delete(key);
    this.touch();
  }

  delete(key) {
    if (this.entry(key) === undefined) return false;
    this.data.delete(key);
    this.expires.delete(key);
    this.touch();
    return true;
  }

  /** Remove a container key once it becomes empty (Redis never stores empty lists/hashes). */
  deleteIfEmpty(key, size) {
    if (size === 0) {
      this.data.delete(key);
      this.expires.delete(key);
    }
  }

  has(key) {
    return this.entry(key) !== undefined;
  }

  type(key) {
    return this.entry(key)?.type ?? "none";
  }

  touch() {
    this.dirty++;
  }

  // ---------- expiry ----------

  /** Set an absolute deadline in ms. A deadline in the past deletes the key now. */
  expireAt(key, deadline) {
    if (!this.has(key)) return false;
    if (deadline <= this.now()) {
      this.delete(key);
    } else {
      this.expires.set(key, deadline);
      this.touch();
    }
    return true;
  }

  persist(key) {
    if (!this.has(key) || !this.expires.has(key)) return false;
    this.expires.delete(key);
    this.touch();
    return true;
  }

  /** Remaining TTL in ms: -2 if the key is missing, -1 if it has no TTL. */
  ttl(key) {
    if (!this.has(key)) return -2;
    const deadline = this.expires.get(key);
    return deadline === undefined ? -1 : Math.max(0, deadline - this.now());
  }

  /** One active-expiry cycle. Returns the number of keys removed. */
  activeExpireCycle({ maxRounds = 16 } = {}) {
    let removed = 0;
    for (let round = 0; round < maxRounds && this.expires.size > 0; round++) {
      const sample = sampleKeys(this.expires, SAMPLE_SIZE);
      let expired = 0;
      for (const key of sample) if (this.#isExpired(key)) expired++;
      removed += expired;
      if (expired / sample.length <= REPEAT_THRESHOLD) break;
    }
    return removed;
  }

  // ---------- whole-keyspace ops ----------

  keys() {
    const out = [];
    for (const key of this.data.keys()) if (!this.#isExpired(key)) out.push(key);
    return out;
  }

  size() {
    // Accurate count requires dropping stale keys first.
    for (const key of [...this.expires.keys()]) this.#isExpired(key);
    return this.data.size;
  }

  flush() {
    this.data.clear();
    this.expires.clear();
    this.touch();
  }

  randomKey() {
    const keys = this.keys();
    return keys.length ? keys[Math.floor(Math.random() * keys.length)] : null;
  }

  // ---------- snapshot ----------

  /** Serialisable snapshot. Lists and hashes become arrays / entry pairs. */
  snapshot() {
    const now = this.now();
    const entries = [];
    for (const [key, { type, value }] of this.data) {
      const deadline = this.expires.get(key);
      if (deadline !== undefined && deadline <= now) continue;
      entries.push({
        key,
        type,
        value: type === "hash" ? [...value] : type === "list" ? [...value] : value,
        ...(deadline !== undefined && { expiresAt: deadline }),
      });
    }
    return { version: 1, savedAt: now, entries };
  }

  restore(snapshot) {
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.entries)) {
      throw new Error("unsupported snapshot format");
    }
    this.data.clear();
    this.expires.clear();
    const now = this.now();
    for (const { key, type, value, expiresAt } of snapshot.entries) {
      if (expiresAt !== undefined && expiresAt <= now) continue;
      const restored = type === "hash" ? new Map(value) : type === "list" ? new Deque(value) : value;
      this.data.set(key, { type, value: restored });
      if (expiresAt !== undefined) this.expires.set(key, expiresAt);
    }
    this.dirty = 0;
  }
}

/** Reservoir-free sample: walk from a random start in insertion order. Cheap and good enough. */
function sampleKeys(map, n) {
  const keys = [...map.keys()];
  if (keys.length <= n) return keys;
  const start = Math.floor(Math.random() * keys.length);
  const out = [];
  for (let i = 0; i < n; i++) out.push(keys[(start + i) % keys.length]);
  return out;
}

/** Redis-style glob matching for KEYS / PSUBSCRIBE: * ? [abc] [^a] [a-z] and \ escapes. */
export function globToRegExp(pattern) {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") re += "[\\s\\S]*";
    else if (ch === "?") re += "[\\s\\S]";
    else if (ch === "\\" && i + 1 < pattern.length) re += escapeRe(pattern[++i]);
    else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
        continue;
      }
      let body = pattern.slice(i + 1, close);
      const negate = body.startsWith("^");
      if (negate) body = body.slice(1);
      re += `[${negate ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`;
      i = close;
    } else re += escapeRe(ch);
  }
  return new RegExp(re + "$", "s");
}

function escapeRe(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
