/**
 * Analysis worker — reads the SharedArrayBuffer ring written by
 * WavetableProcessor and posts only low-rate meter values.
 *
 * No audio I/O. The audio thread never waits on this worker.
 */
const HEADER_INTS = 16;
const HEADER_BYTES = 64;
const H_WRITE = 0;
const H_READ = 1;
const H_CAP = 2;
const H_OVERRUN_SAMPLES = 3;
const H_OVERRUN_EVENTS = 4;
const H_WRITTEN_BLOCKS = 5;
const H_DROPPED_BLOCKS = 6;
const H_WRITE_TIME = 7;
const H_PROCESS_US = 8;
const H_DEADLINE_MISS = 9;
const H_ANALYZED_BLOCKS = 10;
const H_DISPLAY_POSTS = 11;
const H_LAST_BLOCK = 14;

const DISPLAY_MS = 16;
const SCRATCH = 2048;

let hdr = null;
let samples = null;
let cap = 0;
let mask = 0;
let scratch = new Float32Array(SCRATCH);
let lastDisplay = 0;
let peakHold = 0;
let running = false;
let transferDrops = 0;
let transferGot = 0;

function attach(sab) {
  hdr = new Int32Array(sab, 0, HEADER_INTS);
  cap = Atomics.load(hdr, H_CAP);
  mask = cap - 1;
  samples = new Float32Array(sab, HEADER_BYTES, cap);
}

function readShared() {
  if (!hdr || !samples) return 0;
  const r = Atomics.load(hdr, H_READ);
  const w = Atomics.load(hdr, H_WRITE);
  let avail = (w - r) >>> 0;
  if (avail > cap) avail = cap;
  const n = avail < SCRATCH ? avail : SCRATCH;
  if (n <= 0) return 0;
  let idx = r & mask;
  const first = n < cap - idx ? n : cap - idx;
  for (let i = 0; i < first; i++) scratch[i] = samples[idx + i];
  for (let i = first; i < n; i++) scratch[i] = samples[i - first];
  const ok = Atomics.compareExchange(hdr, H_READ, r, r + n);
  if (ok !== r) return 0;
  return n;
}

function analyze(buf, n) {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const x = buf[i];
    sum += x * x;
    const a = x < 0 ? -x : x;
    if (a > peak) peak = a;
  }
  const rms = n > 0 ? Math.sqrt(sum / n) : 0;
  peakHold = peak > peakHold ? peak : peakHold * 0.92;
  return { rms, peak, peakHold };
}

function postDisplay(levels, extra) {
  const now = performance.now();
  if (now - lastDisplay < DISPLAY_MS) return;
  lastDisplay = now;
  if (hdr) Atomics.add(hdr, H_DISPLAY_POSTS, 1);
  const writeTime = hdr ? Atomics.load(hdr, H_WRITE_TIME) : 0;
  const latencyMs = writeTime ? now - writeTime / 100 : 0;
  self.postMessage({
    type: "meters",
    rms: levels.rms,
    peak: levels.peak,
    peakHold: levels.peakHold,
    latencyMs,
    processUs: hdr ? Atomics.load(hdr, H_PROCESS_US) : 0,
    writtenBlocks: hdr ? Atomics.load(hdr, H_WRITTEN_BLOCKS) : extra.written || 0,
    droppedBlocks: hdr ? Atomics.load(hdr, H_DROPPED_BLOCKS) : extra.dropped || 0,
    analyzedBlocks: hdr ? Atomics.load(hdr, H_ANALYZED_BLOCKS) : extra.analyzed || 0,
    overrunEvents: hdr ? Atomics.load(hdr, H_OVERRUN_EVENTS) : 0,
    overrunSamples: hdr ? Atomics.load(hdr, H_OVERRUN_SAMPLES) : 0,
    deadlineMiss: hdr ? Atomics.load(hdr, H_DEADLINE_MISS) : 0,
    lastBlock: hdr ? Atomics.load(hdr, H_LAST_BLOCK) : nOr(extra.n),
    displayPosts: hdr ? Atomics.load(hdr, H_DISPLAY_POSTS) : 0,
    path: extra.path || "shared",
    t: now,
  });
}

function nOr(n) {
  return n || 0;
}

function pumpShared() {
  if (!running) return;
  let n = readShared();
  if (n > 0) {
    const levels = analyze(scratch, n);
    if (hdr) Atomics.add(hdr, H_ANALYZED_BLOCKS, 1);
    postDisplay(levels, { path: "shared", n });
  }
  const wait = n > 0 ? 0 : 2;
  setTimeout(pumpShared, wait);
}

self.onmessage = function (ev) {
  const data = ev.data;
  if (!data) return;
  if (data.type === "init" && data.sab) {
    attach(data.sab);
    running = true;
    pumpShared();
    return;
  }
  if (data.type === "stop") {
    running = false;
    return;
  }
  if (data.type === "block") {
    const buf = data.samples;
    const n = data.n | 0;
    transferGot++;
    const view = buf instanceof Float32Array ? buf : new Float32Array(buf);
    const levels = analyze(view, n || view.length);
    postDisplay(levels, {
      path: "transfer",
      written: transferGot,
      dropped: transferDrops,
      analyzed: transferGot,
      n: n || view.length,
    });
    self.postMessage({ type: "recycle", buffer: view.buffer }, [view.buffer]);
    return;
  }
  if (data.type === "dropped") {
    transferDrops += data.n | 1;
  }
};
