/**
 * Look-ahead beat scheduler (pure).
 *
 * Given the latest follower snapshot it decides which beats to hand to the
 * click processor. It owns the "no duplicate beats" bookkeeping on the sending
 * side; the processor independently drops any key that does not increase.
 *
 * key = runId * 2^20 + beat   (Start bumps runId, so beat numbers may restart)
 *
 * Rules
 *   - Beats are planned while the transport is running, and while armed with a
 *     ready estimator (the first beat is predicted from the steady clock).
 *   - A beat is sent once, when its predicted time is within lookaheadMs.
 *   - A beat whose time passed less than lateBeatTicks ago is still sent (the
 *     processor fires it immediately); older ones are skipped.
 *   - Leaving running/armed (stop, lost, disconnect) cancels queued beats and
 *     rewinds lastBeat to the last beat whose tick already played, so Continue
 *     re-plays nothing and skips nothing.
 *   - A new runId (Start while running) cancels the previous run's queue.
 */

import { TICKS_PER_BEAT, State } from "./transport.js";

export const KEY_BEAT_MOD = 1048576; // 2^20
export const makeKey = (runId, beat) => runId * KEY_BEAT_MOD + beat;

const isActive = (st) => st === State.RUNNING || st === State.ARMED;

/**
 * @param {object} o
 * @param {(key:number, tMs:number)=>void} o.send    beat at predicted time tMs (follower time domain)
 * @param {()=>void} o.cancel                        drop everything queued downstream
 * @param {number} [o.lookaheadMs=120]
 * @param {number} [o.lateBeatTicks=2]
 */
export function createBeatScheduler({ send, cancel, lookaheadMs = 120, lateBeatTicks = 2 }) {
  const s = {
    runId: -1,
    lastBeat: -1,
    prevState: State.IDLE,
    sent: 0,
    cancels: 0,
  };

  return {
    state: s,
    /** Call with every new snapshot and periodically (every ~20 ms) with the latest one. */
    update(snap, nowMs) {
      if (!isActive(snap.state) && isActive(s.prevState)) {
        cancel();
        s.cancels++;
        s.lastBeat = Math.floor((snap.resumeTick - 1) / TICKS_PER_BEAT);
      }
      s.prevState = snap.state;
      if (!isActive(snap.state) || !snap.ready) return 0;
      if (!(snap.periodMs > 0) || !(snap.anchorTime === snap.anchorTime)) return 0;
      if (!(snap.anchorSongTick === snap.anchorSongTick)) return 0;
      if (s.runId !== snap.runId) {
        if (s.runId !== -1) {
          cancel();
          s.cancels++;
        }
        s.runId = snap.runId;
        s.lastBeat = -1;
      }
      const tickNow = snap.anchorSongTick + (nowMs - snap.anchorTime) / snap.periodMs;
      const horizon = nowMs + lookaheadMs;
      let b = Math.max(s.lastBeat + 1, Math.ceil((tickNow - lateBeatTicks) / TICKS_PER_BEAT));
      let n = 0;
      for (let guard = 0; guard < 8; guard++, b++) {
        const tMs = snap.anchorTime + (b * TICKS_PER_BEAT - snap.anchorSongTick) * snap.periodMs;
        if (tMs > horizon) break;
        send(makeKey(snap.runId, b), tMs);
        s.lastBeat = b;
        s.sent++;
        n++;
      }
      return n;
    },
    reset() {
      s.runId = -1;
      s.lastBeat = -1;
      s.prevState = State.IDLE;
    },
  };
}
