import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Kind,
  State,
  WATCHDOG_MS,
  DEFAULT_LOST_TIMEOUT_MS,
} from "../../../public/midi-clock/transport.js";
import { feedClocks, newTransport, TICK_120, tickMs } from "./sim.mjs";

/** Poll the watchdog every WATCHDOG_MS from `from` until it fires; returns detection time or NaN. */
function pollUntilLost(tr, from, limit = 2000) {
  for (let t = from; t <= from + limit; t += WATCHDOG_MS) if (tr.poll(t)) return t;
  return NaN;
}

function warm(extra = {}) {
  const w = newTransport(extra);
  const t = feedClocks(w.tr, 0, 100); // 100 clocks, no transport message yet
  return { ...w, t };
}

test("clocks alone: idle -> stopped; BPM reported; not running", () => {
  const { tr, estimator } = newTransport();
  assert.equal(tr.state, State.IDLE);
  feedClocks(tr, 0, 60);
  assert.equal(tr.state, State.STOPPED);
  assert.ok(Math.abs(estimator.bpm() - 120) < 1e-9);
  assert.ok(Number.isNaN(tr.beatPhaseAt(1000)));
});

test("start: armed until the next clock, which is song tick 0", () => {
  const { tr, t } = warm();
  tr.handle(Kind.START, t - 1);
  assert.equal(tr.state, State.ARMED);
  assert.equal(tr.runId, 1);
  const snap = tr.snapshot();
  // armed with a ready estimator: first beat predicted at the next clock
  assert.ok(Number.isFinite(snap.anchorSongTick));
  assert.ok(Math.abs(snap.anchorTime + (0 - snap.anchorSongTick) * snap.periodMs - t) < 1e-6);
  tr.handle(Kind.CLOCK, t);
  assert.equal(tr.state, State.RUNNING);
  assert.ok(Math.abs(tr.songTickAt(t)) < 1e-6);
  assert.ok(Math.abs(tr.songTickAt(t + 12 * TICK_120) - 12) < 1e-6);
  assert.ok(Math.abs(tr.beatPhaseAt(t + 12 * TICK_120) - 0.5) < 1e-6);
  const ph = tr.beatPhaseAt(t + 24 * TICK_120);
  assert.ok(Math.min(ph, 1 - ph) < 1e-6, `phase at the next beat is 0, got ${ph}`);
});

test("start from a cold estimator still runs (tick 0 = first clock, not ready yet)", () => {
  const { tr } = newTransport();
  tr.handle(Kind.START, 0);
  assert.equal(tr.state, State.ARMED);
  assert.ok(Number.isNaN(tr.snapshot().anchorSongTick), "no prediction without a tempo");
  feedClocks(tr, 5, 3);
  assert.equal(tr.state, State.RUNNING);
});

test("stop: running -> stopped, position kept; clocks keep tracking tempo", () => {
  const { tr, t } = warm();
  tr.handle(Kind.START, t - 1);
  let tt = feedClocks(tr, t, 30); // ticks 0..29 played
  tr.handle(Kind.STOP, tt);
  assert.equal(tr.state, State.STOPPED);
  assert.equal(tr.resumeTick, 30);
  tt = feedClocks(tr, tt, 10); // clocks continue while stopped
  assert.equal(tr.state, State.STOPPED);
  assert.equal(tr.resumeTick, 30, "stopped clocks do not advance song position");
  assert.ok(Number.isNaN(tr.songTickAt(tt)));
});

test("stop then silence is not sync loss (device may stop sending clocks)", () => {
  const { tr, t } = warm();
  tr.handle(Kind.START, t - 1);
  const tt = feedClocks(tr, t, 30);
  tr.handle(Kind.STOP, tt);
  assert.ok(Number.isNaN(pollUntilLost(tr, tt, 5000)));
  assert.equal(tr.state, State.STOPPED);
  assert.equal(tr.lostCount, 0);
});

