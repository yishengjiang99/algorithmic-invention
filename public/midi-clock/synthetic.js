/**
 * Deterministic synthetic MIDI clock sources (pure; no DOM, no Web APIs).
 *
 * - mulberry32: tiny seeded PRNG.
 * - generateTrace: offline trace of F8 timestamps with jitter, missing and
 *   delayed messages (used by the experiment and the tests).
 * - createSyntheticClock: live source stepped by a timer; it computes the
 *   *ideal* timestamp of every tick and emits all ticks that are due, so a
 *   throttled timer produces a burst with correct timestamps, exactly like a
 *   Web MIDI port whose events are delivered late.
 */

export const TICKS_PER_BEAT = 24;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {object} o
 * @param {number} o.seed
 * @param {number} [o.bpm=120]
 * @param {number} [o.durationMs=120000]
 * @param {number} [o.jitterMs=3]        uniform +-jitter on every timestamp
 * @param {number} [o.dropRate=0.01]     probability a clock is never delivered
 * @param {number} [o.delayEvery=64]     every Nth clock is delayed (0 = never)
 * @param {number} [o.delayMs=20]
 * @param {number} [o.duplicateRate=0]   probability a clock is delivered twice (same stamp)
 * @param {{atMs:number,bpm:number}[]} [o.tempoChanges] step changes
 * @returns {{ t: Float64Array, tick: Int32Array, trueTimes: Float64Array, startMs: number }}
 *   t = observed timestamps sorted ascending; tick = true tick number of each; trueTimes[k] = ideal time of tick k
 */
export function generateTrace(o) {
  const rnd = mulberry32(o.seed);
  const bpm0 = o.bpm ?? 120;
  const dur = o.durationMs ?? 120000;
  const jit = o.jitterMs ?? 3;
  const drop = o.dropRate ?? 0.01;
  const delayEvery = o.delayEvery ?? 64;
  const delayMs = o.delayMs ?? 20;
  const dupRate = o.duplicateRate ?? 0;
  const changes = (o.tempoChanges ?? []).slice().sort((a, b) => a.atMs - b.atMs);

  const ideal = [];
  let now = 0;
  let bpm = bpm0;
  let ci = 0;
  while (now <= dur) {
    ideal.push(now);
    while (ci < changes.length && changes[ci].atMs <= now) bpm = changes[ci++].bpm;
    now += 60000 / (bpm * TICKS_PER_BEAT);
  }
  const rows = [];
  for (let k = 0; k < ideal.length; k++) {
    const r1 = rnd();
    const r2 = rnd();
    const r3 = rnd();
    if (r1 < drop) continue;
    let t = ideal[k] + (r2 * 2 - 1) * jit;
    if (delayEvery > 0 && k % delayEvery === delayEvery - 1) t += delayMs;
    rows.push([t, k]);
    if (r3 < dupRate) rows.push([t, k]);
  }
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const t = new Float64Array(rows.length);
  const tick = new Int32Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    t[i] = rows[i][0];
    tick[i] = rows[i][1];
  }
  return { t, tick, trueTimes: Float64Array.from(ideal), startMs: 0 };
}

/**
 * Live synthetic clock. `emit(kind, timestamp)` is called with kind
 * "clock" | "start" | "continue" | "stop"; timestamps are in `now()`'s domain.
 * Call step() from a timer (setInterval); stop() just stops emitting clocks.
 */
export function createSyntheticClock({
  now,
  emit,
  bpm = 120,
  jitterMs = 0,
  dropRate = 0,
  seed = 1,
}) {
  const rnd = mulberry32(seed);
  const s = { bpm, jitterMs, dropRate, nextT: NaN, flowing: false, emitted: 0, dropped: 0 };
  const period = () => 60000 / (s.bpm * TICKS_PER_BEAT);
  return {
    state: s,
    /** Begin sending clocks (does not send Start). */
    startClocks(t0 = now()) {
      s.nextT = t0;
      s.flowing = true;
    },
    /** Stop sending clocks (device went quiet / unplugged). */
    stopClocks() {
      s.flowing = false;
    },
    setBpm(v) {
      s.bpm = v;
    },
    setJitter(v) {
      s.jitterMs = v;
    },
    setDropRate(v) {
      s.dropRate = v;
    },
    send(kind) {
      emit(kind, now());
    },
    /** Emit every clock whose ideal time has passed. */
    step() {
      if (!s.flowing) return 0;
      const t = now();
      let n = 0;
      while (s.nextT <= t) {
        const ideal = s.nextT;
        s.nextT += period();
        if (rnd() < s.dropRate) {
          s.dropped++;
          continue;
        }
        emit("clock", ideal + (rnd() * 2 - 1) * s.jitterMs);
        s.emitted++;
        n++;
      }
      return n;
    },
  };
}
