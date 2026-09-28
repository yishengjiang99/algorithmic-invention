import assert from "node:assert/strict";
import { test } from "node:test";

const HEADER_INTS = 16;
const HEADER_BYTES = 64;
const H = {
  WRITE: 0,
  READ: 1,
  CAP: 2,
  OVERRUN_SAMPLES: 3,
  OVERRUN_EVENTS: 4,
  WRITTEN_BLOCKS: 5,
  DROPPED_BLOCKS: 6,
  ANALYZED_BLOCKS: 10,
  ANALYZED_SAMPLES: 15,
};

function createRing(capacity) {
  const sab = new SharedArrayBuffer(HEADER_BYTES + capacity * 4);
  const hdr = new Int32Array(sab, 0, HEADER_INTS);
  const samples = new Float32Array(sab, HEADER_BYTES, capacity);
  Atomics.store(hdr, H.CAP, capacity);
  return { sab, hdr, samples, cap: capacity, mask: capacity - 1 };
}

function available(hdr) {
  return (Atomics.load(hdr, H.WRITE) - Atomics.load(hdr, H.READ)) >>> 0;
}

function freeSpace(hdr) {
  const cap = Atomics.load(hdr, H.CAP);
  const used = available(hdr);
  return used >= cap ? 0 : cap - used;
}

function isEmpty(hdr) {
  return available(hdr) === 0;
}

function isFull(hdr) {
  return available(hdr) >= Atomics.load(hdr, H.CAP);
}

function writeSamples(ring, src, n) {
  const { hdr, samples, cap, mask } = ring;
  if (n <= 0) return 0;
  const w = Atomics.load(hdr, H.WRITE);
  const r = Atomics.load(hdr, H.READ);
  const used = (w - r) >>> 0;
  if (used + n > cap) {
    Atomics.add(hdr, H.OVERRUN_SAMPLES, n);
    Atomics.add(hdr, H.OVERRUN_EVENTS, 1);
    Atomics.add(hdr, H.DROPPED_BLOCKS, 1);
    return 0;
  }
  const idx = w & mask;
  const first = n < cap - idx ? n : cap - idx;
  for (let i = 0; i < first; i++) samples[idx + i] = src[i];
  for (let i = first; i < n; i++) samples[i - first] = src[i];
  Atomics.add(hdr, H.WRITTEN_BLOCKS, 1);
  Atomics.add(hdr, H.WRITE, n);
  return n;
}

function readSamples(ring, dst, max = dst.length) {
  const { hdr, samples, cap, mask } = ring;
  const r = Atomics.load(hdr, H.READ);
  const w = Atomics.load(hdr, H.WRITE);
  const availRaw = (w - r) >>> 0;
  const avail = availRaw > cap ? cap : availRaw;
  const n = avail < max ? avail : max;
  if (n <= 0) return 0;
  const idx = r & mask;
  const first = n < cap - idx ? n : cap - idx;
  for (let i = 0; i < first; i++) dst[i] = samples[idx + i];
  for (let i = first; i < n; i++) dst[i] = samples[i - first];
  const ok = Atomics.compareExchange(hdr, H.READ, r, r + n);
  if (ok !== r) return 0;
  Atomics.add(hdr, H.ANALYZED_SAMPLES, n);
  Atomics.add(hdr, H.ANALYZED_BLOCKS, 1);
  return n;
}

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

test("writer does not move read when the ring is full", () => {
  const ring = createRing(8);
  writeSamples(ring, fill(8, 1), 8);
  const readBefore = Atomics.load(ring.hdr, H.READ);
  assert.equal(writeSamples(ring, fill(3, 50), 3), 0);
  assert.equal(Atomics.load(ring.hdr, H.READ), readBefore);
  assert.ok(Atomics.load(ring.hdr, H.OVERRUN_EVENTS) >= 1);
  assert.equal(Atomics.load(ring.hdr, H.OVERRUN_SAMPLES), 3);
  assert.equal(available(ring.hdr), 8);
  const dst = new Float32Array(8);
  assert.equal(readSamples(ring, dst, 8), 8);
  assert.deepEqual(Array.from(dst), [1, 2, 3, 4, 5, 6, 7, 8]);
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

test("consumer-owned read is not advanced by a full producer", () => {
  const ring = createRing(8);
  writeSamples(ring, fill(8, 1), 8);
  const consumer = new Float32Array(4);
  assert.equal(readSamples(ring, consumer, 4), 4);
  assert.equal(writeSamples(ring, fill(4, 90), 4), 4);
  assert.equal(Atomics.load(ring.hdr, H.OVERRUN_EVENTS), 0);
  const dst = new Float32Array(8);
  assert.equal(readSamples(ring, dst, 8), 8);
  assert.deepEqual(Array.from(dst), [5, 6, 7, 8, 90, 91, 92, 93]);
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

test("overrun counters grow predictably when full", () => {
  const ring = createRing(8);
  assert.equal(writeSamples(ring, fill(8, 0), 8), 8);
  for (let i = 0; i < 4; i++) assert.equal(writeSamples(ring, fill(8, i * 10), 8), 0);
  assert.equal(Atomics.load(ring.hdr, H.WRITTEN_BLOCKS), 1);
  assert.equal(Atomics.load(ring.hdr, H.OVERRUN_EVENTS), 4);
  assert.equal(Atomics.load(ring.hdr, H.OVERRUN_SAMPLES), 32);
  assert.equal(Atomics.load(ring.hdr, H.READ), 0);
  assert.equal(available(ring.hdr), 8);
});
