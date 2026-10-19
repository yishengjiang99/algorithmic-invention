import assert from "node:assert/strict";
import { test } from "node:test";
import { createEstimator } from "../../../public/midi-clock/estimator.js";
import { generateTrace } from "../../../public/midi-clock/synthetic.js";
import { replay, judge } from "../../../public/midi-clock/replay.js";
import { TICK_120, tickMs } from "./sim.mjs";

test("filtered: perfect 120 BPM clocks give 120 BPM and exact phase", () => {
  const e = createEstimator("filtered");
  for (let i = 0; i < 200; i++) e.push(1000 + i * TICK_120);
  assert.ok(e.ready());
  assert.ok(Math.abs(e.bpm() - 120) < 1e-9);
  // phase: position at a clock time equals that clock's index
  assert.ok(Math.abs(e.tickPosAt(1000 + 100 * TICK_120) - 100) < 1e-9);
});

test("filtered: replayed seeded trace meets the experiment thresholds", () => {
  const trace = generateTrace({ seed: 7 });
  const r = replay(createEstimator("filtered"), trace);
  const v = judge(r);
  assert.deepEqual(v, { settle: true, bpm: true, phase: true, all: true }, JSON.stringify(r));
});

test("last-interval baseline fails the same thresholds", () => {
  const trace = generateTrace({ seed: 7 });
  const v = judge(replay(createEstimator("last-interval"), trace));
  assert.equal(v.all, false);
});

test("filtered: duplicates and reordered stamps are dropped and counted", () => {
  const e = createEstimator("filtered");
  let t = 0;
  for (let i = 0; i < 100; i++) {
    t = i * TICK_120;
    e.push(t);
    if (i > 5) assert.equal(e.push(t + 0.5).accepted, false); // double delivery
  }
  assert.equal(e.stats.duplicates, 94);
  assert.equal(e.idx, 99);
  assert.ok(Math.abs(e.bpm() - 120) < 1e-6);
});

test("filtered: a missing clock advances the tick index without disturbing tempo", () => {
  const e = createEstimator("filtered");
  for (let i = 0; i < 100; i++) if (i !== 60) e.push(i * TICK_120);
  assert.equal(e.idx, 99);
  assert.equal(e.stats.gaps, 1);
  assert.ok(Math.abs(e.bpm() - 120) < 1e-6);
});

test("filtered: 120 -> 90 BPM step is detected and re-converges", () => {
  const e = createEstimator("filtered");
  let t = 0;
  for (let i = 0; i < 120; i++, t += tickMs(120)) e.push(t);
  const resyncs0 = e.stats.resyncs;
  let converged = -1;
  for (let i = 0; i < 200; i++, t += tickMs(90)) {
    e.push(t);
    if (converged < 0 && Math.abs(e.bpm() - 90) < 0.5) converged = i;
  }
  assert.ok(e.stats.resyncs > resyncs0, "tempo step counted as a resync");
  assert.ok(converged >= 0 && converged <= 24, `converged after ${converged} ticks`);
  assert.ok(Math.abs(e.bpm() - 90) < 1e-6);
  assert.equal(e.idx, 319, "tick index continues across the tempo change");
});

test("filtered: a gap longer than maxGapTicks re-anchors phase and keeps tempo", () => {
  const e = createEstimator("filtered");
  for (let i = 0; i < 100; i++) e.push(i * TICK_120);
  const before = e.stats.resyncs;
  e.push(100 * TICK_120 + 5000);
  assert.equal(e.stats.resyncs, before + 1);
  assert.ok(Math.abs(e.bpm() - 120) < 1e-6);
});

test("rebase keeps tempo, forgets phase, next clock is idx + 1", () => {
  const e = createEstimator("filtered");
  for (let i = 0; i < 100; i++) e.push(i * TICK_120);
  e.rebase();
  assert.ok(Number.isNaN(e.tickPosAt(5000)));
  e.push(10000);
  assert.equal(e.idx, 100);
  e.push(10000 + TICK_120);
  assert.ok(Math.abs(e.bpm() - 120) < 1e-6);
});

test("reset forgets everything", () => {
  const e = createEstimator("filtered");
  for (let i = 0; i < 100; i++) e.push(i * TICK_120);
  e.reset();
  assert.ok(Number.isNaN(e.bpm()));
  assert.equal(e.ready(), false);
  assert.equal(e.stats.clocks, 0);
});
