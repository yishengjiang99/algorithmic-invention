export const HEADER_INTS = 16;
export const HEADER_BYTES = HEADER_INTS * 4;

export const H = {
  WRITE: 0,
  READ: 1,
  CAP: 2,
  OVERRUN_SAMPLES: 3,
  OVERRUN_EVENTS: 4,
  WRITTEN_BLOCKS: 5,
  DROPPED_BLOCKS: 6,
  WRITE_TIME: 7,
  PROCESS_US: 8,
  DEADLINE_MISS: 9,
  ANALYZED_BLOCKS: 10,
  DISPLAY_POSTS: 11,
  SEQ: 12,
  FLAGS: 13,
  LAST_BLOCK: 14,
};

export function ringBytes(capacity) {
  if (capacity < 2 || (capacity & (capacity - 1)) !== 0) {
    throw new Error("ring capacity must be a power of two");
  }
  return HEADER_BYTES + capacity * 4;
}

export function createRing(capacity = 32768, backing) {
  const bytes = ringBytes(capacity);
  const sab =
    backing ??
    (typeof SharedArrayBuffer === "function"
      ? new SharedArrayBuffer(bytes)
      : new ArrayBuffer(bytes));
  if (sab.byteLength < bytes) throw new Error("ring backing too small");
  const hdr = new Int32Array(sab, 0, HEADER_INTS);
  const samples = new Float32Array(sab, HEADER_BYTES, capacity);
  Atomics.store(hdr, H.CAP, capacity);
  return { sab, hdr, samples, cap: capacity, mask: capacity - 1 };
}

export function available(hdr) {
  return (Atomics.load(hdr, H.WRITE) - Atomics.load(hdr, H.READ)) >>> 0;
}

export function freeSpace(hdr) {
  const cap = Atomics.load(hdr, H.CAP);
  const used = available(hdr);
  return used >= cap ? 0 : cap - used;
}

export function isEmpty(hdr) {
  return available(hdr) === 0;
}

export function isFull(hdr) {
  return available(hdr) >= Atomics.load(hdr, H.CAP);
}

export function writeSamples(ring, src, n, processUs = 0, budgetUs = 0, nowCentiMs = 0) {
  const { hdr, samples, cap, mask } = ring;
  if (n <= 0) return 0;
  const w = Atomics.load(hdr, H.WRITE);
  const r = Atomics.load(hdr, H.READ);
  const used = (w - r) >>> 0;
  if (used + n > cap) {
    const drop = used + n - cap;
    Atomics.add(hdr, H.READ, drop);
    Atomics.add(hdr, H.OVERRUN_SAMPLES, drop);
    Atomics.add(hdr, H.OVERRUN_EVENTS, 1);
    Atomics.add(hdr, H.DROPPED_BLOCKS, 1);
  }
  let idx = w & mask;
  const first = n < cap - idx ? n : cap - idx;
  for (let i = 0; i < first; i++) samples[idx + i] = src[i];
  for (let i = first; i < n; i++) samples[i - first] = src[i];
  if (processUs) Atomics.store(hdr, H.PROCESS_US, processUs | 0);
  if (budgetUs > 0 && processUs > budgetUs) Atomics.add(hdr, H.DEADLINE_MISS, 1);
  if (nowCentiMs) Atomics.store(hdr, H.WRITE_TIME, nowCentiMs | 0);
  Atomics.store(hdr, H.LAST_BLOCK, n | 0);
  Atomics.add(hdr, H.WRITTEN_BLOCKS, 1);
  Atomics.add(hdr, H.SEQ, 1);
  Atomics.add(hdr, H.WRITE, n);
  return n;
}

export function readSamples(ring, dst, max = dst.length) {
  const { hdr, samples, cap, mask } = ring;
  const r = Atomics.load(hdr, H.READ);
  const w = Atomics.load(hdr, H.WRITE);
  let avail = (w - r) >>> 0;
  if (avail > cap) avail = cap;
  const n = avail < max ? avail : max;
  if (n <= 0) return 0;
  let idx = r & mask;
  const first = n < cap - idx ? n : cap - idx;
  for (let i = 0; i < first; i++) dst[i] = samples[idx + i];
  for (let i = first; i < n; i++) dst[i] = samples[i - first];
  const ok = Atomics.compareExchange(hdr, H.READ, r, r + n);
  if (ok !== r) return 0;
  return n;
}
