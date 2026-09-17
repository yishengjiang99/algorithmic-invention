export type EngineKind = "js" | "wasm";
export type WaveKind = "saw" | "square";
export type BenchProtocol = "probe" | "quick" | "full";

import { ODE_TO_JOY, noteAt, noteHz, type Tune } from "./tunes";
import { midiToHz, type Invention, type ScoreNote } from "@/lib/invention/generate";
import { assetUrl } from "@/lib/asset";

export type BenchRow = {
  engine: EngineKind;
  voices: number;
  quanta: number;
  medianUs: number;
  p99Us: number;
  maxUs: number;
  overruns: number;
  nan: number;
  inf: number;
  budgetUs: number;
  underHalf: boolean;
};

export type CoreSnapshot = {
  ready: boolean;
  error: string | null;
  playing: boolean;
  engine: EngineKind;
  wave: WaveKind;
  freq: number;
  gain: number;
  voices: number;
  memPages: number;
  memGrew: boolean;
  quanta: number;
  lastUs: number;
  medianUs: number;
  p99Us: number;
  maxUs: number;
  overruns: number;
  nan: number;
  inf: number;
  allocFlag: number;
  budgetUs: number;
  playSeconds: number;
  hold: {
    target: number | null;
    done: boolean;
    nan: number;
    overruns: number;
  };
  bench: {
    running: boolean;
    cancelling: boolean;
    protocol: BenchProtocol;
    progressLabel: string;
    current: number;
    total: number;
    rows: BenchRow[];
    crossover: string;
    maxStableJs: number | null;
    maxStableWasm: number | null;
  };
  discipline: {
    running: boolean;
    seconds: number;
    elapsed: number;
    startPages: number;
    pages: number;
    grew: boolean;
    nan: number;
    inf: number;
    overruns: number;
    allocFlag: number;
    quanta: number;
    p99Us: number;
    done: boolean;
  };
  compile: {
    status: string;
    wasmBytes: number;
    ms: number;
  };
  cSource: string;
  tune: {
    playing: boolean;
    name: string;
    note: string;
    index: number;
  };
  invention: {
    playing: boolean;
    beat: number;
    bpm: number;
    total: number;
  };
};

const VOICE_STEPS = [1, 8, 16, 32] as const;
const DUR: Record<BenchProtocol, number> = { probe: 1.5, quick: 4, full: 8 };

const SERVER_SNAP: CoreSnapshot = {
  ready: false,
  error: null,
  playing: false,
  engine: "wasm",
  wave: "saw",
  freq: 220,
  gain: 0.32,
  voices: 1,
  memPages: 1,
  memGrew: false,
  quanta: 0,
  lastUs: 0,
  medianUs: 0,
  p99Us: 0,
  maxUs: 0,
  overruns: 0,
  nan: 0,
  inf: 0,
  allocFlag: 0,
  budgetUs: 2666.7,
  playSeconds: 0,
  hold: { target: null, done: false, nan: 0, overruns: 0 },
  bench: {
    running: false,
    cancelling: false,
    protocol: "probe",
    progressLabel: "",
    current: 0,
    total: 0,
    rows: [],
    crossover: "",
    maxStableJs: null,
    maxStableWasm: null,
  },
  discipline: {
    running: false,
    seconds: 300,
    elapsed: 0,
    startPages: 1,
    pages: 1,
    grew: false,
    nan: 0,
    inf: 0,
    overruns: 0,
    allocFlag: 0,
    quanta: 0,
    p99Us: 0,
    done: false,
  },
  compile: { status: "idle", wasmBytes: 0, ms: 0 },
  cSource: "",
  tune: { playing: false, name: "", note: "", index: -1 },
  invention: { playing: false, beat: 0, bpm: 90, total: 20 },
};

function cloneSnap(s: CoreSnapshot): CoreSnapshot {
  return {
    ...s,
    bench: { ...s.bench, rows: s.bench.rows.slice() },
    discipline: { ...s.discipline },
    hold: { ...s.hold },
    compile: { ...s.compile },
    tune: { ...s.tune },
    invention: { ...s.invention },
  };
}

