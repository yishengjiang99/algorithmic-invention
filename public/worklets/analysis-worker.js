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
const H_ANALYZED_SAMPLES = 15;

const DISPLAY_MS = 16;
const SCRATCH = 2048;

let hdr = null;
let samples = null;
let stamps = null;
let cap = 0;
let mask = 0;
const scratch = new Float32Array(SCRATCH);
let lastDisplay = 0;
let peakHold = 0;
let running = false;
let workletOrigin = 0;
let transferDrops = 0;
let transferGot = 0;
let transferSamples = 0;
let transferDroppedSamples = 0;
let transferMiss = 0;
let transferProcessUs = 0;
let transferDisplayPosts = 0;

function wallNow() {
  return performance.timeOrigin + performance.now();
}

function attach(sab) {
  hdr = new Int32Array(sab, 0, HEADER_INTS);
  cap = Atomics.load(hdr, H_CAP);
  mask = cap - 1;
  samples = new Float32Array(sab, HEADER_BYTES, cap);
  stamps = new Int32Array(sab, HEADER_BYTES + cap * 4, cap);
}

function readShared() {
  if (!hdr || !samples) return { n: 0, stamp: 0 };
  const r = Atomics.load(hdr, H_READ);
  const w = Atomics.load(hdr, H_WRITE);
  const availRaw = (w - r) >>> 0;
  const avail = availRaw > cap ? cap : availRaw;
  const n = avail < SCRATCH ? avail : SCRATCH;
  if (n <= 0) return { n: 0, stamp: 0 };
  const idx = r & mask;
  const first = n < cap - idx ? n : cap - idx;
  for (let i = 0; i < first; i++) scratch[i] = samples[idx + i];
  for (let i = first; i < n; i++) scratch[i] = samples[i - first];
  const stamp = stamps ? stamps[idx] : 0;
  const ok = Atomics.compareExchange(hdr, H_READ, r, r + n);
  if (ok !== r) return { n: 0, stamp: 0 };
  Atomics.add(hdr, H_ANALYZED_SAMPLES, n);
  Atomics.add(hdr, H_ANALYZED_BLOCKS, 1);
  return { n, stamp };
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

function sharedLatencyMs(stampCenti) {
  if (!workletOrigin) return 0;
  const centi = stampCenti || 0;
  if (!centi) return 0;
  const producedWall = workletOrigin + centi / 100;
  const lag = wallNow() - producedWall;
  return lag > 0 ? lag : 0;
}

function postDisplay(levels, extra) {
  const now = performance.now();
  if (now - lastDisplay < DISPLAY_MS && !extra.force) return;
  lastDisplay = now;
  const shared = extra.path === "shared" && hdr;
  if (shared) Atomics.add(hdr, H_DISPLAY_POSTS, 1);
  else transferDisplayPosts += 1;
  const committed = shared ? Atomics.load(hdr, H_WRITE) >>> 0 : transferSamples;
  const refused = shared ? Atomics.load(hdr, H_OVERRUN_SAMPLES) : transferDroppedSamples;
  self.postMessage({
    type: "meters",
    path: extra.path || "shared",
    rms: levels.rms,
    peak: levels.peak,
    peakHold: levels.peakHold,
    latencyMs: extra.latencyMs != null ? extra.latencyMs : sharedLatencyMs(extra.stamp),
    processUs: extra.processUs != null ? extra.processUs : shared ? Atomics.load(hdr, H_PROCESS_US) : transferProcessUs,
    writtenBlocks: shared ? Atomics.load(hdr, H_WRITTEN_BLOCKS) : transferGot,
    droppedBlocks: shared ? Atomics.load(hdr, H_DROPPED_BLOCKS) : transferDrops,
    analyzedBlocks: shared ? Atomics.load(hdr, H_ANALYZED_BLOCKS) : transferGot,
    producedSamples: committed + refused,
    consumedSamples: shared ? Atomics.load(hdr, H_ANALYZED_SAMPLES) : transferSamples,
    droppedSamples: refused,
    overrunEvents: shared ? Atomics.load(hdr, H_OVERRUN_EVENTS) : transferDrops,
    deadlineMiss: shared ? Atomics.load(hdr, H_DEADLINE_MISS) : transferMiss,
    lastBlock: extra.n || (shared ? Atomics.load(hdr, H_LAST_BLOCK) : 0),
    displayPosts: shared ? Atomics.load(hdr, H_DISPLAY_POSTS) : transferDisplayPosts,
    t: now,
  });
}

function pumpShared() {
  if (!running) return;
  const got = readShared();
  if (got.n > 0) postDisplay(analyze(scratch, got.n), { path: "shared", n: got.n, stamp: got.stamp });
  setTimeout(pumpShared, got.n > 0 ? 0 : 2);
}

self.onmessage = function (ev) {
  const data = ev.data;
  if (!data) return;
  if (data.type === "init" && data.sab) {
    attach(data.sab);
    if (typeof data.workletOrigin === "number") workletOrigin = data.workletOrigin;
    running = true;
    pumpShared();
    return;
  }
  if (data.type === "clock" && typeof data.timeOrigin === "number") {
    workletOrigin = data.timeOrigin;
    return;
  }
  if (data.type === "stop") {
    running = false;
    return;
  }
  if (data.type === "block") {
    const buf = data.samples;
    const n = data.n | 0;
    transferGot += 1;
    transferSamples += n;
    if (data.processUs) transferProcessUs = data.processUs;
    if (data.missed) transferMiss += data.missed | 0;
    const view = buf instanceof Float32Array ? buf : new Float32Array(buf);
    const frames = n || view.length;
    const producerWall =
      typeof data.timeOrigin === "number" && typeof data.t0 === "number"
        ? data.timeOrigin + data.t0
        : 0;
    const latencyMs = producerWall ? Math.max(0, wallNow() - producerWall) : 0;
    postDisplay(analyze(view, frames), {
      path: "transfer",
      n: frames,
      latencyMs,
      processUs: data.processUs || 0,
      force: false,
    });
    self.postMessage({ type: "recycle", buffer: view.buffer }, [view.buffer]);
    return;
  }
  if (data.type === "dropped") {
    transferDrops += data.n | 1;
    transferDroppedSamples += data.samples | 0;
    if (data.missed) transferMiss += data.missed | 0;
  }
};
