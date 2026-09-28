/**
 * Lock-free SPSC float ring in a SharedArrayBuffer.
 *
 * Layout
 * ------
 *   Int32 header[16]          64 bytes
 *   Float32 samples[capacity] capacity is a power of two
 *
 * Header
 * ------
 *   0  write            total samples published (uint32, wrapping)
 *   1  read             total samples consumed (uint32, wrapping)
 *   2  capacity
 *   3  overrunSamples   samples refused because the ring was full
 *   4  overrunEvents    times a write was refused
 *   5  writtenBlocks    process() quanta that committed samples
 *   6  droppedBlocks    quanta refused (full) or transfer-pool empty
 *   7  writeTimeCentiMs last worklet performance.now() * 100
 *   8  processUs        last quantum render time
 *   9  deadlineMiss     quanta whose render exceeded the sample budget
 *  10  analyzedBlocks   worker-consumed windows
 *  11  displayPosts     low-rate messages sent to the main thread
 *  12  seq              published write sequence
 *  13  flags            bit0 = isolated path armed
 *  14  lastBlockFrames  frames in the last committed quantum
 *  15  analyzedSamples  worker-consumed samples
 *
 * Overflow
 * --------
 * Strict SPSC: only the consumer stores `read`. If a write would exceed
 * capacity the producer refuses the block, increments overrun counters,
 * and returns 0. Audio output is independent of this tap.
 *
 * Memory ordering
 * ---------------
 * Sample stores happen-before Atomics.add(write). The reader
 * Atomics.load(write), copies, then CAS-es `read` forward.
 * A failed CAS means the reader lost the race with itself or saw a
 * torn window; it drops that copy instead of moving `read` backwards.
 */

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
  ANALYZED_SAMPLES: 15,
} as const;

export type RingViews = {
  sab: SharedArrayBuffer | ArrayBuffer;
  hdr: Int32Array;
  samples: Float32Array;
  cap: number;
  mask: number;
};

export function ringBytes(capacity: number): number {
  if (capacity < 2 || (capacity & (capacity - 1)) !== 0) {
    throw new Error("ring capacity must be a power of two");
  }
  return HEADER_BYTES + capacity * 4;
}

export function createRing(
  capacity = 32768,
  backing?: SharedArrayBuffer | ArrayBuffer,
): RingViews {
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

export function attachRing(sab: SharedArrayBuffer | ArrayBuffer): RingViews {
  const hdr = new Int32Array(sab, 0, HEADER_INTS);
  const cap = Atomics.load(hdr, H.CAP);
  if (cap < 2 || (cap & (cap - 1)) !== 0) throw new Error("invalid ring capacity");
  const samples = new Float32Array(sab, HEADER_BYTES, cap);
  return { sab, hdr, samples, cap, mask: cap - 1 };
}

export function available(hdr: Int32Array): number {
  const w = Atomics.load(hdr, H.WRITE);
  const r = Atomics.load(hdr, H.READ);
  return (w - r) >>> 0;
}

export function freeSpace(hdr: Int32Array): number {
  const cap = Atomics.load(hdr, H.CAP);
  const used = available(hdr);
  return used >= cap ? 0 : cap - used;
}

export function isEmpty(hdr: Int32Array): boolean {
  return available(hdr) === 0;
}

export function isFull(hdr: Int32Array): boolean {
  return available(hdr) >= Atomics.load(hdr, H.CAP);
}

/**
 * Copy `n` samples from `src` into the ring. Never allocates.
 * Returns frames stored, or 0 if the block would overflow.
 */
export function writeSamples(
  ring: RingViews,
  src: ArrayLike<number>,
  n: number,
  processUs = 0,
  budgetUs = 0,
  nowCentiMs = 0,
): number {
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
  for (let i = 0; i < first; i++) samples[idx + i] = src[i] as number;
  for (let i = first; i < n; i++) samples[i - first] = src[i] as number;
  if (processUs) Atomics.store(hdr, H.PROCESS_US, processUs | 0);
  if (budgetUs > 0 && processUs > budgetUs) Atomics.add(hdr, H.DEADLINE_MISS, 1);
  if (nowCentiMs) Atomics.store(hdr, H.WRITE_TIME, nowCentiMs | 0);
  Atomics.store(hdr, H.LAST_BLOCK, n | 0);
  Atomics.add(hdr, H.WRITTEN_BLOCKS, 1);
  Atomics.add(hdr, H.SEQ, 1);
  Atomics.add(hdr, H.WRITE, n);
  return n;
}

export function readSamples(
  ring: RingViews,
  dst: Float32Array,
  max = dst.length,
): number {
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

export function snapshotHeader(hdr: Int32Array) {
  return {
    write: Atomics.load(hdr, H.WRITE) >>> 0,
    read: Atomics.load(hdr, H.READ) >>> 0,
    cap: Atomics.load(hdr, H.CAP),
    overrunSamples: Atomics.load(hdr, H.OVERRUN_SAMPLES),
    overrunEvents: Atomics.load(hdr, H.OVERRUN_EVENTS),
    writtenBlocks: Atomics.load(hdr, H.WRITTEN_BLOCKS),
    droppedBlocks: Atomics.load(hdr, H.DROPPED_BLOCKS),
    writeTime: Atomics.load(hdr, H.WRITE_TIME),
    processUs: Atomics.load(hdr, H.PROCESS_US),
    deadlineMiss: Atomics.load(hdr, H.DEADLINE_MISS),
    analyzedBlocks: Atomics.load(hdr, H.ANALYZED_BLOCKS),
    displayPosts: Atomics.load(hdr, H.DISPLAY_POSTS),
    seq: Atomics.load(hdr, H.SEQ),
    lastBlock: Atomics.load(hdr, H.LAST_BLOCK),
    analyzedSamples: Atomics.load(hdr, H.ANALYZED_SAMPLES),
  };
}
