/**
 * MIDI transport state machine (pure: no timers, no DOM, no Web APIs).
 *
 * Inputs are timestamped events (milliseconds, one monotonic domain). The
 * caller owns the watchdog: call poll(now) periodically (the Worker does so
 * every WATCHDOG_MS) and sync loss is declared when no clock has arrived for
 * lostTimeoutMs. Detection latency is therefore lostTimeoutMs + one poll
 * interval (250 + 25 = 275 ms worst case), well inside the 500 ms budget.
 *
 * States
 *   idle          nothing received yet (or after a reconnect)
 *   stopped       clocks flowing, transport not running
 *   armed         Start/Continue received; the next clock is the first tick
 *   running       clocks flowing and playing
 *   lost          Start/Continue/clocks were expected but none arrived within
 *                 lostTimeoutMs
 *   disconnected  the input port went away (device unplugged / port closed)
 *
 * Song position
 *   Start      -> next clock is tick 0 of a new run (runId++).
 *   Continue   -> next clock is the tick after the last one played (resumeTick).
 *   Stop       -> position kept in resumeTick, state stopped. Clocks may keep
 *                 flowing; the estimator keeps tracking tempo.
 *   songTick(idx) = idx - originIdx where idx is the estimator's unwrapped tick
 *   index, so missing clocks advance the song position and duplicated clocks do
 *   not. Beat n starts at songTick 24 * n.
 *
 * Recovery policy
 *   After `lost` or `disconnected` a returning clock moves to `stopped`, not
 *   `running`. Position is preserved (Continue resumes it, Start restarts), but
 *   playback only resumes on an explicit transport message: the follower never
 *   guesses how many ticks it missed.
 *
 *   A device that sends Stop and then silence is not "lost": clocks are only
 *   required while armed or running, or while stopped but never explicitly
 *   stopped (clocks were flowing with no transport message at all).
 */

import { TICKS_PER_BEAT } from "./estimator.js";

export { TICKS_PER_BEAT };

export const DEFAULT_LOST_TIMEOUT_MS = 250;
export const WATCHDOG_MS = 25;

export const State = Object.freeze({
  IDLE: "idle",
  STOPPED: "stopped",
  ARMED: "armed",
  RUNNING: "running",
  LOST: "lost",
  DISCONNECTED: "disconnected",
});

/** Numeric event kinds (compact wire format between main thread and Worker). */
export const Kind = Object.freeze({
  CLOCK: 0,
  START: 1,
  CONTINUE: 2,
  STOP: 3,
  DISCONNECT: 4,
  CONNECT: 5,
});

/** Map a Web MIDI status byte to a Kind, or -1 for anything we ignore. */
export function kindFromStatus(status) {
  switch (status) {
    case 0xf8:
      return Kind.CLOCK;
    case 0xfa:
      return Kind.START;
    case 0xfb:
      return Kind.CONTINUE;
    case 0xfc:
      return Kind.STOP;
    default:
      return -1;
  }
}

/** Stable numeric codes for the snapshot wire format. */
export const STATE_CODES = Object.freeze([
  State.IDLE,
  State.STOPPED,
  State.ARMED,
  State.RUNNING,
  State.LOST,
  State.DISCONNECTED,
]);

/**
 * @param {object} o
 * @param {object} o.estimator           from createEstimator()
 * @param {number} [o.lostTimeoutMs]
 * @param {(from:string,to:string,t:number)=>void} [o.onTransition]
 */
