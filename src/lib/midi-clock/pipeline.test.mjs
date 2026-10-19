import assert from "node:assert/strict";
import { test } from "node:test";
import { Kind, State } from "../../../public/midi-clock/transport.js";
import { KEY_BEAT_MOD, makeKey } from "../../../public/midi-clock/scheduler.js";
import { generateTrace } from "../../../public/midi-clock/synthetic.js";
import { clockEvents, loadProcessor, runPipeline, sortEvents } from "./sim.mjs";

const BEAT = 500;
const beatOf = (k) => k % KEY_BEAT_MOD;
const runOf = (k) => Math.floor(k / KEY_BEAT_MOD);

/** Assert: no duplicate keys, consecutive beats inside each run, 500 ms spacing. */
function assertCleanBeats(clicks, { tolMs = 0.1, spacing = true } = {}) {
  const keys = new Set(clicks.map((c) => c.key));
  assert.equal(keys.size, clicks.length, "duplicate beat keys fired");
  for (let i = 1; i < clicks.length; i++) {
    const a = clicks[i - 1];
    const b = clicks[i];
    if (runOf(a.key) !== runOf(b.key)) continue;
    assert.ok(b.key > a.key, "keys increase");
    // a click that fired late (the Start downbeat) has no meaningful spacing to its successor
    if (spacing && a.frame === a.scheduledFrame && beatOf(b.key) === beatOf(a.key) + 1) {
      assert.ok(Math.abs(b.atMs - a.atMs - BEAT) < tolMs, `spacing ${b.atMs - a.atMs}`);
    }
  }
}

test("120 BPM for 120 s, perfect clocks: 240 beats, none duplicated, none skipped", () => {
  const events = sortEvents([
    ...clockEvents({ from: 0, to: 125_000 }),
    { at: 2_000, kind: Kind.START },
  ]);
  const r = runPipeline({ events, endMs: 122_000 });
  assert.equal(r.tr.state, State.RUNNING);
  const beats = r.clicks.map((c) => beatOf(c.key));
  assert.equal(beats[0], 0);
  beats.forEach((b, i) => assert.equal(b, i, "consecutive beat numbers"));
  assert.ok(beats.length >= 239 && beats.length <= 241, `n=${beats.length}`);
  assertCleanBeats(r.clicks, { tolMs: 0.05 });
  assert.equal(r.p.posted.at(-1)[4], 0, "processor dropped no duplicates");
  assert.equal(r.p.posted.at(-1)[5], 0, "processor dropped no late beats");
  assert.equal(r.p.proc.overflow, 0);
});

test("120 BPM for 120 s with +-3 ms jitter, 1% missing, periodic 20 ms delay: still clean", () => {
  const trace = generateTrace({ seed: 42, durationMs: 125_000 });
  const events = [{ at: 2_000, kind: Kind.START }];
  for (let i = 0; i < trace.t.length; i++)
    events.push({ at: trace.t[i], kind: Kind.CLOCK, t: trace.t[i] });
  const r = runPipeline({ events: sortEvents(events), endMs: 122_000 });
  assertCleanBeats(r.clicks, { tolMs: 5 });
  const beats = r.clicks.map((c) => beatOf(c.key));
  beats.forEach((b, i) => assert.equal(b, i));
  assert.ok(beats.length >= 238);
  assert.equal(r.lost.length, 0);
});

test("click lands on the predicted beat, sample-accurately", () => {
  const events = sortEvents([
    ...clockEvents({ from: 0, to: 20_000 }),
    { at: 2_000, kind: Kind.START },
  ]);
  const r = runPipeline({ events, endMs: 15_000 });
  const first = r.clicks[0];
  // beat b is at start-clock time + b*500 ms; the processor frame must equal the scheduled frame
  for (const c of r.clicks.slice(1))
    assert.equal(c.frame, c.scheduledFrame, "fired on the scheduled sample");
  assert.ok(first.frame - first.scheduledFrame <= 0.15 * 48000);
});

test("stop cancels queued beats; continue resumes without repeating or skipping a beat", () => {
  const events = sortEvents([
    ...clockEvents({ from: 0, to: 12_000 }),
    { at: 1_000, kind: Kind.START },
    { at: 4_450, kind: Kind.STOP }, // beat 7 (4500 ms) is already queued: stop must cancel it
    { at: 7_000, kind: Kind.CONTINUE },
  ]);
  const r = runPipeline({ events, endMs: 11_000 });
  assertCleanBeats(r.clicks, { spacing: false }); // the pause breaks 500 ms spacing by design
  const beats = r.clicks.map((c) => beatOf(c.key));
  assert.equal(new Set(beats).size, beats.length, "no beat played twice");
  for (let i = 1; i < beats.length; i++)
    assert.equal(beats[i], beats[i - 1] + 1, "no beat skipped");
  assert.ok(r.cancels.length >= 1);
  assert.ok(
    r.sent.some((x) => beatOf(x.key) === 7),
    "beat 7 was queued before the stop",
  );
  assert.equal(
    r.clicks.filter((c) => beatOf(c.key) === 7).length,
    1,
    "and played exactly once, after continue",
  );
  assert.ok(r.clicks.find((c) => beatOf(c.key) === 7).atMs > 7_000);
  // nothing clicks while stopped
  assert.ok(!r.clicks.some((c) => c.atMs > 4_460 && c.atMs < 7_000));
  assert.ok(r.clicks.some((c) => c.atMs > 7_000));
});

