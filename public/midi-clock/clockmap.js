/**
 * Clock-domain conversion (pure).
 *
 * Three clocks are involved:
 *   - MIDI timestamps: MIDIMessageEvent.timeStamp, a DOMHighResTimeStamp in
 *     the *main thread's* performance.now() domain (ms since that realm's
 *     timeOrigin).
 *   - Worker clock: the Worker's own performance.now(), a different origin.
 *     Cross-realm conversion: t_main = performance.now() + performance.timeOrigin
 *     - mainTimeOrigin (see workerClock()).
 *   - Audio clock: AudioContext.currentTime (seconds, sample-accurate, driven
 *     by the sound card's crystal and so drifting slowly against performance.now()).
 *
 * AudioContext.getOutputTimestamp() returns a simultaneous pair
 * { contextTime (s), performanceTime (ms, main performance.now domain) } for
 * the sample the output device is playing right now. Scheduling a source at
 * contextTime X makes it audible at that device position, so no extra latency
 * term is added. Each pair gives an offset
 *     offset = contextTime - performanceTime / 1000
 * and audioTime(t) = t / 1000 + offset.
 *
 * The raw pair is quantised and jittery in some browsers, and the two clocks
 * drift, so the map keeps the last N offsets and uses their median: jitter is
 * rejected, drift (tens of ppm) moves the median by microseconds over the
 * window.
 */

export const toAudioTime = (tMs, offsetSec) => tMs / 1000 + offsetSec;
export const toPerfMs = (audioSec, offsetSec) => (audioSec - offsetSec) * 1000;

/** Convert a Worker performance.now() reading to the main thread's performance.now() domain. */
export function workerToMainMs(workerNowMs, workerTimeOriginMs, mainTimeOriginMs) {
  return workerNowMs + workerTimeOriginMs - mainTimeOriginMs;
}

export function createClockMap(size = 16) {
  const offs = new Float64Array(size);
  const tmp = new Float64Array(size);
  let n = 0;
  let w = 0;
  return {
    /** Add a simultaneous (contextTimeSec, performanceTimeMs) pair. */
    add(contextTimeSec, performanceTimeMs) {
      if (!Number.isFinite(contextTimeSec) || !Number.isFinite(performanceTimeMs)) return false;
      // The audio clock has not started yet (0, 0) pairs carry no information.
      if (contextTimeSec === 0 && performanceTimeMs === 0) return false;
      offs[w] = contextTimeSec - performanceTimeMs / 1000;
      w = (w + 1) % size;
      if (n < size) n++;
      return true;
    },
    get count() {
      return n;
    },
    /** Median offset (seconds) or NaN with no pairs. */
    offset() {
      if (n === 0) return NaN;
      for (let i = 0; i < n; i++) tmp[i] = offs[i];
      for (let i = 1; i < n; i++) {
        const v = tmp[i];
        let j = i - 1;
        while (j >= 0 && tmp[j] > v) {
          tmp[j + 1] = tmp[j];
          j--;
        }
        tmp[j + 1] = v;
      }
      return n & 1 ? tmp[n >> 1] : 0.5 * (tmp[(n >> 1) - 1] + tmp[n >> 1]);
    },
    /** performance.now-domain ms -> AudioContext seconds (NaN until a pair exists). */
    toAudio(tMs) {
      return toAudioTime(tMs, this.offset());
    },
    reset() {
      n = 0;
      w = 0;
    },
  };
}
