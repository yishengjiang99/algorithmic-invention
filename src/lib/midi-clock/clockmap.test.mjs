import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createClockMap,
  toAudioTime,
  toPerfMs,
  workerToMainMs,
} from "../../../public/midi-clock/clockmap.js";
import { mulberry32 } from "../../../public/midi-clock/synthetic.js";

test("performance.now ms <-> AudioContext seconds round-trips through the offset", () => {
  const off = 12.5 - 40_000 / 1000; // contextTime 12.5 s at performance.now 40 s
  assert.equal(toAudioTime(40_000, off), 12.5);
  assert.equal(toAudioTime(40_500, off), 13);
  assert.ok(Math.abs(toPerfMs(13, off) - 40_500) < 1e-9);
});

test("worker clock converts to the main thread's performance.now domain", () => {
  // main realm started at epoch 1_000_000 ms, worker realm 250 ms later
  assert.equal(workerToMainMs(100, 1_000_250, 1_000_000), 350);
});

test("median offset rejects jittery output-timestamp pairs and tracks the true offset", () => {
  const rnd = mulberry32(5);
  const trueOffset = -37.25;
  const map = createClockMap(16);
  for (let i = 0; i < 40; i++) {
    const perf = 1000 + i * 100;
    const jitterMs = (rnd() - 0.5) * 20; // +-10 ms jitter on the pair
    const spike = i % 9 === 4 ? 80 : 0; // occasional bad pair
    map.add(perf / 1000 + trueOffset + (jitterMs + spike) / 1000, perf);
  }
  assert.ok(Math.abs(map.offset() - trueOffset) < 0.005, `offset ${map.offset()}`);
  assert.ok(Math.abs(map.toAudio(5000) - (5 + trueOffset)) < 0.005);
});

test("drift between the clocks is followed: 50 ppm over 60 s stays within the window lag", () => {
  const map = createClockMap(16);
  let worst = 0;
  for (let i = 0; i < 600; i++) {
    const perfMs = 1000 + i * 100;
    const ctx = (perfMs / 1000) * (1 + 50e-6); // audio clock runs 50 ppm fast
    map.add(ctx, perfMs);
    const truth = (perfMs / 1000) * (1 + 50e-6);
    worst = Math.max(worst, Math.abs(map.toAudio(perfMs) - truth));
  }
  assert.ok(worst < 0.0002, `worst error ${worst * 1000} ms`);
});

test("(0,0) and non-finite pairs (audio clock not started) are ignored", () => {
  const map = createClockMap();
  assert.equal(map.add(0, 0), false);
  assert.equal(map.add(NaN, 5), false);
  assert.equal(map.count, 0);
  assert.ok(Number.isNaN(map.offset()));
  map.add(1, 500);
  assert.equal(map.count, 1);
});
