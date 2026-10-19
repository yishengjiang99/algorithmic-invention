/**
 * Replay a synthetic trace through an estimator and score it against ground
 * truth (pure; used by scripts/midi-clock-experiment.mjs and the tests).
 *
 * Causality: at every evaluation instant tau (1 ms grid) the estimator has only
 * seen messages whose *observed* timestamp is <= tau, which is exactly what a
 * click scheduler could know at that moment.
 *
 * Error definitions
 *   phase error (ms)  = wrap_to_beat( estimatedTick(tau) - trueTick(tau) ) * trueTickPeriod(tau)
 *   bpm error         = | estimator.bpm() - trueBpm(tau) |
 * `trueTick` uses the generator's ideal tick times. The estimator's tick index
 * is anchored at the first message it was given, whose true tick is known to
 * the harness (not to the estimator).
 */

import { TICKS_PER_BEAT } from "./estimator.js";

export const THRESHOLDS = Object.freeze({
  settleMs: 2000,
  bpmError: 0.5,
  phaseP95Ms: 5,
});

function percentile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * @param {object} estimator  from createEstimator
 * @param {{t:Float64Array,tick:Int32Array,trueTimes:Float64Array}} trace
 * @param {object} [o]
 * @param {number} [o.endMs]            default: last true tick time
 * @param {number} [o.steadyFromMs=2000]
 * @param {number} [o.phaseBandMs=5]
 * @param {number} [o.bpmBand=0.5]
 * @param {number} [o.jumpMs=5]          a prediction jump larger than this counts as a visible phase jump
 */
export function replay(estimator, trace, o = {}) {
  const { t, tick, trueTimes } = trace;
  const endMs = o.endMs ?? trueTimes[trueTimes.length - 1];
  const steadyFrom = o.steadyFromMs ?? 2000;
  const phaseBand = o.phaseBandMs ?? 5;
  const bpmBand = o.bpmBand ?? 0.5;
  const jumpMs = o.jumpMs ?? 5;

  estimator.reset();
  const k0 = tick.length ? tick[0] : 0;
  const N = t.length;
  const steadyPhase = [];
  const steadyBpm = [];
  let e = 0;
  let seg = 0; // trueTimes segment pointer
  let lastViolation = -1;
  let firstInBand = -1;
  let inBandSince = -1;
  let unconverged = 0;
  let evals = 0;
  let phaseJumps = 0;
  let accepted = 0;

  for (let tau = 0; tau <= endMs; tau += 1) {
    while (e < N && t[e] <= tau) {
      const before = estimator.tickPosAt(t[e]);
      const r = estimator.push(t[e]);
      if (r.accepted) accepted++;
      const after = estimator.tickPosAt(t[e]);
      if (before === before && after === after) {
        const dtick = after - before;
        const T = estimator.periodMs();
        if (Math.abs(dtick - TICKS_PER_BEAT * Math.round(dtick / TICKS_PER_BEAT)) * T > jumpMs) {
          phaseJumps++;
        }
      }
      e++;
    }
    while (seg + 2 < trueTimes.length && trueTimes[seg + 1] <= tau) seg++;
    const T0 = trueTimes[seg];
    const T1 = trueTimes[seg + 1] ?? T0 + (T0 - trueTimes[seg - 1]);
    const trueTickPeriod = T1 - T0;
    const trueTick = seg + (tau - T0) / trueTickPeriod;
    const trueBpm = 60000 / (trueTickPeriod * TICKS_PER_BEAT);

    evals++;
    const pos = estimator.tickPosAt(tau);
    const bpm = estimator.bpm();
    let phaseErr = Infinity;
    let bpmErr = Infinity;
    if (pos === pos && bpm === bpm) {
      const d = pos - (trueTick - k0);
      const wrapped = d - TICKS_PER_BEAT * Math.round(d / TICKS_PER_BEAT);
      phaseErr = Math.abs(wrapped * trueTickPeriod);
      bpmErr = Math.abs(bpm - trueBpm);
    } else if (tau >= steadyFrom) {
      unconverged++;
    }
    const ok = phaseErr < phaseBand && bpmErr < bpmBand;
    if (!ok) {
      lastViolation = tau;
      inBandSince = -1;
    } else if (inBandSince < 0) {
      inBandSince = tau;
      if (firstInBand < 0) firstInBand = tau;
    }
    if (tau >= steadyFrom) {
      steadyPhase.push(phaseErr);
      steadyBpm.push(bpmErr);
    }
  }

  const sp = Float64Array.from(steadyPhase).sort();
  const sb = Float64Array.from(steadyBpm).sort();
  const stayedToEnd = lastViolation < Math.floor(endMs);
  return {
    kind: estimator.kind,
    evaluations: evals,
    messagesDelivered: N,
    messagesAccepted: accepted,
    settleMs: stayedToEnd ? lastViolation + 1 : null,
    firstInBandMs: firstInBand >= 0 ? firstInBand : null,
    phaseMedianMs: percentile(sp, 0.5),
    phaseP95Ms: percentile(sp, 0.95),
    phaseMaxMs: percentile(sp, 1),
    bpmMedianErr: percentile(sb, 0.5),
    bpmP95Err: percentile(sb, 0.95),
    bpmMaxErr: percentile(sb, 1),
    unconvergedSamples: unconverged,
    resyncs: estimator.stats.resyncs,
    phaseJumps,
    duplicatesDropped: estimator.stats.duplicates,
    gapsFilled: estimator.stats.gaps,
  };
}

/** Pass/fail against the pre-registered thresholds. */
export function judge(r, th = THRESHOLDS) {
  const settle = r.settleMs !== null && r.settleMs <= th.settleMs;
  const bpm = r.bpmMaxErr < th.bpmError;
  const phase = r.phaseP95Ms < th.phaseP95Ms;
  return { settle, bpm, phase, all: settle && bpm && phase };
}
