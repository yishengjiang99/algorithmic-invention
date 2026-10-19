/**
 * MIDI clock follower demo (framework-free).
 *
 *   Web MIDI | synthetic source -> batch -> Worker (estimator + transport)
 *        -> snapshot -> main: look-ahead scheduler + clock map
 *        -> AudioWorkletNode(click-processor) -> destination
 *
 * Everything with a lifetime (MIDI listeners, Worker, timers, AudioContext,
 * MessagePort) is registered in `disposers` and released by dispose().
 */
import { Kind, kindFromStatus, State, STATE_CODES, DEFAULT_LOST_TIMEOUT_MS } from "./transport.js";
import { createClockMap } from "./clockmap.js";
import { createSyntheticClock } from "./synthetic.js";
import { SNAP } from "./protocol.js";
import { createBeatScheduler, KEY_BEAT_MOD } from "./scheduler.js";

const TICKS_PER_BEAT = 24;
const LOOKAHEAD_MS = 120;
const SCHEDULER_MS = 20;
const CLOCKMAP_MS = 100;
const SYNTH_STEP_MS = 8;

const $ = (id) => document.getElementById(id);
const rel = (p) => new URL(p, import.meta.url);

/* ---------- worker bridge ---------- */

function createFollower({
  estimator = "filtered",
  lostTimeoutMs = DEFAULT_LOST_TIMEOUT_MS,
  onSnapshot,
}) {
  const worker = new Worker(rel("./follower-worker.js"), { type: "module" });
  let pending = new Float64Array(256);
  let n = 0;
  let queued = false;
  let closed = false;

  worker.onmessage = (ev) => {
    if (ev.data instanceof Float64Array) onSnapshot(ev.data);
  };
  worker.postMessage({
    type: "init",
    estimator,
    lostTimeoutMs,
    mainTimeOrigin: performance.timeOrigin,
  });

  function flush() {
    queued = false;
    if (closed || n === 0) return;
    const out = pending.slice(0, n);
    n = 0;
    worker.postMessage(out, [out.buffer]);
  }

  return {
    /** kind: Kind.*, tMs: performance.now() domain (MIDIMessageEvent.timeStamp). */
    feed(kind, tMs) {
      if (closed) return;
      if (n + 2 > pending.length) {
        const bigger = new Float64Array(pending.length * 2);
        bigger.set(pending);
        pending = bigger;
      }
      pending[n++] = kind;
      pending[n++] = tMs;
      if (!queued) {
        queued = true;
        queueMicrotask(flush);
      }
    },
    dispose() {
      if (closed) return;
      flush();
      closed = true;
      worker.onmessage = null;
      worker.postMessage({ type: "close" });
      worker.terminate();
    },
  };
}

/* ---------- audio ---------- */