function summarize(rows: BenchRow[]): Pick<CoreSnapshot["bench"], "crossover" | "maxStableJs" | "maxStableWasm"> {
  const pairs: { v: number; js: BenchRow; wasm: BenchRow }[] = [];
  for (const v of VOICE_STEPS) {
    const js = rows.find((r) => r.engine === "js" && r.voices === v);
    const wasm = rows.find((r) => r.engine === "wasm" && r.voices === v);
    if (js && wasm) pairs.push({ v, js, wasm });
  }

  let crossover = "Run the battery to compare engines.";
  if (pairs.length) {
    const wasmFaster = pairs.filter((p) => p.wasm.medianUs < p.js.medianUs * 0.92).map((p) => p.v);
    const jsFaster = pairs.filter((p) => p.js.medianUs < p.wasm.medianUs * 0.92).map((p) => p.v);
    const fmt = (n: number) => (n === 1 ? "1 voice" : `${n} voices`);
    if (wasmFaster.length === pairs.length) {
      crossover = "WASM was faster at every tested voice count.";
    } else if (jsFaster.length === pairs.length) {
      crossover =
        "JS stayed faster at every tested voice count. Boundary-call overhead never dominated this loop.";
    } else if (!wasmFaster.length && !jsFaster.length) {
      crossover = "No meaningful crossover — JS and WASM stay within 8% at every voice count.";
    } else if (wasmFaster.length && !jsFaster.length) {
      crossover = `WASM is faster at ${wasmFaster.map(fmt).join(", ")}; remaining counts stay within 8%.`;
    } else if (jsFaster.length && !wasmFaster.length) {
      crossover = `JS is faster at ${jsFaster.map(fmt).join(", ")}; remaining counts stay within 8%.`;
    } else if (wasmFaster[0] === 1 && jsFaster.length) {
      crossover = `WASM is slightly faster at low counts (${wasmFaster.map(fmt).join(", ")}); JS pulls ahead at ${jsFaster.map(fmt).join(", ")} as the inner loop dominates.`;
    } else if (jsFaster[0] === 1 && wasmFaster.length) {
      crossover = `JS is competitive at ${fmt(jsFaster[0])} (call overhead). WASM is faster from ${fmt(wasmFaster[0])}.`;
    } else {
      crossover = `Mixed: WASM faster at ${wasmFaster.map(fmt).join(", ") || "—"}; JS faster at ${jsFaster.map(fmt).join(", ") || "—"}.`;
    }
  }
  const maxStable = (engine: EngineKind) => {
    let max: number | null = null;
    for (const v of VOICE_STEPS) {
      const row = rows.find((r) => r.engine === engine && r.voices === v);
      if (row && row.underHalf && row.overruns === 0) max = v;
    }
    return max;
  };
  return { crossover, maxStableJs: maxStable("js"), maxStableWasm: maxStable("wasm") };
}

export type CoreApi = {
  start: () => Promise<void>;
  stop: () => void;
  setEngine: (k: EngineKind) => void;
  setWave: (w: WaveKind) => void;
  setFreq: (hz: number) => void;
  setGain: (g: number) => void;
  setVoices: (n: number) => void;
  hold: (seconds?: number) => Promise<void>;
  playTune: () => Promise<void>;
  playInvention: (score: Invention) => Promise<void>;
  runBench: (opts: { protocol: BenchProtocol }) => Promise<void>;
  cancelBench: () => void;
  runDiscipline: (seconds: number) => Promise<void>;
  cancelDiscipline: () => void;
  unlock: () => void;
  getAnalyser: () => AnalyserNode | null;
  getScopeBuffer: () => Uint8Array | null;
  snapshot: () => CoreSnapshot;
};

export class CoreEngine {
  private listeners = new Set<() => void>();
  private snap: CoreSnapshot = cloneSnap(SERVER_SNAP);
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gainNode: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private scopeBuf: Uint8Array | null = null;
  private freqParam: AudioParam | null = null;
  private gainParam: AudioParam | null = null;
  private freq2Param: AudioParam | null = null;
  private gain2Param: AudioParam | null = null;
  private boot: Promise<void> | null = null;
  private playOrigin = 0;
  private raf = 0;
  private benchCancel = false;
  private discCancel = false;
  private emitTimer = 0;
  private measureWait: {
    resolve: (row: BenchRow) => void;
    reject: (err: Error) => void;
  } | null = null;
  private tuneTimer = 0;
  private tuneOrigin = 0;
  private activeTune: Tune | null = null;

  getAnalyser() {
    return this.analyser;
  }

