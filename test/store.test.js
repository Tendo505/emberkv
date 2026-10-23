import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store, WrongTypeError, globToRegExp } from "../src/store.js";
import { Deque } from "../src/deque.js";

function fakeClock(start = 1_000_000) {
  const clock = { t: start, now: () => clock.t, advance: (ms) => { clock.t += ms; } };
  return clock;
}

describe("Store", () => {
  test("set/get with type checking", () => {
    const s = new Store();
    s.set("k", "string", "v");
    assert.equal(s.get("k", "string"), "v");
    assert.throws(() => s.get("k", "list"), WrongTypeError);
    assert.equal(s.get("missing", "string"), undefined);
  });

  test("keys expire lazily on access", () => {
    const clock = fakeClock();
    const s = new Store({ now: clock.now });
    s.set("k", "string", "v");
    s.expireAt("k", clock.t + 1000);
    assert.equal(s.ttl("k"), 1000);
    clock.advance(999);
    assert.equal(s.get("k", "string"), "v");
    clock.advance(1);
    assert.equal(s.get("k", "string"), undefined);
    assert.equal(s.ttl("k"), -2);
    assert.equal(s.stats.expiredKeys, 1);
  });

  test("SET-style overwrite clears TTL unless keepTtl", () => {
    const clock = fakeClock();
    const s = new Store({ now: clock.now });
    s.set("k", "string", "1");
    s.expireAt("k", clock.t + 5000);
    s.set("k", "string", "2", { keepTtl: true });
    assert.equal(s.ttl("k"), 5000);
    s.set("k", "string", "3");
    assert.equal(s.ttl("k"), -1);
  });

  test("expireAt in the past deletes immediately", () => {
    const clock = fakeClock();
    const s = new Store({ now: clock.now });
    s.set("k", "string", "v");
    assert.equal(s.expireAt("k", clock.t - 1), true);
    assert.equal(s.has("k"), false);
  });

  test("active expiry removes stale keys without access", () => {
    const clock = fakeClock();
    const s = new Store({ now: clock.now });
    for (let i = 0; i < 500; i++) {
      s.set(`k${i}`, "string", "v");
      s.expireAt(`k${i}`, clock.t + 100);
    }
    s.set("forever", "string", "v");
    clock.advance(200);
    s.activeExpireCycle({ maxRounds: 1000 });
    assert.equal(s.data.size, 1);
    assert.equal(s.expires.size, 0);
  });

  test("snapshot and restore round-trip all types and TTLs", () => {
    const clock = fakeClock();
    const a = new Store({ now: clock.now });
    a.set("str", "string", "hello");
    a.set("list", "list", new Deque(["a", "b"]));
    a.set("hash", "hash", new Map([["f", "v"]]));
    a.expireAt("str", clock.t + 10_000);
    a.set("stale", "string", "x");
    a.expireAt("stale", clock.t + 10);
    clock.advance(20);

    const snap = JSON.parse(JSON.stringify(a.snapshot()));
    const b = new Store({ now: clock.now });
    b.restore(snap);
    assert.equal(b.get("str", "string"), "hello");
    assert.deepEqual(b.get("list", "list").toArray(), ["a", "b"]);
    assert.equal(b.get("hash", "hash").get("f"), "v");
    assert.equal(b.ttl("str"), 9_980);
    assert.equal(b.has("stale"), false);
  });

  test("restore rejects unknown formats", () => {
    assert.throws(() => new Store().restore({ version: 99 }));
  });
});

describe("globToRegExp", () => {
  const cases = [
    ["*", "anything", true],
    ["user:*", "user:42", true],
    ["user:*", "users:42", false],
    ["h?llo", "hello", true],
    ["h?llo", "heello", false],
    ["h[ae]llo", "hallo", true],
    ["h[ae]llo", "hillo", false],
    ["h[^e]llo", "hallo", true],
    ["h[^e]llo", "hello", false],
    ["h[a-c]llo", "hbllo", true],
    ["a\\*b", "a*b", true],
    ["a\\*b", "axb", false],
    ["a.b", "axb", false],
    ["(x)", "(x)", true],
  ];
  for (const [pattern, input, expected] of cases) {
    test(`${pattern} ${expected ? "matches" : "does not match"} ${input}`, () => {
      assert.equal(globToRegExp(pattern).test(input), expected);
    });
  }
});