test("continue: resumes at the stopped position, same run, even if clocks paused", () => {
  const { tr, t } = warm();
  tr.handle(Kind.START, t - 1);
  let tt = feedClocks(tr, t, 50); // ticks 0..49
  tr.handle(Kind.STOP, tt);
  tt += 10_000; // long silence: no clocks while stopped
  tr.handle(Kind.CONTINUE, tt);
  assert.equal(tr.state, State.ARMED);
  assert.equal(tr.runId, 1, "continue keeps the run");
  tr.handle(Kind.CLOCK, tt + 3);
  assert.equal(tr.state, State.RUNNING);
  assert.ok(Math.abs(tr.songTickAt(tt + 3) - 50) < 1e-6, "first clock after continue is tick 50");
  feedClocks(tr, tt + 3 + TICK_120, 5);
  assert.ok(Math.abs(tr.songTickAt(tt + 3 + 5 * TICK_120) - 55) < 1e-6);
});

test("continue with clocks flowing during the stop: position still resumes, not skips", () => {
  const { tr, t } = warm();
  tr.handle(Kind.START, t - 1);
  let tt = feedClocks(tr, t, 47); // ticks 0..46
  tr.handle(Kind.STOP, tt);
  tt = feedClocks(tr, tt, 20); // 20 stopped clocks
  tr.handle(Kind.CONTINUE, tt - 1);
  tr.handle(Kind.CLOCK, tt);
  assert.ok(Math.abs(tr.songTickAt(tt) - 47) < 1e-6);
  assert.ok(Math.abs(tr.songTickAt(tt + TICK_120) - 48) < 1e-6, "next tick is the beat-2 downbeat");
});

test("start while running restarts at tick 0 with a new run id", () => {
  const { tr, t } = warm();
  tr.handle(Kind.START, t - 1);
  let tt = feedClocks(tr, t, 40);
  tr.handle(Kind.START, tt - 1);
  assert.equal(tr.state, State.ARMED);
  assert.equal(tr.runId, 2);
  tr.handle(Kind.CLOCK, tt);
  assert.ok(Math.abs(tr.songTickAt(tt)) < 1e-6);
  tt += TICK_120;
});

test("continue while already running is ignored; stop while idle is ignored", () => {
  const { tr, t } = warm();
  tr.handle(Kind.START, t - 1);
  tr.handle(Kind.CLOCK, t);
  assert.equal(tr.handle(Kind.CONTINUE, t + 1), false);
  assert.equal(tr.state, State.RUNNING);
  const fresh = newTransport().tr;
  assert.equal(fresh.handle(Kind.STOP, 0), false);
  assert.equal(fresh.state, State.IDLE);
});

test("missing clocks (3 in a row, below the timeout): still running, song position intact", () => {
  const { tr, t } = warm();
  tr.handle(Kind.START, t - 1);
  let tt = feedClocks(tr, t, 40); // ticks 0..39, next is 40 at tt
  tt += 3 * TICK_120; // ticks 40,41,42 never arrive
  tr.handle(Kind.CLOCK, tt); // tick 43
  assert.equal(tr.state, State.RUNNING);
  assert.ok(Math.abs(tr.songTickAt(tt) - 43) < 1e-6, "missing ticks advance position");
  assert.equal(tr.estimator.stats.gaps, 1);
  assert.equal(pollUntilLost(tr, tt, 100), NaN);
  assert.equal(tr.lostCount, 0);
});

test("1% random missing clocks never trip the watchdog", () => {
  const { tr, t } = warm();
  tr.handle(Kind.START, t - 1);
  let tt = t;
  for (let i = 0; i < 2000; i++, tt += TICK_120) {
    if (i % 100 === 37) continue;
    tr.handle(Kind.CLOCK, tt);
    tr.poll(tt + 1);
  }
  assert.equal(tr.lostCount, 0);
  assert.equal(tr.state, State.RUNNING);
});

test("clock loss: declared by the watchdog within 500 ms of the last clock", () => {
  const { tr, t } = warm();
  tr.handle(Kind.START, t - 1);
  const tt = feedClocks(tr, t, 40);
  const last = tt - TICK_120;
  const detected = pollUntilLost(tr, last + 1);
  assert.ok(Number.isFinite(detected));
  const latency = detected - last;
  assert.ok(latency > DEFAULT_LOST_TIMEOUT_MS, "not before the timeout");
  assert.ok(latency <= DEFAULT_LOST_TIMEOUT_MS + 2 * WATCHDOG_MS, `latency ${latency}`);
  assert.ok(latency < 500);
  assert.equal(tr.state, State.LOST);
  assert.equal(tr.lostFrom, State.RUNNING);
  assert.equal(tr.lostCount, 1);
  assert.equal(tr.poll(detected + 25), false, "lost is reported once");
});