  getScopeBuffer() {
    return this.scopeBuf;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snap;
  getServerSnapshot = () => SERVER_SNAP;

  api(): CoreApi {
    return {
      start: () => this.start(),
      stop: () => this.stop(),
      setEngine: (k) => this.setEngine(k),
      setWave: (w) => this.setWave(w),
      setFreq: (hz) => this.setFreq(hz),
      setGain: (g) => this.setGain(g),
      setVoices: (n) => this.setVoices(n),
      hold: (s) => this.hold(s),
      playTune: () => this.playTune(),
      playInvention: (score) => this.playInvention(score),
      runBench: (opts) => this.runBench(opts),
      cancelBench: () => this.cancelBench(),
      runDiscipline: (s) => this.runDiscipline(s),
      cancelDiscipline: () => this.cancelDiscipline(),
      unlock: () => void this.unlock(),
      getAnalyser: () => this.analyser,
      getScopeBuffer: () => this.scopeBuf,
      snapshot: () => this.snap,
    };
  }

  private emit() {
    this.snap = { ...this.snap, bench: { ...this.snap.bench, rows: this.snap.bench.rows }, discipline: { ...this.snap.discipline } };
    this.listeners.forEach((fn) => fn());
  }

  private scheduleEmit() {
    if (this.emitTimer) return;
    this.emitTimer = requestAnimationFrame(() => {
      this.emitTimer = 0;
      if (this.snap.playing && this.ctx) {
        this.snap = {
          ...this.snap,
          playSeconds: Math.max(0, this.ctx.currentTime - this.playOrigin),
        };
      }
      this.listeners.forEach((fn) => fn());
    });
  }

  unlock() {
    return this.ensure();
  }

  private async ensure() {
    if (this.node && this.ctx && this.ctx.state !== "closed") {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return;
    }
    if (this.boot) {
      await this.boot;
      return;
    }
    this.boot = this.bootGraph();
    try {
      await this.boot;
    } finally {
      this.boot = null;
    }
  }

  private async bootGraph() {
    const ctx = this.ctx ?? new AudioContext();
    this.ctx = ctx;
    if (ctx.state === "suspended") await ctx.resume();

    this.snap = { ...this.snap, compile: { ...this.snap.compile, status: "Fetching C + wabt" }, error: null };
    this.emit();

    const [, cSource] = await Promise.all([
      loadScript(assetUrl("c2wat.js")),
      fetch(assetUrl("wavetable.c")).then((r) => {
        if (!r.ok) throw new Error("Failed to fetch wavetable.c");
        return r.text();
      }),
      ctx.audioWorklet.addModule(assetUrl("worklets/wavetable-processor.js") + "?v=7"),
    ]);
    this.snap = { ...this.snap, cSource };
    this.emit();

    const compiled = await compileCToWasm(cSource, (status) => {
      this.snap = { ...this.snap, compile: { ...this.snap.compile, status } };
      this.emit();
    });
    this.snap = {
      ...this.snap,
      compile: { status: "ready", wasmBytes: compiled.bytes, ms: compiled.ms },
    };
    this.emit();
    const wasmBuf = compiled.buffer;

    const node = new AudioWorkletNode(ctx, "wavetable-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      parameterData: { frequency: this.snap.freq, gain: 0 },
    });
    node.port.onmessage = (ev) => this.onWorklet(ev.data);

    const gain = ctx.createGain();
    gain.gain.value = 0.9;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.5;

    node.connect(gain);
    gain.connect(analyser);
    analyser.connect(ctx.destination);

    this.node = node;
    this.gainNode = gain;
    this.analyser = analyser;
    this.scopeBuf = new Uint8Array(analyser.fftSize);
    this.freqParam = node.parameters.get("frequency") ?? null;
    this.gainParam = node.parameters.get("gain") ?? null;
    this.freq2Param = node.parameters.get("frequency2") ?? null;
    this.gain2Param = node.parameters.get("gain2") ?? null;

    node.port.postMessage({ type: "wasm", bytes: wasmBuf });
    node.port.postMessage({ type: "engine", engine: this.snap.engine });
    node.port.postMessage({ type: "wave", wave: this.snap.wave });
    node.port.postMessage({ type: "voices", n: this.snap.voices });
    node.port.postMessage({ type: "live", on: true });
  }

