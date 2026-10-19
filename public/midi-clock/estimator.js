/**
 * MIDI clock tempo / phase estimators (pure, no DOM, no Web APIs).
 *
 * Both estimators consume the *timestamp of each F8 clock message* in
 * milliseconds (any monotonic domain; the page uses performance.now()) and
 * expose the same interface so the Worker, the unit tests and the experiment
 * script can swap them:
 *
 *   push(t)          feed one clock timestamp -> { accepted, resynced }
 *   rebase()         keep tempo, forget phase (use after a long gap)
 *   reset()          forget everything
 *   ready()          enough clocks seen to trust bpm()/tickPosAt()
 *   bpm()            beats per minute (NaN until two clocks arrived)
 *   periodMs()       milliseconds per clock tick (NaN until known)
 *   tickPosAt(t)     estimator tick position at time t (float, ticks since
 *                    the first accepted clock; fractional part is sub-tick)
 *   anchorTime / anchorIdx   the (time, tick) pair tickPosAt extrapolates from
 *   idx              tick index of the most recent accepted clock
 *   stats            { clocks, duplicates, gaps, resyncs }
 *
 * "last-interval" is the naive baseline: BPM from the last two clocks, phase
 * from the last clock, tick index = number of messages seen.
 *
 * "filtered" is a rolling-median + phase-correction estimator:
 *   1. tick index is unwrapped from the timestamp (a 2*T gap means a missing
 *      clock, so the index advances by 2), duplicates / reordered stamps
 *      (dt < DUP_FRACTION * T) are dropped;
 *   2. period = rolling median of span estimates (t[k]-t[k-m]) / (i[k]-i[k-m]);
 *      long spans divide timestamp jitter by m, the median rejects outliers
 *      such as a single delayed message;
 *   3. phase anchor = rolling median of "where does each recent clock say the
 *      current tick is", slewed toward by PHASE_GAIN per clock, hard re-anchored
 *      if it disagrees by more than RESYNC_PHASE_MS;
 *   4. SUSTAIN consecutive 8-tick spans off by more than tempoStepFraction in
 *      the same direction are a tempo change: all but the newest SUSTAIN+1
 *      clocks are discarded and tempo/phase are re-derived from those.
 */

export const TICKS_PER_BEAT = 24;

export const DEFAULTS = Object.freeze({
  /** Timestamps kept (ring). Must exceed span + window. */
  capacity: 256,
  /** Span (ticks) of each period estimate. 48 ticks = 2 beats. */
  span: 48,
  /** Number of span estimates / offset samples the medians run over. */
  window: 48,
  /** dt below this fraction of the period is a duplicate / reordered stamp. */
  dupFraction: 0.4,
  /** Gaps longer than this many ticks re-anchor instead of unwrapping. */
  maxGapTicks: 96,
  /** Slew gain toward the median phase target, per accepted clock. */
  phaseGain: 0.25,
  /** Hard re-anchor if the phase target disagrees by more than this. */
  resyncPhaseMs: 15,
  /** Span (ticks) of the tempo-step check, and how many consecutive off-tempo checks declare a change. */
  sustain: 8,
  /** A span is "off tempo" when it deviates from the period by this fraction (> 3.6% = 6 ms jitter / 8 ticks). */
  tempoStepFraction: 0.06,
  /** Clocks needed before ready(). 48 = one second at 120 BPM. */
  readyClocks: 48,
});

/** Insertion sort over a[0..n) in place; n is small (<= window). */
function sortPrefix(a, n) {
  for (let i = 1; i < n; i++) {
    const v = a[i];
    let j = i - 1;
    while (j >= 0 && a[j] > v) {
      a[j + 1] = a[j];
      j--;
    }
    a[j + 1] = v;
  }
}

function medianOf(a, n) {
  sortPrefix(a, n);
  return n & 1 ? a[n >> 1] : 0.5 * (a[(n >> 1) - 1] + a[n >> 1]);
}

/** Naive baseline: whatever the last interval says. */
export function createLastIntervalEstimator(opts = {}) {
  const readyClocks = opts.readyClocks ?? DEFAULTS.readyClocks;
  const stats = { clocks: 0, duplicates: 0, gaps: 0, resyncs: 0 };
  let lastT = NaN;
  let dt = NaN;
  let count = 0;

  const est = {
    kind: "last-interval",
    stats,
    anchorTime: NaN,
    anchorIdx: 0,
    idx: -1,
    push(t) {
      if (count > 0) dt = t - lastT;
      lastT = t;
      count++;
      est.idx = count - 1;
      est.anchorTime = t;
      est.anchorIdx = est.idx;
      stats.clocks = count;
      return { accepted: true, resynced: false };
    },
    rebase() {},
    reset() {
      lastT = NaN;
      dt = NaN;
      count = 0;
      est.idx = -1;
      est.anchorTime = NaN;
      est.anchorIdx = 0;
      stats.clocks = stats.duplicates = stats.gaps = stats.resyncs = 0;
    },
    ready: () => count >= readyClocks,
    periodMs: () => (dt > 0 ? dt : NaN),
    bpm: () => (dt > 0 ? 60000 / (dt * TICKS_PER_BEAT) : NaN),
    tickPosAt(t) {
      return dt > 0 ? est.anchorIdx + (t - est.anchorTime) / dt : NaN;
    },
  };
  return est;
}