test("clock loss holds at every tempo from 30 to 300 BPM within 500 ms", () => {
  for (const bpm of [30, 60, 90, 120, 180, 300]) {
    const { tr } = newTransport();
    let t = 0;
    for (let i = 0; i < 100; i++, t += tickMs(bpm)) tr.handle(Kind.CLOCK, t);
    tr.handle(Kind.START, t - 1);
    for (let i = 0; i < 40; i++, t += tickMs(bpm)) tr.handle(Kind.CLOCK, t);
    const last = t - tickMs(bpm);
    const detected = pollUntilLost(tr, last + 1);
    assert.ok(detected - last < 500, `${bpm} BPM latency ${detected - last}`);
    // and a gap of 3 ticks at the slowest tempo (250 ms) is not yet loss
  }
  const { tr } = newTransport();
  let t = 0;
  for (let i = 0; i < 100; i++, t += tickMs(30)) tr.handle(Kind.CLOCK, t);
  tr.handle(Kind.START, t - 1);
  for (let i = 0; i < 10; i++, t += tickMs(30)) tr.handle(Kind.CLOCK, t);
  assert.equal(
    tr.poll(t - tickMs(30) + 2 * tickMs(30)),
    false,
    "two missing ticks at 30 BPM is fine",
  );
});

test("after loss a returning clock gives stopped; Continue resumes the held position", () => {
  const { tr, t } = warm();
  tr.handle(Kind.START, t - 1);
  let tt = feedClocks(tr, t, 40);
  const detected = pollUntilLost(tr, tt);
  assert.equal(tr.state, State.LOST);
  assert.equal(tr.resumeTick, 40);
  tt = detected + 400;
  tr.handle(Kind.CLOCK, tt);
  assert.equal(tr.state, State.STOPPED);
  tr.handle(Kind.CONTINUE, tt + 1);
  tr.handle(Kind.CLOCK, tt + TICK_120);
  assert.equal(tr.state, State.RUNNING);
  assert.ok(Math.abs(tr.songTickAt(tt + TICK_120) - 40) < 1e-6);
});

test("start with no clocks ever arriving is reported lost", () => {
  const { tr } = newTransport();
  tr.handle(Kind.START, 1000);
  assert.equal(tr.poll(1200), false);
  assert.equal(tr.poll(1000 + DEFAULT_LOST_TIMEOUT_MS + 1), true);
  assert.equal(tr.lostFrom, State.ARMED);
});

test("stopped with clocks flowing and no transport message that go silent is loss", () => {
  const { tr, t } = warm();
  assert.equal(tr.state, State.STOPPED);
  const detected = pollUntilLost(tr, t);
  assert.ok(detected - (t - TICK_120) < 500);
  assert.equal(tr.state, State.LOST);
});

test("duplicated clocks (every clock delivered twice) do not advance position or tempo", () => {
  const { tr, t } = warm();
  tr.handle(Kind.START, t - 1);
  let tt = t;
  for (let i = 0; i < 100; i++, tt += TICK_120) {
    tr.handle(Kind.CLOCK, tt);
    tr.handle(Kind.CLOCK, tt);
    tr.handle(Kind.CLOCK, tt + 0.3);
  }
  assert.equal(tr.state, State.RUNNING);
  assert.equal(tr.estimator.stats.duplicates, 200);
  assert.ok(Math.abs(tr.songTickAt(tt - TICK_120) - 99) < 1e-6);
  assert.ok(Math.abs(tr.estimator.bpm() - 120) < 1e-6);
});