  private onWorklet(data: unknown) {
    if (!data || typeof data !== "object") return;
    const msg = data as {
      type?: string;
      pages?: number;
      message?: string;
      quanta?: number;
      medianUs?: number;
      p99Us?: number;
      maxUs?: number;
      overruns?: number;
      nan?: number;
      inf?: number;
      grew?: number;
      lastUs?: number;
      alloc?: number;
      budgetUs?: number;
      ready?: number;
    };
    if (msg.type === "stats") {
      this.snap = {
        ...this.snap,
        memPages: msg.pages || this.snap.memPages,
        memGrew: (msg.grew ?? 0) > 0 || this.snap.memGrew,
        quanta: msg.quanta ?? this.snap.quanta,
        medianUs: msg.medianUs ?? 0,
        p99Us: msg.p99Us ?? 0,
        maxUs: msg.maxUs ?? 0,
        overruns: msg.overruns ?? 0,
        nan: msg.nan ?? 0,
        inf: msg.inf ?? 0,
        lastUs: msg.lastUs ?? 0,
        allocFlag: msg.alloc ?? 0,
        budgetUs: msg.budgetUs || this.snap.budgetUs,
        ready: (msg.ready ?? 0) > 0 || this.snap.ready,
      };
      if (this.snap.discipline.running) {
        this.snap = {
          ...this.snap,
          discipline: {
            ...this.snap.discipline,
            pages: this.snap.memPages,
            grew: this.snap.memGrew,
            nan: this.snap.nan,
            inf: this.snap.inf,
            overruns: this.snap.overruns,
            allocFlag: this.snap.allocFlag,
            quanta: this.snap.quanta,
            p99Us: this.snap.p99Us,
          },
        };
      }
      this.scheduleEmit();
      return;
    }
    if (msg.type === "measure") {
      const m = data as {
        meanUs?: number;
        medianUs?: number;
        p99Us?: number;
        maxUs?: number;
        nan?: number;
        inf?: number;
        pages?: number;
        budgetUs?: number;
        iters?: number;
        engine?: EngineKind;
        voices?: number;
      };
      const budget = m.budgetUs || this.snap.budgetUs;
      const p99 = m.p99Us ?? m.meanUs ?? 0;
      const row: BenchRow = {
        engine: m.engine ?? this.snap.engine,
        voices: m.voices ?? this.snap.voices,
        quanta: m.iters ?? 0,
        medianUs: m.medianUs ?? m.meanUs ?? 0,
        p99Us: p99,
        maxUs: m.maxUs ?? p99,
        overruns: p99 > budget * 0.5 ? 1 : 0,
        nan: m.nan ?? 0,
        inf: m.inf ?? 0,
        budgetUs: budget,
        underHalf: p99 < budget * 0.5,
      };
      this.snap = {
        ...this.snap,
        medianUs: row.medianUs,
        p99Us: row.p99Us,
        maxUs: row.maxUs,
        nan: row.nan,
        inf: row.inf,
        memPages: m.pages || this.snap.memPages,
        budgetUs: budget,
      };
      this.measureWait?.resolve(row);
      this.measureWait = null;
      this.emit();
      return;
    }
    if (msg.type === "ready") {
      this.snap = {
        ...this.snap,
        ready: true,
        error: null,
        memPages: msg.pages ?? 1,
      };
      this.emit();
    } else if (msg.type === "error") {
      this.snap = { ...this.snap, error: msg.message ?? "Worklet error" };
      this.measureWait?.reject(new Error(msg.message ?? "Worklet error"));
      this.measureWait = null;
      this.emit();
    }
  }