export function createTransport({
  estimator,
  lostTimeoutMs = DEFAULT_LOST_TIMEOUT_MS,
  onTransition,
}) {
  const tr = {
    state: State.IDLE,
    lostFrom: null,
    runId: 0,
    originIdx: 0,
    resumeTick: 0,
    explicitStop: false,
    lastClockT: NaN,
    armedAt: NaN,
    lostCount: 0,
    lostAt: NaN,
    lostDetectedAt: NaN,
    ignoredWhileDisconnected: 0,
    estimator,
    lostTimeoutMs,
  };

  function set(next, t) {
    if (tr.state === next) return false;
    const prev = tr.state;
    tr.state = next;
    if (onTransition) onTransition(prev, next, t);
    return true;
  }

  const songTickOfLast = () => estimator.idx - tr.originIdx;

  function clocksRequired() {
    return (
      tr.state === State.RUNNING ||
      tr.state === State.ARMED ||
      (tr.state === State.STOPPED && !tr.explicitStop)
    );
  }

  function arm(t) {
    // After a silent period phase must be re-anchored (tempo is kept).
    if (!(t - tr.lastClockT <= lostTimeoutMs)) estimator.rebase();
    tr.armedAt = t;
    set(State.ARMED, t);
  }

  /** @returns {boolean} true if the observable state changed */
  tr.handle = function handle(kind, t) {
    if (tr.state === State.DISCONNECTED && kind !== Kind.CONNECT) {
      tr.ignoredWhileDisconnected++;
      return false;
    }
    switch (kind) {
      case Kind.CLOCK: {
        const r = estimator.push(t);
        if (!r.accepted) return false; // duplicate or reordered stamp
        tr.lastClockT = t;
        if (tr.state === State.IDLE) {
          tr.explicitStop = false;
          return set(State.STOPPED, t);
        }
        if (tr.state === State.LOST) {
          estimator.rebase();
          tr.explicitStop = false;
          return set(State.STOPPED, t);
        }
        if (tr.state === State.ARMED) {
          tr.originIdx = estimator.idx - tr.resumeTick;
          return set(State.RUNNING, t);
        }
        return false;
      }
      case Kind.START:
        tr.runId++;
        tr.resumeTick = 0;
        arm(t);
        return true;
      case Kind.CONTINUE:
        if (tr.state === State.RUNNING || tr.state === State.ARMED) return false;
        if (tr.runId === 0) tr.runId = 1;
        arm(t);
        return true;
      case Kind.STOP:
        if (tr.state === State.RUNNING) {
          tr.resumeTick = songTickOfLast() + 1;
          tr.explicitStop = true;
          return set(State.STOPPED, t);
        }
        if (tr.state === State.ARMED) {
          tr.explicitStop = true;
          return set(State.STOPPED, t);
        }
        if (tr.state === State.STOPPED) {
          tr.explicitStop = true;
        }
        return false;
      case Kind.DISCONNECT:
        estimator.reset();
        tr.lastClockT = NaN;
        return set(State.DISCONNECTED, t);
      case Kind.CONNECT:
        if (tr.state !== State.DISCONNECTED) return false;
        estimator.reset();
        tr.lastClockT = NaN;
        tr.explicitStop = false;
        return set(State.IDLE, t);
      default:
        return false;
    }
  };

  /** Watchdog. @returns {boolean} true if sync was just declared lost */
  tr.poll = function poll(now) {
    if (!clocksRequired()) return false;
    const ref = Math.max(
      Number.isFinite(tr.lastClockT) ? tr.lastClockT : -Infinity,
      tr.state === State.ARMED && Number.isFinite(tr.armedAt) ? tr.armedAt : -Infinity,
    );
    if (!Number.isFinite(ref) || now - ref <= lostTimeoutMs) return false;
    if (tr.state === State.RUNNING) tr.resumeTick = songTickOfLast() + 1;
    tr.lostFrom = tr.state;
    tr.lostAt = ref;
    tr.lostDetectedAt = now;
    tr.lostCount++;
    return set(State.LOST, now);
  };

  /** Song tick (float) the transport is at, at time t; NaN unless running. */
  tr.songTickAt = function songTickAt(t) {
    if (tr.state !== State.RUNNING) return NaN;
    const pos = estimator.tickPosAt(t);
    return pos - tr.originIdx;
  };

  /** Beat phase 0..1 at time t, or NaN (not running / not ready). */
  tr.beatPhaseAt = function beatPhaseAt(t) {
    const tick = tr.songTickAt(t);
    if (tick !== tick) return NaN;
    const m = tick % TICKS_PER_BEAT;
    return (m < 0 ? m + TICKS_PER_BEAT : m) / TICKS_PER_BEAT;
  };

  /** Plain-data view for display and for the click scheduler. */
  tr.snapshot = function snapshot() {
    const running = tr.state === State.RUNNING;
    return {
      state: tr.state,
      lostFrom: tr.lostFrom,
      bpm: estimator.bpm(),
      periodMs: estimator.periodMs(),
      ready: estimator.ready(),
      runId: tr.runId,
      resumeTick: tr.resumeTick,
      anchorTime: estimator.anchorTime,
      // Song tick at anchorTime. While running this is exact. While armed with a
      // ready estimator it is a prediction that the next clock is tick resumeTick,
      // which lets the first beat be scheduled before its clock has arrived.
      anchorSongTick: running
        ? estimator.anchorIdx - tr.originIdx
        : tr.state === State.ARMED && estimator.ready()
          ? estimator.anchorIdx - (estimator.idx + 1 - tr.resumeTick)
          : NaN,
      lastClockT: tr.lastClockT,
      lostCount: tr.lostCount,
      clocks: estimator.stats.clocks,
      duplicates: estimator.stats.duplicates,
      gaps: estimator.stats.gaps,
      resyncs: estimator.stats.resyncs,
    };
  };

  tr.reset = function reset() {
    estimator.reset();
    tr.state = State.IDLE;
    tr.lostFrom = null;
    tr.runId = 0;
    tr.originIdx = 0;
    tr.resumeTick = 0;
    tr.explicitStop = false;
    tr.lastClockT = NaN;
    tr.armedAt = NaN;
  };

  return tr;
}
