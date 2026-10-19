/**
 * Deterministic simulation helpers shared by the midi-clock tests. No timers, no
 * wall clock: virtual time only.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createEstimator } from "../../../public/midi-clock/estimator.js";
import {
  createTransport,
  Kind,
  WATCHDOG_MS,
  DEFAULT_LOST_TIMEOUT_MS,
} from "../../../public/midi-clock/transport.js";
import { createBeatScheduler } from "../../../public/midi-clock/scheduler.js";

export const TICK_120 = 60000 / (120 * 24);
export const tickMs = (bpm) => 60000 / (bpm * 24);

const here = dirname(fileURLToPath(import.meta.url));
export const CLICK_SRC = readFileSync(
  join(here, "../../../public/midi-clock/click-processor.js"),
  "utf8",
);

/** Load the real click-processor.js with AudioWorkletGlobalScope-style globals. One live processor at a time. */
export function loadProcessor({ sampleRate = 48000, record = true } = {}) {
  const posted = [];
  const counter = { posted: 0, last: new Float64Array(8) };
  let ProcessorClass = null;
  class AudioWorkletProcessor {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (m) => {
          counter.posted++;
          if (record) posted.push(Float64Array.from(m));
          else counter.last.set(m); // allocation-free sink for heap measurements
        },
      };
    }
  }
  // Evaluate in the main realm with AudioWorkletGlobalScope-style globals: code run
  // through a separate vm context is not optimised the same way, which would make
  // the allocation audit measure the harness instead of the processor.
  const ctx = globalThis;
  ctx.AudioWorkletProcessor = AudioWorkletProcessor;
  ctx.sampleRate = sampleRate;
  // currentFrame is a getter over a typed array so the harness itself does not box a double per block.
  const frameBox = new Float64Array(1);
  Object.defineProperty(ctx, "currentFrame", { configurable: true, get: () => frameBox[0] });
  ctx.registerProcessor = (_name, cls) => {
    ProcessorClass = cls;
  };
  (0, eval)(CLICK_SRC);
  const proc = new ProcessorClass();
  const out = [new Float32Array(128)];
  const inputs = [];
  const outputs = [out]; // preallocated: the harness must not allocate per block either
  return {
    proc,
    posted,
    counter,
    ctx,
    sampleRate,
    send: (arr) => proc.port.onmessage({ data: Float64Array.from(arr) }),
    /** Render one 128-frame block starting at frame f. */
    block(f) {
      frameBox[0] = f;
      proc.process(inputs, outputs);
      return out[0];
    },
  };
}

/** Drive a transport with perfect clocks. Returns the time after the last clock. */
export function feedClocks(tr, t0, count, period = TICK_120) {
  let t = t0;
  for (let i = 0; i < count; i++) {
    tr.handle(Kind.CLOCK, t);
    t += period;
  }
  return t;
}

export function newTransport(opts = {}) {
  const estimator = createEstimator(opts.estimator ?? "filtered");
  const transitions = [];
  const tr = createTransport({
    estimator,
    lostTimeoutMs: opts.lostTimeoutMs ?? DEFAULT_LOST_TIMEOUT_MS,
    onTransition: (from, to, t) => transitions.push([from, to, t]),
  });
  return { tr, estimator, transitions };
}

/**
 * Full pipeline in virtual time: events -> transport (+ watchdog) -> scheduler
 * -> clock map (fixed offset) -> the real click-processor, rendered block by block.
 *
 * `events` is an array of { at, kind, t } sorted by delivery time `at`; t is the
 * message timestamp (defaults to `at`). Disconnect/Connect use kind only.
 */
export function runPipeline({
  events,
  endMs,
  sampleRate = 48000,
  audioOffsetSec = 0.5,
  lostTimeoutMs = DEFAULT_LOST_TIMEOUT_MS,
  schedulerMs = 20,
}) {
  const { tr, transitions } = newTransport({ lostTimeoutMs });
  const p = loadProcessor({ sampleRate });
  const sent = [];
  const cancels = [];
  const scheduler = createBeatScheduler({
    send: (key, tMs) => {
      sent.push({ key, tMs });
      p.send([1, key, tMs / 1000 + audioOffsetSec]);
    },
    cancel: () => {
      cancels.push(now);
      p.send([2]);
    },
  });
  let now = 0;
  let ei = 0;
  let nextPoll = 0;
  let nextSched = 0;
  const lost = [];
  const blockMs = (128 / sampleRate) * 1000;
  // Render position tracks virtual time: audio time = now / 1000 + audioOffsetSec.
  let frame = Math.round(audioOffsetSec * sampleRate);
  const clicksFrames = [];
  let lastReport = 0;
  while (now < endMs) {
    while (ei < events.length && events[ei].at <= now) {
      const e = events[ei++];
      tr.handle(e.kind, e.t ?? e.at);
      scheduler.update(tr.snapshot(), now);
    }
    if (now >= nextPoll) {
      if (tr.poll(now)) lost.push({ detectedAt: now, lastClock: tr.lastClockT, state: tr.state });
      nextPoll += WATCHDOG_MS;
    }
    if (now >= nextSched) {
      scheduler.update(tr.snapshot(), now);
      nextSched += schedulerMs;
    }
    p.block(frame);
    while (lastReport < p.posted.length) {
      const r = p.posted[lastReport++];
      clicksFrames.push({
        key: r[0],
        frame: r[1],
        scheduledFrame: r[2],
        // audio seconds relative to the simulated render clock
        atMs: (r[1] / sampleRate - audioOffsetSec) * 1000,
      });
    }
    frame += 128;
    now += blockMs;
  }
  return { tr, p, sent, cancels, lost, clicks: clicksFrames, transitions, scheduler };
}

/** Build delivery events for ideal clocks at a constant tempo. */
export function clockEvents({
  from,
  to,
  bpm = 120,
  skip = () => false,
  dup = () => false,
  latency = 0,
}) {
  const out = [];
  const per = tickMs(bpm);
  let k = 0;
  for (let t = from; t < to; t += per, k++) {
    if (skip(k, t)) continue;
    out.push({ at: t + latency, kind: Kind.CLOCK, t });
    if (dup(k, t)) out.push({ at: t + latency, kind: Kind.CLOCK, t });
  }
  return out;
}

export const sortEvents = (a) => a.sort((x, y) => x.at - y.at);