test("120 -> 90 BPM change while running: stays running, position recovers, BPM converges", () => {
  const { tr, t } = warm();
  tr.handle(Kind.START, t - 1);
  let tt = feedClocks(tr, t, 100); // ticks 0..99
  let tick = 100;
  let convergedAfterMs = -1;
  const tChange = tt;
  let worst = 0;
  for (let i = 0; i < 200; i++, tt += tickMs(90), tick++) {
    tr.handle(Kind.CLOCK, tt);
    tr.poll(tt);
    const err = Math.abs(tr.songTickAt(tt) - tick);
    // Until the step is detected (8 consecutive off-tempo spans) the old tempo is
    // extrapolated, so position drifts by a third of a tick per clock.
    if (i < 12) worst = Math.max(worst, err);
    else assert.ok(err < 1e-6, `tick ${tick}: position error ${err} after detection`);
    if (convergedAfterMs < 0 && Math.abs(tr.estimator.bpm() - 90) < 0.5)
      convergedAfterMs = tt - tChange;
  }
  assert.ok(worst < 3, `transient error ${worst} ticks`);
  assert.equal(tr.state, State.RUNNING);
  assert.equal(tr.lostCount, 0);
  assert.ok(
    convergedAfterMs >= 0 && convergedAfterMs < 400,
    `converged after ${convergedAfterMs} ms`,
  );
  assert.ok(Math.abs(tr.estimator.bpm() - 90) < 1e-6);
});

test("device disconnection: reported at once, input ignored, no loss spam", () => {
  const { tr, t } = warm();
  tr.handle(Kind.START, t - 1);
  let tt = feedClocks(tr, t, 40);
  assert.equal(tr.handle(Kind.DISCONNECT, tt), true);
  assert.equal(tr.state, State.DISCONNECTED);
  assert.equal(tr.handle(Kind.CLOCK, tt + 10), false, "late clock from a dead port is ignored");
  assert.equal(tr.ignoredWhileDisconnected, 1);
  assert.ok(Number.isNaN(pollUntilLost(tr, tt, 3000)), "watchdog is quiet while disconnected");
  assert.equal(tr.lostCount, 0);
  assert.equal(tr.handle(Kind.START, tt + 20), false, "transport messages ignored too");
});

test("reconnect: fresh estimator, idle -> stopped on clocks, start runs again", () => {
  const { tr, t, estimator } = warm();
  tr.handle(Kind.START, t - 1);
  let tt = feedClocks(tr, t, 40);
  tr.handle(Kind.DISCONNECT, tt);
  assert.equal(estimator.stats.clocks, 0, "estimator reset on disconnect");
  tr.handle(Kind.CONNECT, tt + 1000);
  assert.equal(tr.state, State.IDLE);
  tt = feedClocks(tr, tt + 1000, 60);
  assert.equal(tr.state, State.STOPPED);
  assert.ok(Math.abs(estimator.bpm() - 120) < 1e-9);
  tr.handle(Kind.START, tt - 1);
  tr.handle(Kind.CLOCK, tt);
  assert.equal(tr.state, State.RUNNING);
  assert.equal(tr.runId, 2);
  assert.ok(Math.abs(tr.songTickAt(tt)) < 1e-6);
});

test("repeated disconnect/connect cycles are idempotent and leave one consistent state", () => {
  const { tr, t } = warm();
  let tt = t;
  for (let i = 0; i < 20; i++) {
    tr.handle(Kind.DISCONNECT, tt);
    tr.handle(Kind.DISCONNECT, tt + 1); // double disconnect
    tr.handle(Kind.CONNECT, tt + 2);
    tr.handle(Kind.CONNECT, tt + 3); // double connect is a no-op
    tt = feedClocks(tr, tt + 4, 30);
    assert.equal(tr.state, State.STOPPED);
  }
  assert.equal(tr.lostCount, 0);
  assert.ok(Math.abs(tr.estimator.bpm() - 120) < 1e-9);
});

test("transitions are reported once each, in order", () => {
  const { tr, t, transitions } = warm();
  transitions.length = 0;
  tr.handle(Kind.START, t - 1);
  tr.handle(Kind.CLOCK, t);
  tr.handle(Kind.STOP, t + 1);
  tr.handle(Kind.STOP, t + 2);
  assert.deepEqual(
    transitions.map(([a, b]) => `${a}>${b}`),
    ["stopped>armed", "armed>running", "running>stopped"],
  );
});
