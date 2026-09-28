import assert from "node:assert/strict";
import { test } from "node:test";
import {
  available,
  createRing,
  freeSpace,
  H,
  isEmpty,
  isFull,
  readSamples,
  writeSamples,
} from "./spsc-ring.mjs";

function fill(n, start = 0) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = start + i;
  return a;
}

test("empty and full states", () => {
  const ring = createRing(16);
  assert.equal(isEmpty(ring.hdr), true);
  assert.equal(isFull(ring.hdr), false);
  assert.equal(available(ring.hdr), 0);
  assert.equal(freeSpace(ring.hdr), 16);

  writeSamples(ring, fill(16), 16);
  assert.equal(isEmpty(ring.hdr), false);
  assert.equal(isFull(ring.hdr), true);
  assert.equal(available(ring.hdr), 16);
  assert.equal(freeSpace(ring.hdr), 0);

  const dst = new Float32Array(16);
  assert.equal(readSamples(ring, dst, 16), 16);
  assert.deepEqual(Array.from(dst), Array.from(fill(16)));
  assert.equal(isEmpty(ring.hdr), true);
  assert.equal(isFull(ring.hdr), false);
});

test("wraparound write then read matches", () => {
  const ring = createRing(16);
  writeSamples(ring, fill(10, 1), 10);
  const skip = new Float32Array(6);
  assert.equal(readSamples(ring, skip, 6), 6);
  writeSamples(ring, fill(10, 100), 10);
  const dst = new Float32Array(14);
  const n = readSamples(ring, dst, 14);
  assert.equal(n, 14);
  assert.deepEqual(Array.from(dst), [7, 8, 9, 10, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
});

test("writer overtaking reader drops oldest and keeps newest", () => {
  const ring = createRing(8);
  writeSamples(ring, fill(8, 1), 8);
  writeSamples(ring, fill(3, 50), 3);
  assert.ok(Atomics.load(ring.hdr, H.OVERRUN_EVENTS) >= 1);
  assert.equal(Atomics.load(ring.hdr, H.OVERRUN_SAMPLES), 3);
  assert.equal(available(ring.hdr), 8);
  const dst = new Float32Array(8);
  assert.equal(readSamples(ring, dst, 8), 8);
  assert.deepEqual(Array.from(dst), [4, 5, 6, 7, 8, 50, 51, 52]);
});

test("atomic index visibility: write publishes only after samples land", () => {
  const ring = createRing(32);
  const src = fill(8, 3);
  const w0 = Atomics.load(ring.hdr, H.WRITE);
  writeSamples(ring, src, 8);
  const w1 = Atomics.load(ring.hdr, H.WRITE);
  assert.equal((w1 - w0) >>> 0, 8);
  const dst = new Float32Array(8);
  assert.equal(readSamples(ring, dst, 8), 8);
  assert.deepEqual(Array.from(dst), Array.from(src));
});

test("CAS fails when writer overtakes mid-read window", () => {
  const ring = createRing(8);
  writeSamples(ring, fill(4, 1), 4);
  const r = Atomics.load(ring.hdr, H.READ);
  writeSamples(ring, fill(8, 90), 8);
  const moved = Atomics.load(ring.hdr, H.READ);
  assert.notEqual(moved, r);
  const dst = new Float32Array(8);
  const n = readSamples(ring, dst, 8);
  assert.equal(n, 8);
  assert.equal(isEmpty(ring.hdr), true);
});

test("reader never rereads a consumed index", () => {
  const ring = createRing(16);
  writeSamples(ring, fill(8, 10), 8);
  const a = new Float32Array(4);
  const b = new Float32Array(4);
  assert.equal(readSamples(ring, a, 4), 4);
  assert.equal(readSamples(ring, b, 4), 4);
  assert.deepEqual(Array.from(a), [10, 11, 12, 13]);
  assert.deepEqual(Array.from(b), [14, 15, 16, 17]);
  assert.equal(readSamples(ring, a, 4), 0);
});

test("overrun counters grow predictably", () => {
  const ring = createRing(8);
  for (let i = 0; i < 5; i++) writeSamples(ring, fill(8, i * 10), 8);
  assert.equal(Atomics.load(ring.hdr, H.WRITTEN_BLOCKS), 5);
  assert.equal(Atomics.load(ring.hdr, H.OVERRUN_EVENTS), 4);
  assert.equal(Atomics.load(ring.hdr, H.OVERRUN_SAMPLES), 32);
  assert.equal(available(ring.hdr), 8);
});
