/**
 * Teardown and allocation audit: the AudioWorklet render loop and the Worker.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLICK_SRC, loadProcessor } from "./sim.mjs";
import { Kind } from "../../../public/midi-clock/transport.js";
import { SNAP } from "../../../public/midi-clock/protocol.js";
import { STATE_CODES } from "../../../public/midi-clock/transport.js";

const PER_BLOCK_LIMIT_BYTES = 48;

/** Source text of process() in click-processor.js. */
function processBody() {
  const start = CLICK_SRC.indexOf("  process(");
  assert.ok(start > 0, "process() found");
  const open = CLICK_SRC.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < CLICK_SRC.length; i++) {
    if (CLICK_SRC[i] === "{") depth++;
    else if (CLICK_SRC[i] === "}" && --depth === 0) return CLICK_SRC.slice(open, i + 1);
  }
  throw new Error("unbalanced process()");
}

test("process(): static audit, no allocating constructs in the render loop", () => {
  const body = processBody().replace(/\/\/.*$/gm, "");
  const banned = [
    [/\bnew\s/, "new"],
    [/=>/, "arrow function / closure"],
    [/\bfunction\b/, "function expression"],
    [/`/, "template literal"],
    [/(^|[=(,:?&|!+\-*/%<>{;])\s*\[/m, "array literal"],
    [/\breturn\s*\[/, "returned array literal"],
    [/(=|\(|,|return)\s*\{/, "object literal"],
    [/\.\.\./, "spread"],
    [/["']/, "string literal"],
    [
      /\.(map|filter|slice|concat|splice|forEach|reduce|push|join|from|of|fill)\s*\(/,
      "allocating array method",
    ],
    [
      /\b(Array|Object|String|JSON|Float32Array|Float64Array|Int32Array|Uint8Array)\b/,
      "constructor / builtin object",
    ],
    [/\bfor\s*\(\s*(const|let)\s+\w+\s+of\b/, "for...of iterator"],
  ];
  for (const [re, what] of banned) {
    assert.ok(!re.test(body), `process() contains ${what}: ${re}`);
  }
});

/**
 * Bytes allocated on the V8 heap while running fn(), estimated by summing the
 * positive steps of heapUsed sampled every `every` iterations. A full GC would
 * hide short-lived garbage, so none is run inside the measured window.
 */
function allocatedBytes(iterations, every, step) {
  let prev = process.memoryUsage().heapUsed;
  let total = 0;
  for (let i = 0; i < iterations; i++) {
    step(i);
    if (i % every === every - 1) {
      const cur = process.memoryUsage().heapUsed;
      if (cur > prev) total += cur - prev;
      prev = cur;
    }
  }
  return total;
}

test("process(): no allocation over 200k blocks (about 9 minutes of audio), clicks firing", () => {
  const p = loadProcessor({ record: false });
  let frame = 0;
  // queue 30 minutes of 120 BPM clicks up front (ring is 64 deep, so refill between windows)
  let key = 1;
  let nextBeat = 0;
  const refill = (upToFrame) => {
    while (nextBeat < upToFrame && p.proc.qLen < 60) {
      p.send([1, key++, nextBeat / 48000]);
      nextBeat += 24000;
    }
  };
  const windowBlocks = 2000;
  let measured = 0;
  let blocks = 0;
  for (let w = 0; w < 100; w++) {
    refill(frame + 128 * windowBlocks);
    if (w === 0) for (let i = 0; i < 4000; i++, frame += 128) p.block(frame); // warm-up
    measured += allocatedBytes(windowBlocks, 250, () => {
      p.block(frame);
      frame += 128;
    });
    blocks += windowBlocks;
  }
  assert.ok(p.proc.fired > 500, `clicks fired: ${p.proc.fired}`);
  assert.equal(p.counter.posted, p.proc.fired, "one message per click, never per block");
  // The harness itself and V8's tier-up cost a few bytes per block (about 10 measured);
  // any real per-block allocation (an array, an object, a typed array) is far above the limit.
  const perBlock = measured / blocks;
  assert.ok(
    perBlock < PER_BLOCK_LIMIT_BYTES,
    `${perBlock.toFixed(1)} bytes per block (${measured} total over ${blocks} blocks)`,
  );
});

test("the allocation measurement is able to see a per-block allocation (self-check)", () => {
  const sink = [];
  const n = 40000;
  const bytes = allocatedBytes(n, 250, (i) => {
    sink[i % 4] = { a: i, b: i + 0.5, c: i + 0.25 }; // one small object per "block"
  });
  assert.ok(
    bytes / n >= PER_BLOCK_LIMIT_BYTES,
    `measured only ${(bytes / n).toFixed(1)} bytes per iteration`,
  );
});

test("click output: silent until a click, click is bounded and decays", () => {
  const p = loadProcessor();
  p.send([1, 1, 0.01]);
  let peak = 0;
  let tailPeak = 0;
  let silentBefore = true;
  for (let i = 0; i < 40; i++) {
    const out = p.block(i * 128);
    const start = i * 128;
    for (let j = 0; j < 128; j++) {
      const a = Math.abs(out[j]);
      if (!Number.isFinite(out[j])) assert.fail("non-finite sample");
      if (start + j < 480 && a !== 0) silentBefore = false;
      if (a > peak) peak = a;
      if (start + j > 480 + 1440 && a > tailPeak) tailPeak = a;
    }
  }
  assert.ok(silentBefore, "no output before the scheduled frame (480)");
  assert.ok(peak > 0.1 && peak <= 0.81, `peak ${peak}`);
  assert.ok(tailPeak === 0, "click ends after 30 ms");
});

/* ---------- Worker teardown ---------- */

test("follower worker: one watchdog, loss reported < 500 ms, close() releases everything", async () => {
  const timers = new Set();
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = (...a) => {
    const id = realSet(...a);
    timers.add(id);
    return id;
  };
  globalThis.clearInterval = (id) => {
    timers.delete(id);
    return realClear(id);
  };
  const posted = [];
  let closed = 0;
  globalThis.self = {
    onmessage: null,
    postMessage: (m) => posted.push(m),
    close: () => closed++,
  };
  try {
    await import("../../../public/midi-clock/follower-worker.js");
    const send = (data) => globalThis.self.onmessage({ data });
    const mainOrigin = performance.timeOrigin;
    send({ type: "init", estimator: "filtered", lostTimeoutMs: 250, mainTimeOrigin: mainOrigin });
    send({ type: "init", estimator: "filtered", lostTimeoutMs: 250, mainTimeOrigin: mainOrigin });
    assert.equal(timers.size, 1, "re-init replaced the watchdog instead of stacking a second");

    // 60 perfect clocks ending now, then silence
    const now = performance.now();
    const per = 60000 / (120 * 24);
    const ev = [];
    for (let i = 59; i >= 0; i--) ev.push(Kind.CLOCK, now - i * per);
    send(Float64Array.from(ev));
    const last = now;
    const stateOf = (a) => STATE_CODES[a[SNAP.STATE]];
    const snaps = () => posted.filter((m) => m instanceof Float64Array);
    assert.equal(stateOf(snaps().at(-1)), "stopped");
    assert.ok(Math.abs(snaps().at(-1)[SNAP.BPM] - 120) < 1e-6);

    await new Promise((r) => setTimeout(r, 420));
    const lostSnap = snaps().find((a) => stateOf(a) === "lost");
    assert.ok(lostSnap, "worker reported sync loss on its own watchdog");
    const latency = lostSnap[SNAP.NOW] - last;
    assert.ok(latency < 500, `loss reported ${latency.toFixed(1)} ms after the last clock`);
    assert.ok(latency >= 250, `not before the timeout (${latency.toFixed(1)} ms)`);

    const before = posted.length;
    send({ type: "close" });
    assert.equal(timers.size, 0, "watchdog interval cleared");
    assert.equal(closed, 1, "self.close() called");
    assert.deepEqual(posted.at(-1), { type: "closed" });
    send(Float64Array.from([Kind.CLOCK, performance.now()]));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(posted.length, before + 1, "nothing is posted after close");
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
    delete globalThis.self;
  }
});
