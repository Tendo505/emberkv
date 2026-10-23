// RESP2 (REdis Serialization Protocol) parsing and encoding.
//
// All strings are handled as "latin1" (one char per byte) so values are
// binary-safe: any byte sequence a client sends is stored and returned exactly.

export const ENCODING = "latin1";

const CR = 13;
const LF = 10;
const MAX_BULK_LENGTH = 64 * 1024 * 1024; // 64 MB per argument
const MAX_ARRAY_LENGTH = 1024 * 1024;
const MAX_INLINE_LENGTH = 64 * 1024;

export class ProtocolError extends Error {}

/**
 * Incremental request parser. Feed it raw socket chunks; it yields complete
 * commands (arrays of string arguments) and buffers any partial remainder.
 * Supports both multibulk requests (what client libraries send) and inline
 * commands (what you type into telnet / netcat).
 */
export class RequestParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  /** @returns {string[][]} commands completed by this chunk */
  feed(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const commands = [];
    let offset = 0;

    while (offset < this.buffer.length) {
      const result = this.buffer[offset] === 0x2a /* '*' */
        ? this.#parseMultibulk(offset)
        : this.#parseInline(offset);
      if (result === null) break; // need more data
      offset = result.offset;
      if (result.args.length > 0) commands.push(result.args);
    }

    this.buffer = this.buffer.subarray(offset);
    return commands;
  }

  #readLine(offset) {
    const end = this.buffer.indexOf(LF, offset);
    if (end === -1) return null;
    const lineEnd = end > offset && this.buffer[end - 1] === CR ? end - 1 : end;
    return { line: this.buffer.toString(ENCODING, offset, lineEnd), next: end + 1 };
  }

  #parseInline(offset) {
    const read = this.#readLine(offset);
    if (read === null) {
      if (this.buffer.length - offset > MAX_INLINE_LENGTH) throw new ProtocolError("too big inline request");
      return null;
    }
    return { args: splitInline(read.line), offset: read.next };
  }

  #parseMultibulk(offset) {
    const header = this.#readLine(offset);
    if (header === null) return null;
    const count = parseLength(header.line.slice(1), MAX_ARRAY_LENGTH, "multibulk length");

    const args = [];
    let pos = header.next;
    for (let i = 0; i < count; i++) {
      if (pos >= this.buffer.length) return null;
      if (this.buffer[pos] !== 0x24 /* '$' */) {
        throw new ProtocolError(`expected '$', got '${String.fromCharCode(this.buffer[pos])}'`);
      }
      const lenLine = this.#readLine(pos);
      if (lenLine === null) return null;
      const len = parseLength(lenLine.line.slice(1), MAX_BULK_LENGTH, "bulk length");
      const dataEnd = lenLine.next + len;
      if (dataEnd + 2 > this.buffer.length) return null;
      if (this.buffer[dataEnd] !== CR || this.buffer[dataEnd + 1] !== LF) {
        throw new ProtocolError("bulk string not terminated by CRLF");
      }
      args.push(this.buffer.toString(ENCODING, lenLine.next, dataEnd));
      pos = dataEnd + 2;
    }
    return { args, offset: pos };
  }
}

function parseLength(text, max, what) {
  if (!/^-?\d+$/.test(text)) throw new ProtocolError(`invalid ${what}`);
  const n = Number(text);
  if (n < 0 || n > max) throw new ProtocolError(`invalid ${what}`);
  return n;
}

/** Split an inline command, honouring "double" and 'single' quotes like redis-cli. */
export function splitInline(line) {
  const args = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;

    let arg = "";
    const quote = line[i] === '"' || line[i] === "'" ? line[i++] : null;
    while (i < line.length) {
      const ch = line[i];
      if (quote) {
        if (ch === "\\" && quote === '"' && i + 1 < line.length) {
          const esc = line[++i];
          arg += { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"' }[esc] ?? esc;
        } else if (ch === quote) {
          i++;
          break;
        } else {
          arg += ch;
        }
      } else if (/\s/.test(ch)) {
        break;
      } else {
        arg += ch;
      }
      i++;
    }
    args.push(arg);
  }
  return args;
}

// ---------- reply encoding ----------

/** Marker types so handlers can return plain JS values and still pick a RESP type. */
export class SimpleString {
  constructor(value) { this.value = value; }
}
export class ReplyError {
  constructor(message) { this.message = message; }
}

export const OK = new SimpleString("OK");
export const PONG = new SimpleString("PONG");
export const QUEUED = new SimpleString("QUEUED");

export const simple = (s) => new SimpleString(s);
export const error = (msg) => new ReplyError(msg);

/**
 * Encode a reply value:
 *   string → bulk string, number → integer, null/undefined → null bulk,
 *   Array → array (recursively), SimpleString → +, ReplyError → -
 */
export function encode(value) {
  if (value === null || value === undefined) return "$-1\r\n";
  if (typeof value === "string") return `$${Buffer.byteLength(value, ENCODING)}\r\n${value}\r\n`;
  if (typeof value === "number") return `:${Math.trunc(value)}\r\n`;
  if (Array.isArray(value)) return `*${value.length}\r\n${value.map(encode).join("")}`;
  if (value instanceof SimpleString) return `+${value.value}\r\n`;
  if (value instanceof ReplyError) return `-${value.message}\r\n`;
  throw new TypeError(`cannot encode reply of type ${typeof value}`);
}

/** Encode a client request (used by tests and the bundled benchmark). */
export function encodeCommand(args) {
  return `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(String(a), ENCODING)}\r\n${a}\r\n`).join("")}`;
}

/**
 * Incremental reply parser — the client-side counterpart, used by the test
 * suite and benchmark. Returns decoded JS values; errors become ReplyError.
 */
export class ReplyParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  feed(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const replies = [];
    let offset = 0;
    for (;;) {
      const r = this.#parse(offset);
      if (r === null) break;
      replies.push(r.value);
      offset = r.offset;
    }
    this.buffer = this.buffer.subarray(offset);
    return replies;
  }

  #parse(offset) {
    if (offset >= this.buffer.length) return null;
    const end = this.buffer.indexOf("\r\n", offset);
    if (end === -1) return null;
    const type = String.fromCharCode(this.buffer[offset]);
    const line = this.buffer.toString(ENCODING, offset + 1, end);
    const next = end + 2;

    switch (type) {
      case "+": return { value: new SimpleString(line), offset: next };
      case "-": return { value: new ReplyError(line), offset: next };
      case ":": return { value: Number(line), offset: next };
      case "$": {
        const len = Number(line);
        if (len === -1) return { value: null, offset: next };
        if (next + len + 2 > this.buffer.length) return null;
        return { value: this.buffer.toString(ENCODING, next, next + len), offset: next + len + 2 };
      }
      case "*": {
        const count = Number(line);
        if (count === -1) return { value: null, offset: next };
        const items = [];
        let pos = next;
        for (let i = 0; i < count; i++) {
          const item = this.#parse(pos);
          if (item === null) return null;
          items.push(item.value);
          pos = item.offset;
        }
        return { value: items, offset: pos };
      }
      default:
        throw new ProtocolError(`unknown reply type '${type}'`);
    }
  }
}