/** Rolling-median period + median phase-correction estimator. */
export function createFilteredEstimator(opts = {}) {
  const p = { ...DEFAULTS, ...opts };
  const cap = p.capacity;
  const ts = new Float64Array(cap);
  const ix = new Float64Array(cap);
  const scratch = new Float64Array(p.window + 1);
  const stats = { clocks: 0, duplicates: 0, gaps: 0, resyncs: 0 };
  let n = 0; // entries in the ring (<= cap)
  let head = -1; // ring index of newest entry
  let period = NaN;
  let devSign = 0; // direction of the current run of off-tempo spans
  let devRun = 0;
  let hold = false; // keep a known period until the window refills after a rebase

  const slot = (back) => (head - back + cap * 2) % cap;

  function clear() {
    n = 0;
    head = -1;
    devSign = devRun = 0;
  }

  /** Re-estimate period from spans over the stored window. */
  function updatePeriod() {
    if (n < 2) return;
    if (hold && n - 1 < p.span / 2) return;
    hold = false;
    const m = Math.min(p.span, n - 1);
    const count = Math.min(p.window, n - m);
    for (let k = 0; k < count; k++) {
      const a = slot(k);
      const b = slot(k + m);
      scratch[k] = (ts[a] - ts[b]) / (ix[a] - ix[b]);
    }
    period = medianOf(scratch, count);
  }

  /** Median over stored clocks of "when does this clock say the newest tick happens". */
  function phaseTarget() {
    const cur = ix[head];
    const count = Math.min(p.window, n);
    for (let k = 0; k < count; k++) {
      const s = slot(k);
      scratch[k] = ts[s] + (cur - ix[s]) * period;
    }
    return medianOf(scratch, count);
  }

  /** Is the short-span tempo persistently off the current period? */
  function tempoStepDetected() {
    if (!(period > 0) || n <= p.sustain) return false;
    const a = head;
    const b = slot(p.sustain);
    const r = (ts[a] - ts[b]) / (ix[a] - ix[b]) / period;
    const sign = r < 1 - p.tempoStepFraction ? -1 : r > 1 + p.tempoStepFraction ? 1 : 0;
    if (sign !== 0 && sign === devSign) devRun++;
    else {
      devSign = sign;
      devRun = sign === 0 ? 0 : 1;
    }
    return devRun >= p.sustain;
  }

  const est = {
    kind: "filtered",
    stats,
    anchorTime: NaN,
    anchorIdx: 0,
    idx: -1,
    push(t) {
      let resynced = false;
      let hardAnchor = false;
      if (n > 0) {
        const prevIdx = ix[head];
        const dt = t - ts[head];
        const dupLimit = period > 0 ? period * p.dupFraction : 1;
        if (dt < dupLimit) {
          stats.duplicates++;
          return { accepted: false, resynced: false };
        }
        let ticks = 1;
        if (period > 0) {
          ticks = Math.max(1, Math.round(dt / period));
          if (ticks > 1) stats.gaps++;
          if (ticks > p.maxGapTicks) {
            // Too long a gap to count ticks: keep tempo, re-anchor phase.
            stats.resyncs++;
            resynced = hardAnchor = true;
            clear();
            hold = true;
            ticks = 1;
          }
        }
        head = (head + 1) % cap;
        ts[head] = t;
        ix[head] = prevIdx + ticks;
        n = Math.min(n + 1, cap);
      } else {
        head = 0;
        n = 1;
        ts[0] = t;
        ix[0] = est.idx >= 0 ? est.idx + 1 : 0;
      }
      est.idx = ix[head];
      stats.clocks++;

      if (tempoStepDetected()) {
        // Real tempo change: keep only the recent clocks and re-derive from them.
        n = p.sustain + 1;
        period = NaN;
        hold = false;
        devSign = devRun = 0;
        stats.resyncs++;
        resynced = hardAnchor = true;
      }
      if (n < 2) {
        est.anchorTime = t;
        est.anchorIdx = est.idx;
        return { accepted: true, resynced };
      }
      updatePeriod();
      if (!(period > 0)) return { accepted: true, resynced };
      const tgt = phaseTarget();
      if (est.anchorTime !== est.anchorTime || hardAnchor) {
        est.anchorTime = tgt;
      } else {
        const predicted = est.anchorTime + (est.idx - est.anchorIdx) * period;
        const err = tgt - predicted;
        if (Math.abs(err) > p.resyncPhaseMs) {
          stats.resyncs++;
          resynced = true;
          est.anchorTime = tgt;
        } else {
          est.anchorTime = predicted + p.phaseGain * err;
        }
      }
      est.anchorIdx = est.idx;
      return { accepted: true, resynced };
    },
    rebase() {
      // Keep tempo; next clock becomes idx+1 with a fresh phase.
      const last = est.idx;
      clear();
      hold = period > 0;
      est.idx = last;
      est.anchorTime = NaN;
    },
    reset() {
      clear();
      period = NaN;
      hold = false;
      est.idx = -1;
      est.anchorTime = NaN;
      est.anchorIdx = 0;
      stats.clocks = stats.duplicates = stats.gaps = stats.resyncs = 0;
    },
    ready: () => stats.clocks >= p.readyClocks && period > 0 && est.anchorTime === est.anchorTime,
    periodMs: () => (period > 0 ? period : NaN),
    bpm: () => (period > 0 ? 60000 / (period * TICKS_PER_BEAT) : NaN),
    tickPosAt(t) {
      if (!(period > 0) || est.anchorTime !== est.anchorTime) return NaN;
      return est.anchorIdx + (t - est.anchorTime) / period;
    },
  };
  return est;
}

export function createEstimator(kind = "filtered", opts = {}) {
  return kind === "last-interval"
    ? createLastIntervalEstimator(opts)
    : createFilteredEstimator(opts);
}