test("clock loss: watchdog fires within 500 ms, queued beats are cancelled, no clicks while lost", () => {
  const events = sortEvents([
    ...clockEvents({ from: 0, to: 8_000 }), // clocks die at 8 s
    { at: 1_000, kind: Kind.START },
  ]);
  const r = runPipeline({ events, endMs: 14_000 });
  assert.equal(r.lost.length, 1);
  const latency = r.lost[0].detectedAt - r.lost[0].lastClock;
  assert.ok(latency < 500, `latency ${latency}`);
  assert.ok(
    r.clicks.every((c) => c.atMs < 8_000 + 500),
    "no click after the loss is reported",
  );
  assertCleanBeats(r.clicks);
});

test("disconnect + reconnect x10: no duplicate clicks, one run per Start, state recovers", () => {
  const events = [{ at: 0, kind: Kind.CONNECT }];
  let t = 0;
  for (let i = 0; i < 10; i++) {
    events.push(...clockEvents({ from: t, to: t + 4_000 }));
    events.push({ at: t + 1_000, kind: Kind.START });
    events.push({ at: t + 4_000, kind: Kind.DISCONNECT });
    // a straggler clock from the dead port arrives after the disconnect
    events.push({ at: t + 4_005, kind: Kind.CLOCK, t: t + 4_005 });
    events.push({ at: t + 4_500, kind: Kind.CONNECT });
    t += 5_000;
  }
  events.push(...clockEvents({ from: t, to: t + 4_000 }), { at: t + 1_000, kind: Kind.START });
  const r = runPipeline({ events: sortEvents(events), endMs: t + 4_000 });
  assertCleanBeats(r.clicks);
  assert.equal(r.tr.state, State.RUNNING);
  assert.equal(r.tr.runId, 11);
  assert.equal(r.tr.lostCount, 0, "disconnect is not reported as clock loss");
  const perRun = new Map();
  for (const c of r.clicks) perRun.set(runOf(c.key), (perRun.get(runOf(c.key)) ?? 0) + 1);
  assert.equal(perRun.size, 11);
  for (const [, n] of perRun) assert.ok(n >= 4 && n <= 7, `clicks per run ${n}`);
  assert.equal(r.p.posted.at(-1)[4], 0, "processor saw no duplicate keys");
});

test("120 -> 90 BPM while running: beats follow the new tempo after the step settles", () => {
  const events = sortEvents([
    ...clockEvents({ from: 0, to: 10_000, bpm: 120 }),
    ...clockEvents({ from: 10_000, to: 25_000, bpm: 90 }),
    { at: 1_000, kind: Kind.START },
  ]);
  const r = runPipeline({ events, endMs: 24_000 });
  const late = r.clicks.filter((c) => c.atMs > 12_000);
  assert.ok(late.length >= 10);
  for (let i = 1; i < late.length; i++) {
    assert.ok(
      Math.abs(late[i].atMs - late[i - 1].atMs - 60000 / 90) < 0.1,
      `interval ${late[i].atMs - late[i - 1].atMs}`,
    );
  }
  const keys = new Set(r.clicks.map((c) => c.key));
  assert.equal(keys.size, r.clicks.length);
});

test("processor drops a repeated or older key and a click that is far too late", () => {
  const p = loadProcessor();
  p.send([1, makeKey(1, 0), 1.0]);
  p.send([1, makeKey(1, 0), 1.0]); // duplicate
  p.send([1, makeKey(1, 1), 1.5]);
  p.send([1, makeKey(1, 0), 1.2]); // older key
  assert.equal(p.proc.duplicates, 2);
  // render past both; beat 1 is scheduled but we start rendering 1 s late
  for (let f = 0; f < 3 * 48000; f += 128) p.block(f);
  assert.equal(p.proc.fired, 2);
  p.send([1, makeKey(1, 2), 1.0]); // key valid, but time long past
  p.block(3 * 48000);
  assert.equal(p.proc.lateDropped, 1);
  p.send([2]);
  assert.equal(p.proc.qLen, 0);
});