  async start() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      void this.ctx.resume();
    } else if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    try {
      await this.ensure();
    } catch (e) {
      this.snap = {
        ...this.snap,
        error: String(e instanceof Error ? e.message : e),
        playing: false,
        compile: { ...this.snap.compile, status: "failed" },
      };
      this.emit();
      return;
    }
    await this.waitReady();
    this.node?.port.postMessage({ type: "live", on: true });
    this.node?.port.postMessage({ type: "reset" });
    const t = this.ctx.currentTime;
    this.freqParam?.setTargetAtTime(this.snap.freq, t, 0.008);
    this.gainParam?.setTargetAtTime(this.snap.gain, t, 0.005);
    this.gain2Param?.setTargetAtTime(0, t, 0.005);
    this.playOrigin = t;
    this.snap = {
      ...this.snap,
      playing: true,
      playSeconds: 0,
      error: null,
      invention: { ...this.snap.invention, playing: false, beat: 0 },
      hold: this.snap.hold.target
        ? { ...this.snap.hold, done: false, nan: 0, overruns: 0 }
        : this.snap.hold,
    };
    this.emit();
    this.armPlayClock();
  }

  async hold(seconds = 120) {
    this.clearTune();
    this.snap = {
      ...this.snap,
      hold: { target: seconds, done: false, nan: 0, overruns: 0 },
    };
    await this.start();
  }

  async playTune() {
    this.snap = {
      ...this.snap,
      hold: { target: null, done: false, nan: 0, overruns: 0 },
    };
    await this.start();
    if (!this.ctx || !this.freqParam || !this.gainParam) return;
    const now = this.ctx.currentTime;
    this.gainParam.cancelScheduledValues(now);
    this.freqParam.cancelScheduledValues(now);
    this.gainParam.setValueAtTime(0.0001, now);
    this.activeTune = ODE_TO_JOY;
    this.tuneOrigin = now + 0.06;
    this.snap = {
      ...this.snap,
      tune: { playing: true, name: ODE_TO_JOY.name, note: ODE_TO_JOY.notes[0]?.n ?? "", index: 0 },
    };
    this.emit();
    this.armTune(this.tuneOrigin);
  }

  async playInvention(score: Invention) {
    this.clearTune();
    this.snap = {
      ...this.snap,
      hold: { target: null, done: false, nan: 0, overruns: 0 },
      wave: "saw",
    };
    try {
      await this.ensure();
    } catch (e) {
      this.snap = {
        ...this.snap,
        error: String(e instanceof Error ? e.message : e),
        compile: { ...this.snap.compile, status: "failed" },
      };
      this.emit();
      return;
    }
    await this.waitReady();
    if (!this.ctx || !this.freqParam || !this.gainParam) return;
    this.node?.port.postMessage({ type: "live", on: 2 });
    this.node?.port.postMessage({ type: "voices", n: 2 });
    this.node?.port.postMessage({ type: "wave", wave: "saw" });
    this.node?.port.postMessage({ type: "detune", value: 0 });
    this.node?.port.postMessage({ type: "reset" });

    const t0 = this.ctx.currentTime + 0.08;
    const beat = 60 / score.bpm;
    this.scheduleVoice(this.freqParam, this.gainParam, score.voice1, t0, beat, 0.2);
    if (this.freq2Param && this.gain2Param) {
      this.scheduleVoice(this.freq2Param, this.gain2Param, score.voice2, t0, beat, 0.26);
    }
    this.playOrigin = t0;
    this.snap = {
      ...this.snap,
      playing: true,
      playSeconds: 0,
      error: null,
      invention: { playing: true, beat: 0, bpm: score.bpm, total: score.beats },
    };
    this.emit();
    this.armPlayClock();
  }

  private scheduleVoice(
    freq: AudioParam,
    gain: AudioParam,
    notes: ScoreNote[],
    t0: number,
    beat: number,
    peak: number,
  ) {
    freq.cancelScheduledValues(t0);
    gain.cancelScheduledValues(t0);
    gain.setValueAtTime(0.0001, t0);
    const sorted = notes.slice().sort((a, b) => a.time - b.time);
    for (const note of sorted) {
      const t = t0 + note.time * beat;
      const dur = Math.max(0.04, note.duration * beat);
      const hz = midiToHz(note.midi);
      const atk = 0.005;
      const rel = Math.min(0.07, dur * 0.3);
      freq.setValueAtTime(hz, t);
      gain.setValueAtTime(0.0001, t);
      gain.linearRampToValueAtTime(peak, t + atk);
      const decayEnd = Math.min(t + dur - rel, t + atk + 0.16);
      if (decayEnd > t + atk) gain.linearRampToValueAtTime(peak * 0.18, decayEnd);
      gain.linearRampToValueAtTime(0.0001, t + dur);
    }
  }

  private armTune(from: number) {
    const tune = this.activeTune;
    const freq = this.freqParam;
    const gain = this.gainParam;
    const ctx = this.ctx;
    if (!tune || !freq || !gain || !ctx) return;
    const beat = 60 / tune.bpm;
    const peak = Math.max(0.08, this.snap.gain);
    freq.cancelScheduledValues(from);
    gain.cancelScheduledValues(from);
    gain.setValueAtTime(0.0001, from);
    let t = from;
    for (const note of tune.notes) {
      const hz = noteHz(note.n);
      const dur = note.d * beat;
      const atk = Math.min(0.01, dur * 0.15);
      const rel = Math.min(0.03, dur * 0.22);
      if (hz > 0) {
        freq.setValueAtTime(hz, t);
        gain.setValueAtTime(0.0001, t);
        gain.linearRampToValueAtTime(peak, t + atk);
        const holdT = Math.max(t + atk, t + dur - rel);
        gain.setValueAtTime(peak, holdT);
        gain.linearRampToValueAtTime(0.0001, t + dur);
      } else {
        gain.setValueAtTime(0.0001, t);
      }
      t += dur;
    }
    const loop = t - from;
    const wait = Math.max(40, (t - ctx.currentTime - 0.12) * 1000);
    if (this.tuneTimer) clearTimeout(this.tuneTimer);
    this.tuneTimer = window.setTimeout(() => {
      this.tuneTimer = 0;
      if (!this.activeTune || !this.snap.playing || !this.ctx) return;
      this.tuneOrigin += loop;
      this.armTune(this.tuneOrigin);
    }, wait);
  }

  private clearTune() {
    if (this.tuneTimer) {
      clearTimeout(this.tuneTimer);
      this.tuneTimer = 0;
    }
    this.activeTune = null;
    if (this.snap.tune.playing) {
      this.snap = {
        ...this.snap,
        tune: { playing: false, name: "", note: "", index: -1 },
      };
    }
  }

  stop() {
    this.clearTune();
    if (!this.ctx || !this.gainParam) {
      this.snap = {
        ...this.snap,
        playing: false,
        invention: { ...this.snap.invention, playing: false },
      };
      this.emit();
      return;
    }
    const t = this.ctx.currentTime;
    this.gainParam.cancelScheduledValues(t);
    this.freqParam?.cancelScheduledValues(t);
    this.gain2Param?.cancelScheduledValues(t);
    this.freq2Param?.cancelScheduledValues(t);
    this.gainParam.setTargetAtTime(0, t, 0.008);
    this.gain2Param?.setTargetAtTime(0, t, 0.008);
    this.node?.port.postMessage({ type: "note_off" });
    this.snap = {
      ...this.snap,
      playing: false,
      invention: { ...this.snap.invention, playing: false },
    };
    this.emit();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private armPlayClock() {
    if (this.raf) cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.snap.playing || !this.ctx) return;
      const playSeconds = Math.max(0, this.ctx.currentTime - this.playOrigin);
      const target = this.snap.hold.target;
      let tune = this.snap.tune;
      if (this.activeTune) {
        const at = noteAt(this.activeTune, this.ctx.currentTime - this.tuneOrigin);
        if (at.n !== tune.note || at.i !== tune.index) {
          tune = { playing: true, name: this.activeTune.name, note: at.n, index: at.i };
        }
      }
      let invention = this.snap.invention;
      if (invention.playing) {
        const beat = Math.max(0, (this.ctx.currentTime - this.playOrigin) * (invention.bpm / 60));
        invention = { ...invention, beat };
        if (beat >= invention.total) {
          this.snap = { ...this.snap, playSeconds, tune, invention: { ...invention, beat: invention.total } };
          this.stop();
          return;
        }
      }
      this.snap = { ...this.snap, playSeconds, tune, invention };
      if (target && playSeconds >= target) {
        this.snap = {
          ...this.snap,
          hold: {
            target,
            done: true,
            nan: this.snap.nan,
            overruns: this.snap.overruns,
          },
        };
        this.stop();
        return;
      }
      this.listeners.forEach((fn) => fn());
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  setEngine(kind: EngineKind) {
    this.snap = { ...this.snap, engine: kind };
    this.node?.port.postMessage({ type: "engine", engine: kind });
    this.emit();
  }

  setWave(wave: WaveKind) {
    this.snap = { ...this.snap, wave };
    this.node?.port.postMessage({ type: "wave", wave });
    this.emit();
  }

  setFreq(hz: number) {
    const freq = Math.min(8000, Math.max(20, hz));
    this.snap = { ...this.snap, freq };
    const ctx = this.ctx;
    if (ctx && this.freqParam) this.freqParam.setTargetAtTime(freq, ctx.currentTime, 0.008);
    this.emit();
  }

  setGain(g: number) {
    const gain = Math.min(1, Math.max(0, g));
    this.snap = { ...this.snap, gain };
    if (this.snap.playing && this.ctx && this.gainParam) {
      this.gainParam.setTargetAtTime(gain, this.ctx.currentTime, 0.005);
    }
    this.emit();
  }

  setVoices(n: number) {
    const voices = Math.min(32, Math.max(1, n | 0));
    this.snap = { ...this.snap, voices };
    this.node?.port.postMessage({ type: "voices", n: voices });
    this.emit();
  }

  cancelBench() {
    this.benchCancel = true;
    this.snap = { ...this.snap, bench: { ...this.snap.bench, cancelling: true } };
    this.emit();
  }

  cancelDiscipline() {
    this.discCancel = true;
    this.emit();
  }

  async runBench(opts: { protocol: BenchProtocol }) {
    await this.ensure();
    await this.waitReady();
    if (!this.ctx || !this.node || !this.gainParam) return;
    this.benchCancel = false;
    const protocol = opts.protocol;
    const dur = DUR[protocol];
    const total = VOICE_STEPS.length * 2;
    this.snap = {
      ...this.snap,
      playing: false,
      bench: {
        running: true,
        cancelling: false,
        protocol,
        progressLabel: "Arming…",
        current: 0,
        total,
        rows: [],
        crossover: "",
        maxStableJs: null,
        maxStableWasm: null,
      },
    };
    this.emit();

    this.gainParam.setTargetAtTime(0, this.ctx.currentTime, 0.01);
    this.node.port.postMessage({ type: "live", on: false });

    const engines: EngineKind[] = ["js", "wasm"];
    const rows: BenchRow[] = [];
    let step = 0;

    for (const engine of engines) {
      for (const voices of VOICE_STEPS) {
        if (this.benchCancel) break;
        step++;
        this.snap = {
          ...this.snap,
          bench: {
            ...this.snap.bench,
            current: step,
            progressLabel: `${engine.toUpperCase()} · ${voices} voice${voices === 1 ? "" : "s"}`,
          },
        };
        this.emit();
        const row = await this.runCell(engine, voices, dur);
        if (row) {
          rows.push(row);
          const summary = summarize(rows);
          this.snap = {
            ...this.snap,
            bench: { ...this.snap.bench, rows: rows.slice(), ...summary },
          };
          this.emit();
        }
      }
    }

    this.node.port.postMessage({ type: "live", on: true });
    this.node.port.postMessage({ type: "note_off" });
    this.node.port.postMessage({ type: "engine", engine: this.snap.engine });
    this.node.port.postMessage({ type: "voices", n: this.snap.voices });
    const summary = summarize(rows);
    this.snap = {
      ...this.snap,
      bench: {
        ...this.snap.bench,
        running: false,
        cancelling: false,
        progressLabel: this.benchCancel ? "Cancelled" : "Done",
        rows: rows.slice(),
        ...summary,
      },
    };
    this.emit();
  }

  private voiceChord(n: number): Float32Array {
    const packed = new Float32Array(1 + n * 2);
    packed[0] = n;
    const g = 0.22 / Math.sqrt(n);
    for (let i = 0; i < n; i++) {
      packed[1 + i * 2] = 110 * Math.pow(2, (i % 24) / 12);
      packed[2 + i * 2] = g;
    }
    return packed;
  }

  private wait(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async waitReady() {
    await this.ensure();
    const t0 = Date.now();
    while (!this.snap.ready && Date.now() - t0 < 8000) {
      await this.wait(50);
    }
  }

  private async runCell(engine: EngineKind, voices: number, seconds: number): Promise<BenchRow | null> {
    if (!this.node) return null;
    this.node.port.postMessage({ type: "engine", engine });
    this.node.port.postMessage({ type: "reset" });
    this.node.port.postMessage({ type: "set_voices_abs", packed: this.voiceChord(voices) });
    await this.wait(40);
    if (this.benchCancel) return null;
    const ms = seconds <= 2 ? 160 : seconds <= 5 ? 280 : 500;
    const row = await new Promise<BenchRow>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("measure timeout")), 20000);
      this.measureWait = {
        resolve: (r) => {
          clearTimeout(t);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      };
      this.node!.port.postMessage({ type: "measure", ms, frames: 128 });
    }).catch(() => null);
    if (this.benchCancel) return null;
    return row;
  }

  async runDiscipline(seconds: number) {
    await this.ensure();
    await this.waitReady();
    if (!this.ctx || !this.node || !this.gainParam) return;
    this.discCancel = false;
    const prevEngine = this.snap.engine;
    const prevVoices = this.snap.voices;
    this.setEngine("wasm");
    this.setVoices(32);
    this.node.port.postMessage({ type: "live", on: false });
    this.node.port.postMessage({ type: "reset" });
    this.node.port.postMessage({ type: "set_voices_abs", packed: this.voiceChord(32) });
    const startPages = this.snap.memPages;
    this.snap = {
      ...this.snap,
      playing: false,
      discipline: {
        running: true,
        seconds,
        elapsed: 0,
        startPages,
        pages: startPages,
        grew: false,
        nan: 0,
        inf: 0,
        overruns: 0,
        allocFlag: 0,
        quanta: 0,
        p99Us: 0,
        done: false,
      },
    };
    this.emit();

    const t0 = performance.now();
    while (!this.discCancel) {
      const elapsed = (performance.now() - t0) / 1000;
      this.snap = {
        ...this.snap,
        discipline: {
          ...this.snap.discipline,
          elapsed,
          pages: this.snap.memPages,
          grew: this.snap.memGrew || this.snap.memPages !== startPages,
          nan: this.snap.nan,
          inf: this.snap.inf,
          overruns: this.snap.overruns,
          allocFlag: this.snap.allocFlag,
          quanta: this.snap.quanta,
          p99Us: this.snap.p99Us,
        },
      };
      this.emit();
      if (elapsed >= seconds) break;
      await this.wait(250);
    }

    this.node.port.postMessage({ type: "note_off" });
    this.node.port.postMessage({ type: "live", on: true });
    this.setEngine(prevEngine);
    this.setVoices(prevVoices);
    this.snap = {
      ...this.snap,
      discipline: {
        ...this.snap.discipline,
        running: false,
        done: !this.discCancel,
        elapsed: Math.min(seconds, this.snap.discipline.elapsed),
      },
    };
    this.emit();
  }
}