async function createClickAudio({ onClick }) {
  const ctx = new AudioContext({ latencyHint: "interactive" });
  await ctx.audioWorklet.addModule(rel("./click-processor.js"));
  const node = new AudioWorkletNode(ctx, "click-processor", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  node.port.onmessage = (ev) => {
    if (ev.data instanceof Float64Array) onClick(ev.data);
  };
  node.connect(ctx.destination);
  const map = createClockMap(16);
  let disposed = false;

  function sample() {
    if (disposed || ctx.state === "closed") return;
    const ts = ctx.getOutputTimestamp();
    map.add(ts.contextTime, ts.performanceTime);
  }
  sample();
  const mapTimer = setInterval(sample, CLOCKMAP_MS);
  if (ctx.state === "suspended") await ctx.resume();
  sample();

  return {
    ctx,
    map,
    schedule(key, audioTimeSec) {
      node.port.postMessage(Float64Array.of(1, key, audioTimeSec));
    },
    cancel() {
      node.port.postMessage(Float64Array.of(2));
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(mapTimer);
      node.port.onmessage = null;
      node.port.close();
      node.disconnect();
      if (ctx.state !== "closed") await ctx.close();
    },
  };
}

/* ---------- Web MIDI input ---------- */

function createMidiSource({ feed, onStatus }) {
  /** @type {MIDIAccess|null} */
  let access = null;
  let selectedId = null;
  /** id -> { port, handler }  (one listener per port, ever) */
  const attached = new Map();
  let disposed = false;

  function detach(id) {
    const a = attached.get(id);
    if (!a) return;
    a.port.removeEventListener("midimessage", a.handler);
    attached.delete(id);
    a.port.close().catch(() => {});
  }

  function attach(port) {
    detach(port.id);
    const handler = (ev) => {
      const d = ev.data;
      if (!d || d.length === 0) return;
      const kind = kindFromStatus(d[0]);
      if (kind >= 0) feed(kind, ev.timeStamp);
    };
    port.addEventListener("midimessage", handler);
    attached.set(port.id, { port, handler });
    // addEventListener (unlike onmidimessage) does not open the port implicitly.
    port.open().catch(() => {});
  }

  function refresh() {
    if (!access || disposed) return;
    const inputs = [...access.inputs.values()];
    onStatus({
      type: "inputs",
      inputs: inputs.map((p) => ({ id: p.id, name: p.name, state: p.state })),
    });
    const sel = inputs.find((p) => p.id === selectedId);
    if (sel && sel.state === "connected") {
      if (!attached.has(sel.id) || attached.get(sel.id).port !== sel) {
        attach(sel);
        feed(Kind.CONNECT, performance.now());
      }
    } else {
      if (attached.size > 0) feed(Kind.DISCONNECT, performance.now());
      for (const id of [...attached.keys()]) detach(id);
    }
  }

  return {
    async init() {
      if (!navigator.requestMIDIAccess)
        throw new Error("Web MIDI is not available in this browser");
      access = await navigator.requestMIDIAccess({ sysex: false });
      access.onstatechange = refresh;
      refresh();
      return [...access.inputs.values()];
    },
    select(id) {
      selectedId = id;
      refresh();
    },
    listenerCount: () => attached.size,
    dispose() {
      disposed = true;
      if (access) access.onstatechange = null;
      for (const id of [...attached.keys()]) detach(id);
      access = null;
    },
  };
}

/* ---------- app ---------- */

export function createApp() {
  const disposers = [];
  const log = { clicks: [], scheduled: [], dupKeys: 0, seen: new Set() };
  const stats = { scheduled: 0, cancelled: 0, workletReports: null };

  /** Latest worker snapshot, decoded. */
  const snap = {
    seq: 0,
    state: State.IDLE,
    bpm: NaN,
    periodMs: NaN,
    anchorTime: NaN,
    anchorSongTick: NaN,
    runId: 0,
    ready: false,
    lostCount: 0,
    clocks: 0,
    duplicates: 0,
    gaps: 0,
    resyncs: 0,
    lastClockT: NaN,
    resumeTick: 0,
    receivedAt: 0,
    lostSeenAt: NaN,
  };
  let audio = null;
  let source = "synthetic";
  let midi = null;
  let synth = null;
  let synthTimer = null;
  let disposed = false;

  const follower = createFollower({
    onSnapshot(a) {
      const prev = snap.state;
      snap.seq = a[SNAP.SEQ];
      snap.state = STATE_CODES[a[SNAP.STATE]];
      snap.bpm = a[SNAP.BPM];
      snap.periodMs = a[SNAP.PERIOD];
      snap.anchorTime = a[SNAP.ANCHOR_TIME];
      snap.anchorSongTick = a[SNAP.ANCHOR_SONG_TICK];
      snap.runId = a[SNAP.RUN_ID];
      snap.ready = a[SNAP.READY] === 1;
      snap.lostCount = a[SNAP.LOST_COUNT];
      snap.clocks = a[SNAP.CLOCKS];
      snap.duplicates = a[SNAP.DUPLICATES];
      snap.gaps = a[SNAP.GAPS];
      snap.resyncs = a[SNAP.RESYNCS];
      snap.lastClockT = a[SNAP.LAST_CLOCK];
      snap.resumeTick = a[SNAP.RESUME_TICK];
      snap.receivedAt = performance.now();
      if (snap.state === State.LOST && prev !== State.LOST) snap.lostSeenAt = snap.receivedAt;
      if (prev !== snap.state) schedulerTick(); // do not wait for the next interval after a transition
    },
  });
  disposers.push(() => follower.dispose());

  const scheduler = createBeatScheduler({
    lookaheadMs: LOOKAHEAD_MS,
    cancel() {
      if (audio) audio.cancel();
      stats.cancelled++;
    },
    send(key, tMs) {
      if (!audio) return;
      const at = audio.map.toAudio(tMs);
      log.scheduled.push({ key, at, ctxNow: audio.ctx.currentTime, state: snap.state });
      audio.schedule(key, at);
      stats.scheduled++;
    },
  });

  function songTickAt(tMs) {
    return snap.anchorSongTick + (tMs - snap.anchorTime) / snap.periodMs;
  }

  function schedulerTick() {
    if (disposed) return;
    // Without an audio clock mapping there is nothing to schedule against, but the
    // scheduler must still see transport transitions, so it gets ready=false.
    const audioReady = audio && audio.map.count > 0;
    scheduler.update(audioReady ? snap : { ...snap, ready: false }, performance.now());
  }
  const schedTimer = setInterval(schedulerTick, SCHEDULER_MS);
  disposers.push(() => clearInterval(schedTimer));

  function onWorkletClick(r) {
    const key = r[0];
    if (log.seen.has(key)) log.dupKeys++;
    log.seen.add(key);
    const frame = r[1];
    log.clicks.push({
      key,
      beat: key % KEY_BEAT_MOD,
      runId: Math.floor(key / KEY_BEAT_MOD),
      audioTime: frame / audio.ctx.sampleRate,
      lateFrames: frame - r[2],
    });
    stats.workletReports = {
      fired: r[3],
      duplicatesDropped: r[4],
      lateDropped: r[5],
      overflow: r[6],
    };
  }

  /* ----- sources ----- */

  function feed(kind, t) {
    follower.feed(kind, t);
  }

  function ensureSynth() {
    if (synth) return synth;
    const names = {
      clock: Kind.CLOCK,
      start: Kind.START,
      continue: Kind.CONTINUE,
      stop: Kind.STOP,
    };
    synth = createSyntheticClock({
      now: () => performance.now(),
      emit: (kind, t) => feed(names[kind], t),
      bpm: Number($("synth-bpm").value) || 120,
      jitterMs: Number($("synth-jitter").value) || 0,
      dropRate: (Number($("synth-drop").value) || 0) / 100,
    });
    synthTimer = setInterval(() => synth.step(), SYNTH_STEP_MS);
    disposers.push(() => {
      clearInterval(synthTimer);
      synthTimer = null;
    });
    return synth;
  }

  const synthApi = {
    connect() {
      ensureSynth();
      feed(Kind.CONNECT, performance.now());
      synth.startClocks();
    },
    disconnect() {
      if (!synth) return;
      synth.stopClocks();
      feed(Kind.DISCONNECT, performance.now());
    },
    silence() {
      // Clocks stop but the port stays open (cable pulled mid-air / device hang).
      if (synth) synth.stopClocks();
    },
    resume() {
      if (synth) synth.startClocks();
    },
    send(kind) {
      ensureSynth().send(kind);
    },
    setBpm(v) {
      ensureSynth().setBpm(v);
    },
    setJitter(v) {
      ensureSynth().setJitter(v);
    },
    setDrop(v) {
      ensureSynth().setDropRate(v / 100);
    },
  };

  async function enableAudio() {
    if (audio) return;
    audio = await createClickAudio({ onClick: onWorkletClick });
  }

  async function useSource(which) {
    source = which;
    if (midi) {
      midi.dispose();
      midi = null;
    }
    if (which === "midi") {
      if (synth) synth.stopClocks();
      midi = createMidiSource({
        feed,
        onStatus(s) {
          if (s.type !== "inputs") return;
          const sel = $("midi-input");
          sel.replaceChildren(
            ...s.inputs.map((p) => {
              const o = document.createElement("option");
              o.value = p.id;
              o.textContent = `${p.name} (${p.state})`;
              return o;
            }),
          );
          if (s.inputs.length === 0) {
            $("midi-note").textContent = "No MIDI inputs found. Use the synthetic source.";
          } else {
            $("midi-note").textContent = "";
            if (!sel.value) sel.selectedIndex = 0;
          }
        },
      });
      await midi.init();
      const sel = $("midi-input");
      if (sel.value) midi.select(sel.value);
    } else {
      synthApi.connect();
    }
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    if (midi) midi.dispose();
    midi = null;
    for (const d of disposers.splice(0).reverse()) d();
    if (audio) await audio.dispose();
    audio = null;
  }

  return {
    snap,
    log,
    stats,
    synth: synthApi,
    enableAudio,
    useSource,
    dispose,
    get source() {
      return source;
    },
    get audio() {
      return audio;
    },
    get midi() {
      return midi;
    },
    get disposed() {
      return disposed;
    },
    songTickAt,
    selectMidi(id) {
      if (midi) midi.select(id);
    },
  };
}

/* ---------- UI ---------- */

function mountUi() {
  const app = createApp();
  const el = {
    state: $("state"),
    bpm: $("bpm"),
    phase: $("phase"),
    phaseBar: $("phase-bar"),
    beat: $("beat"),
    clocks: $("clocks"),
    clicks: $("clicks"),
    lost: $("lost"),
    audio: $("audio-state"),
    detail: $("detail"),
  };
  let raf = 0;
  function paint() {
    const s = app.snap;
    const now = performance.now();
    el.state.textContent = s.state;
    el.state.dataset.state = s.state;
    el.bpm.textContent = Number.isFinite(s.bpm) ? s.bpm.toFixed(2) : "—";
    let phase = NaN;
    let beat = NaN;
    if (s.state === State.RUNNING && s.periodMs > 0) {
      const tick = app.songTickAt(now);
      const m = ((tick % TICKS_PER_BEAT) + TICKS_PER_BEAT) % TICKS_PER_BEAT;
      phase = m / TICKS_PER_BEAT;
      beat = Math.floor(tick / TICKS_PER_BEAT);
    }
    el.phase.textContent = Number.isFinite(phase) ? phase.toFixed(3) : "—";
    el.beat.textContent = Number.isFinite(beat) ? String(Math.max(0, beat)) : "—";
    el.phaseBar.style.transform = `scaleX(${Number.isFinite(phase) ? phase : 0})`;
    el.clocks.textContent = `${s.clocks} clocks, ${s.duplicates} dup dropped, ${s.gaps} gaps filled, ${s.resyncs} resyncs`;
    el.clicks.textContent = `${app.log.clicks.length} clicks, ${app.log.dupKeys} duplicate`;
    el.lost.textContent =
      s.state === State.LOST
        ? `SYNC LOST (${s.lostCount}x) — clock silent > ${DEFAULT_LOST_TIMEOUT_MS} ms`
        : s.state === State.DISCONNECTED
          ? "INPUT DISCONNECTED"
          : s.ready
            ? "locked"
            : "settling";
    el.audio.textContent = app.audio ? `audio ${app.audio.ctx.state}` : "audio off";
    raf = requestAnimationFrame(paint);
  }
  raf = requestAnimationFrame(paint);

  const bind = (id, fn) => $(id).addEventListener("click", fn);
  bind("btn-audio", async () => {
    await app.enableAudio();
  });
  bind("btn-source-synth", () => app.useSource("synthetic"));
  bind("btn-source-midi", async () => {
    try {
      await app.useSource("midi");
    } catch (err) {
      $("midi-note").textContent = String(err && err.message ? err.message : err);
    }
  });
  $("midi-input").addEventListener("change", (e) => app.selectMidi(e.target.value));
  bind("btn-start", () => app.synth.send("start"));
  bind("btn-continue", () => app.synth.send("continue"));
  bind("btn-stop", () => app.synth.send("stop"));
  bind("btn-silence", () => app.synth.silence());
  bind("btn-resume-clocks", () => app.synth.resume());
  bind("btn-unplug", () => app.synth.disconnect());
  bind("btn-replug", () => app.synth.connect());
  $("synth-bpm").addEventListener("change", (e) => app.synth.setBpm(Number(e.target.value)));
  $("synth-jitter").addEventListener("change", (e) => app.synth.setJitter(Number(e.target.value)));
  $("synth-drop").addEventListener("change", (e) => app.synth.setDrop(Number(e.target.value)));
  bind("btn-dispose", async () => {
    cancelAnimationFrame(raf);
    await app.dispose();
    el.state.textContent = "disposed";
  });

  app.useSource("synthetic");
  window.__midiClock = app;
  window.addEventListener("pagehide", () => app.dispose());
  return app;
}

if (typeof document !== "undefined" && document.getElementById("state")) mountUi();
