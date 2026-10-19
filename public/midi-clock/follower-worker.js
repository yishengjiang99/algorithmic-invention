/**
 * Follower Worker: owns the estimator, the transport state machine and the
 * sync-loss watchdog. Module worker (new Worker(url, { type: "module" })).
 *
 * Main -> worker
 *   { type: "init", estimator, lostTimeoutMs, mainTimeOrigin }
 *   Float64Array [kind, tMs, kind, tMs, ...]   compact events; tMs is in the
 *       main thread's performance.now() domain (MIDIMessageEvent.timeStamp)
 *   { type: "close" }                          stop the watchdog and exit
 * Worker -> main
 *   Float64Array SNAPSHOT (see SNAP) on every state change and at most every
 *       SNAPSHOT_MIN_MS otherwise
 *   { type: "closed" }
 *
 * The watchdog runs here (not on the main thread) so a busy UI thread cannot
 * delay a sync-loss report.
 */
import { createEstimator } from "./estimator.js";
import { createTransport, Kind, STATE_CODES, WATCHDOG_MS } from "./transport.js";
import { workerToMainMs } from "./clockmap.js";
import { SNAP } from "./protocol.js";

const SNAPSHOT_MIN_MS = 16;

let transport = null;
let timer = null;
let mainOrigin = 0;
let seq = 0;
let dirty = false;
let lastPost = -Infinity;

const nowMain = () => workerToMainMs(performance.now(), performance.timeOrigin, mainOrigin);

function post(now) {
  const s = transport.snapshot();
  const a = new Float64Array(SNAP.LEN);
  a[SNAP.SEQ] = ++seq;
  a[SNAP.STATE] = STATE_CODES.indexOf(s.state);
  a[SNAP.BPM] = s.bpm;
  a[SNAP.PERIOD] = s.periodMs;
  a[SNAP.ANCHOR_TIME] = s.anchorTime;
  a[SNAP.ANCHOR_SONG_TICK] = s.anchorSongTick;
  a[SNAP.RUN_ID] = s.runId;
  a[SNAP.READY] = s.ready ? 1 : 0;
  a[SNAP.LOST_COUNT] = s.lostCount;
  a[SNAP.CLOCKS] = s.clocks;
  a[SNAP.DUPLICATES] = s.duplicates;
  a[SNAP.GAPS] = s.gaps;
  a[SNAP.RESYNCS] = s.resyncs;
  a[SNAP.LAST_CLOCK] = s.lastClockT;
  a[SNAP.RESUME_TICK] = s.resumeTick;
  a[SNAP.NOW] = now;
  lastPost = now;
  dirty = false;
  self.postMessage(a, [a.buffer]);
}

function maybePost(now, force) {
  if (force || (dirty && now - lastPost >= SNAPSHOT_MIN_MS)) post(now);
}

function onBatch(d) {
  if (!transport) return;
  let changed = false;
  for (let i = 0; i + 1 < d.length; i += 2) {
    if (transport.handle(d[i], d[i + 1])) changed = true;
    if (d[i] === Kind.CLOCK) dirty = true;
  }
  const now = nowMain();
  maybePost(now, changed);
}

function stopTimer() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

self.onmessage = (ev) => {
  const d = ev.data;
  if (d instanceof Float64Array) {
    onBatch(d);
    return;
  }
  if (!d) return;
  if (d.type === "init") {
    stopTimer();
    mainOrigin = d.mainTimeOrigin;
    transport = createTransport({
      estimator: createEstimator(d.estimator || "filtered"),
      lostTimeoutMs: d.lostTimeoutMs,
    });
    timer = setInterval(() => {
      const now = nowMain();
      const lost = transport.poll(now);
      maybePost(now, lost);
    }, WATCHDOG_MS);
    post(nowMain());
  } else if (d.type === "close") {
    stopTimer();
    transport = null;
    self.postMessage({ type: "closed" });
    self.close();
  }
};
