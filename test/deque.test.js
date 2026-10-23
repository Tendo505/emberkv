import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Deque } from "../src/deque.js";

describe("Deque", () => {
  test("push/shift is FIFO, unshift/shift is LIFO", () => {
    const d = new Deque();
    d.push(1); d.push(2); d.unshift(0);
    assert.deepEqual(d.toArray(), [0, 1, 2]);
    assert.equal(d.shift(), 0);
    assert.equal(d.pop(), 2);
    assert.equal(d.length, 1);
  });

  test("grows across the wrap-around point without losing order", () => {
    const d = new Deque();
    const model = [];
    // Interleave operations so head wraps many times while growing.
    for (let i = 0; i < 1000; i++) {
      if (i % 3 === 0) { d.unshift(i); model.unshift(i); }
      else { d.push(i); model.push(i); }
      if (i % 7 === 0) assert.equal(d.shift(), model.shift());
      if (i % 11 === 0) assert.equal(d.pop(), model.pop());
    }
    assert.deepEqual(d.toArray(), model);
    assert.equal(d.at(-1), model.at(-1));
    assert.equal(d.at(5), model[5]);
  });

  test("empty operations return undefined", () => {
    const d = new Deque();
    assert.equal(d.shift(), undefined);
    assert.equal(d.pop(), undefined);
    assert.equal(d.peek(), undefined);
    assert.equal(d.at(0), undefined);
  });

  test("slice, set, replace and iteration", () => {
    const d = new Deque(["a", "b", "c", "d"]);
    assert.deepEqual(d.slice(1, 3), ["b", "c"]);
    d.set(0, "A");
    assert.deepEqual([...d], ["A", "b", "c", "d"]);
    d.replace(["x"]);
    assert.deepEqual(d.toArray(), ["x"]);
    d.unshift("w");
    assert.deepEqual(d.toArray(), ["w", "x"]);
  });

  test("100k unshifts stay fast (O(1) each)", () => {
    const d = new Deque();
    const start = performance.now();
    for (let i = 0; i < 100_000; i++) d.unshift(i);
    assert.ok(performance.now() - start < 500);
    assert.equal(d.at(0), 99_999);
  });
});
