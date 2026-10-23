import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  RequestParser, ReplyParser, ProtocolError, encode, encodeCommand, splitInline,
  OK, error, simple, SimpleString, ReplyError,
} from "../src/resp.js";

const buf = (s) => Buffer.from(s, "latin1");

describe("RequestParser", () => {
  test("parses a multibulk command", () => {
    const p = new RequestParser();
    assert.deepEqual(p.feed(buf("*2\r\n$3\r\nGET\r\n$3\r\nfoo\r\n")), [["GET", "foo"]]);
  });

  test("parses several pipelined commands in one chunk", () => {
    const p = new RequestParser();
    const cmds = p.feed(buf(encodeCommand(["SET", "a", "1"]) + encodeCommand(["GET", "a"])));
    assert.deepEqual(cmds, [["SET", "a", "1"], ["GET", "a"]]);
  });

  test("handles a command split across arbitrary chunk boundaries", () => {
    const wire = encodeCommand(["SET", "key", "hello world"]);
    for (let split = 1; split < wire.length; split++) {
      const p = new RequestParser();
      const first = p.feed(buf(wire.slice(0, split)));
      const second = p.feed(buf(wire.slice(split)));
      assert.deepEqual([...first, ...second], [["SET", "key", "hello world"]], `split at ${split}`);
    }
  });

  test("is binary safe, including CRLF and NUL inside values", () => {
    const value = "a\r\nb\0c\xff";
    const p = new RequestParser();
    assert.deepEqual(p.feed(buf(encodeCommand(["SET", "k", value]))), [["SET", "k", value]]);
  });

  test("parses inline commands with quotes", () => {
    const p = new RequestParser();
    assert.deepEqual(p.feed(buf('SET greeting "hello world"\r\nPING\n')), [["SET", "greeting", "hello world"], ["PING"]]);
  });

  test("ignores empty inline lines", () => {
    const p = new RequestParser();
    assert.deepEqual(p.feed(buf("\r\n\r\nPING\r\n")), [["PING"]]);
  });

  test("rejects malformed multibulk", () => {
    assert.throws(() => new RequestParser().feed(buf("*x\r\n")), ProtocolError);
    assert.throws(() => new RequestParser().feed(buf("*1\r\n+3\r\n")), ProtocolError);
    assert.throws(() => new RequestParser().feed(buf("*1\r\n$3\r\nabcXY")), ProtocolError);
  });

  test("rejects absurd lengths", () => {
    assert.throws(() => new RequestParser().feed(buf("*1\r\n$999999999999\r\n")), ProtocolError);
  });
});

describe("splitInline", () => {
  test("handles escapes in double quotes", () => {
    assert.deepEqual(splitInline('ECHO "a\\nb" \'c d\''), ["ECHO", "a\nb", "c d"]);
  });
});

describe("encode", () => {
  test("encodes every reply type", () => {
    assert.equal(encode("hi"), "$2\r\nhi\r\n");
    assert.equal(encode(""), "$0\r\n\r\n");
    assert.equal(encode(null), "$-1\r\n");
    assert.equal(encode(42), ":42\r\n");
    assert.equal(encode(OK), "+OK\r\n");
    assert.equal(encode(error("ERR bad")), "-ERR bad\r\n");
    assert.equal(encode(["a", 1, null]), "*3\r\n$1\r\na\r\n:1\r\n$-1\r\n");
    assert.equal(encode([]), "*0\r\n");
  });

  test("bulk length counts bytes, not UTF-16 units", () => {
    assert.equal(encode("\xff\xfe"), "$2\r\n\xff\xfe\r\n");
  });
});

describe("ReplyParser", () => {
  test("round-trips nested replies", () => {
    const p = new ReplyParser();
    const wire = encode(["x", [1, null, simple("OK")], error("ERR e")]);
    const [reply] = p.feed(buf(wire));
    assert.equal(reply[0], "x");
    assert.equal(reply[1][0], 1);
    assert.equal(reply[1][1], null);
    assert.ok(reply[1][2] instanceof SimpleString);
    assert.ok(reply[2] instanceof ReplyError);
  });

  test("waits for incomplete replies", () => {
    const p = new ReplyParser();
    assert.deepEqual(p.feed(buf("$5\r\nhel")), []);
    assert.deepEqual(p.feed(buf("lo\r\n")), ["hello"]);
  });
});