let singleton: CoreEngine | null = null;

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[data-core-src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.dataset.coreSrc = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
}

type WabtMod = {
  parseWat: (
    name: string,
    wat: string,
  ) => { toBinary: (opts: { write_debug_names: boolean }) => { buffer: ArrayBuffer }; destroy: () => void };
};

async function loadWabt(): Promise<WabtMod> {
  const w = (globalThis as { WabtModule?: () => Promise<WabtMod> }).WabtModule;
  if (typeof w === "function") return w();
  try {
    await loadScript("https://cdn.jsdelivr.net/npm/wabt@1.0.36/index.js");
  } catch {
    await loadScript(assetUrl("vendor/wabt.js"));
  }
  const w2 = (globalThis as { WabtModule?: () => Promise<WabtMod> }).WabtModule;
  if (typeof w2 !== "function") throw new Error("wabt did not load");
  return w2();
}

async function compileCToWasm(
  src: string,
  onStatus: (s: string) => void,
): Promise<{ buffer: ArrayBuffer; bytes: number; ms: number }> {
  onStatus("Loading wabt…");
  const wabt = await loadWabt();
  const compile = (globalThis as { compileCToWat?: (s: string) => { wat: string } }).compileCToWat;
  if (typeof compile !== "function") throw new Error("c2wat did not load");
  onStatus("Parsing wavetable.c");
  const t0 = performance.now();
  const { wat } = compile(src);
  onStatus("Assembling WASM");
  const parsed = wabt.parseWat("wavetable.wat", wat);
  const bin = parsed.toBinary({ write_debug_names: false });
  parsed.destroy();
  return { buffer: bin.buffer, bytes: bin.buffer.byteLength, ms: Math.round(performance.now() - t0) };
}

export function getEngine(): CoreEngine {
  if (!singleton) singleton = new CoreEngine();
  return singleton;
}

declare global {
  interface Window {
    __core?: CoreApi;
  }
}
