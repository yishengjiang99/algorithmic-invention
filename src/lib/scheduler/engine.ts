import {
  DEFAULT_TEMPO,
  LOOKAHEAD_MAX,
  LOOKAHEAD_MIN,
  PATTERN_FREQ,
  STEP_COUNT,
  stepDuration,
} from "./pattern";
import {
  decodeStats,
  emptyExperiment,
  emptyWorkletStats,
  pickWinner,
  type ExperimentRow,
  type ExperimentState,
  type WorkletStats,
} from "./stats";
import { assetUrl } from "@/lib/asset";

export type AheadSnapshot = {
  playing: boolean;
  lookAheadMs: number;
  volume: number;
  muted: boolean;
  step: number;
  tempo: number;
  measuredBpm: number;
  error: string | null;
  workletReady: boolean;
  endurance: EnduranceState;
  stats: WorkletStats & {
    timerFires: number;
    notesPosted: number;
    stallCount: number;
  };
  experiment: ExperimentState;
};

export type EnduranceState = {
  running: boolean;
  remainingMs: number;
  durationMs: number;
  result: {
    played: number;
    skipped: number;
    dupes: number;
    missed: number;
    measuredBpm: number;
    ok: boolean;
  } | null;
};

const DEFAULT_ENDURANCE: EnduranceState = {
  running: false,
  remainingMs: 0,
  durationMs: 120_000,
  result: null,
};

const DEFAULT_STATS: AheadSnapshot["stats"] = {
  ...emptyWorkletStats(),
  timerFires: 0,
  notesPosted: 0,
  stallCount: 0,
};

function defaultSnapshot(): AheadSnapshot {
  return {
    playing: false,
    lookAheadMs: 50,
    volume: 0.7,
    muted: false,
    step: 0,
    tempo: DEFAULT_TEMPO,
    measuredBpm: DEFAULT_TEMPO,
    error: null,
    workletReady: false,
    endurance: { ...DEFAULT_ENDURANCE },
    stats: { ...DEFAULT_STATS },
    experiment: emptyExperiment(),
  };
}

const MAX_BATCH = 128;
const PACK_STRIDE = 4;

function stallMainThread(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* intentional busy-wait — experiment stall */
  }
}

function sleep(ms: number, signal?: { cancelled: boolean }) {
  return new Promise<void>((resolve) => {
    const start = performance.now();
    const tick = () => {
      if (signal?.cancelled || performance.now() - start >= ms) {
        resolve();
        return;
      }
      window.setTimeout(tick, 40);
    };
    window.setTimeout(tick, Math.min(40, ms));
  });
}

export class LookaheadEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private master: GainNode | null = null;
  private scopeBuf: Uint8Array | null = null;
  private pack = new Float64Array(1 + MAX_BATCH * PACK_STRIDE);
  private timer: number | null = null;
  private raf: number | null = null;
  private stallTimer: number | null = null;
  private enduranceTimer: number | null = null;
  private starting = false;
  private origin = 0;
  private nextNoteTime = 0;
  private stepIndex = 0;
  private noteId = 1;
  private timerFires = 0;
  private notesPosted = 0;
  private stallCount = 0;
  private listeners = new Set<() => void>();
  private snap: AheadSnapshot = defaultSnapshot();
  private workletStats = emptyWorkletStats();
  private cancelFlag = { cancelled: false };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): AheadSnapshot => this.snap;

  getServerSnapshot = (): AheadSnapshot => this.snap;

  getAnalyser() {
    return this.analyser;
  }

  getScopeBuffer() {
    return this.scopeBuf;
  }

  getContext() {
    return this.ctx;
  }

  private emit() {
    let measuredBpm = this.snap.tempo;
    if (this.ctx && this.origin > 0) {
      const elapsed = this.ctx.currentTime - this.origin;
      if (elapsed > 0.4) {
        const consumed = Math.max(
          0,
          this.workletStats.received - this.workletStats.queue,
        );
        measuredBpm = (consumed / elapsed) * 15;
      }
    }

    let step = 0;
    if (this.snap.playing && this.ctx) {
      const dur = stepDuration(this.snap.tempo);
      const elapsedAudio = Math.max(0, this.ctx.currentTime - this.origin);
      step = Math.floor(elapsedAudio / dur) % STEP_COUNT;
    }

    this.snap = {
      ...this.snap,
      step,
      measuredBpm: Number.isFinite(measuredBpm) ? measuredBpm : this.snap.tempo,
      stats: {
        ...this.workletStats,
        timerFires: this.timerFires,
        notesPosted: this.notesPosted,
        stallCount: this.stallCount,
      },
    };
    for (const listener of this.listeners) listener();
  }

  private applyGain() {
    if (!this.master || !this.ctx) return;
    const linear = this.snap.muted ? 0 : this.snap.volume * this.snap.volume;
    this.master.gain.setTargetAtTime(linear, this.ctx.currentTime, 0.02);
  }

  private onWorkletMessage = (event: MessageEvent<Float64Array>) => {
    const data = event.data;
    if (!(data instanceof Float64Array)) return;
    this.workletStats = decodeStats(data);
    this.emit();
  };

  private async ensureGraph() {
    if (this.node && this.ctx) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return;
    }
    const ctx = this.ctx ?? new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    if (ctx.state === "suspended") await ctx.resume();
    try {
      await ctx.audioWorklet.addModule(assetUrl("worklets/lookahead-processor.js"));
    } catch {
      this.snap = {
        ...this.snap,
        error:
          "AudioWorklet is not available here. Open this lab in a browser that supports AudioWorklet.",
      };
      this.emit();
      throw new Error("audioworklet");
    }
    const node = new AudioWorkletNode(ctx, "lookahead-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.4;
    const master = ctx.createGain();
    master.gain.value = 0;
    node.connect(analyser);
    analyser.connect(master);
    master.connect(ctx.destination);
    node.port.onmessage = this.onWorkletMessage;
    this.node = node;
    this.analyser = analyser;
    this.master = master;
    this.scopeBuf = new Uint8Array(analyser.fftSize);
    this.snap = { ...this.snap, workletReady: true, error: null };
    this.applyGain();
  }

  /** Must be invoked synchronously from a user gesture. */
  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
    }
    void this.ctx.resume();
  }

  startFromGesture() {
    this.unlock();
    return this.start();
  }

  async start() {
    if (this.snap.playing || this.starting) return;
    this.starting = true;
    try {
      await this.ensureGraph();
      if (!this.ctx || !this.node) return;
      this.resetTransport();
      this.snap = {
        ...this.snap,
        playing: true,
        endurance: { ...this.snap.endurance, result: null },
      };
      this.applyGain();
      this.armPlayhead();
      this.tick();
      this.emit();
    } catch {
      /* error already on snapshot */
    } finally {
      this.starting = false;
    }
  }

  stop() {
    this.snap = { ...this.snap, playing: false };
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    if (this.enduranceTimer !== null) {
      window.clearInterval(this.enduranceTimer);
      this.enduranceTimer = null;
    }
    this.stopStalls();
    this.node?.port.postMessage(1);
    this.applyGain();
    this.emit();
  }

  dispose() {
    this.stop();
    this.cancelFlag.cancelled = true;
    void this.ctx?.close();
    this.ctx = null;
    this.node = null;
    this.analyser = null;
    this.master = null;
  }

  setLookAhead(ms: number) {
    const lookAheadMs = Math.min(
      LOOKAHEAD_MAX,
      Math.max(LOOKAHEAD_MIN, Math.round(ms)),
    );
    this.snap = { ...this.snap, lookAheadMs };
    this.emit();
  }

  setVolume(volume: number) {
    this.snap = { ...this.snap, volume: Math.min(1, Math.max(0, volume)) };
    this.applyGain();
    this.emit();
  }

  setMuted(muted: boolean) {
    this.snap = { ...this.snap, muted };
    this.applyGain();
    this.emit();
  }

  private resetTransport() {
    if (!this.ctx || !this.node) return;
    this.node.port.postMessage(1);
    this.timerFires = 0;
    this.notesPosted = 0;
    this.stallCount = 0;
    this.noteId = 1;
    this.stepIndex = 0;
    this.workletStats = emptyWorkletStats();
    this.origin = this.ctx.currentTime + 0.04;
    this.nextNoteTime = this.origin;
  }

  private armPlayhead() {
    const loop = () => {
      if (!this.snap.playing) return;
      this.emit();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private tick = () => {
    if (!this.snap.playing || !this.ctx || !this.node) return;
    const now = this.ctx.currentTime;
    const look = this.snap.lookAheadMs / 1000;
    const horizon = now + look;
    const dur = stepDuration(this.snap.tempo);

    if (this.nextNoteTime < now - 0.25) {
      const missedSteps = Math.floor((now - this.nextNoteTime) / dur);
      this.stepIndex = (this.stepIndex + missedSteps) % STEP_COUNT;
      this.nextNoteTime += missedSteps * dur;
    }

    let n = 0;
    while (this.nextNoteTime < horizon && n < MAX_BATCH) {
      const freq = PATTERN_FREQ[this.stepIndex] ?? 0;
      const o = 1 + n * PACK_STRIDE;
      this.pack[o] = this.nextNoteTime;
      this.pack[o + 1] = freq;
      this.pack[o + 2] = freq > 0 ? 0.85 : 0;
      this.pack[o + 3] = this.noteId;
      this.noteId += 1;
      n += 1;
      this.nextNoteTime += dur;
      this.stepIndex = (this.stepIndex + 1) % STEP_COUNT;
    }

    this.pack[0] = n;
    if (n > 0) {
      this.node.port.postMessage(this.pack);
      this.notesPosted += n;
    }
    this.timerFires += 1;

    const interval = Math.max(4, Math.min(25, this.snap.lookAheadMs * 0.5));
    this.timer = window.setTimeout(this.tick, interval);
  };

  private stopStalls() {
    if (this.stallTimer !== null) {
      window.clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private startStalls(stallMs: number, everyMs: number) {
    this.stopStalls();
    this.stallTimer = window.setInterval(() => {
      stallMainThread(stallMs);
      this.stallCount += 1;
    }, everyMs);
  }

  async runEndurance(durationMs = 120_000) {
    this.stop();
    this.snap = {
      ...this.snap,
      endurance: {
        running: true,
        remainingMs: durationMs,
        durationMs,
        result: null,
      },
    };
    this.emit();
    await this.start();
    const started = performance.now();
    await new Promise<void>((resolve) => {
      this.enduranceTimer = window.setInterval(() => {
        const remaining = Math.max(0, durationMs - (performance.now() - started));
        this.snap = {
          ...this.snap,
          endurance: { ...this.snap.endurance, remainingMs: remaining },
        };
        this.emit();
        if (remaining <= 0) {
          if (this.enduranceTimer !== null) {
            window.clearInterval(this.enduranceTimer);
            this.enduranceTimer = null;
          }
          resolve();
        }
      }, 200);
    });
    const stats = this.workletStats;
    const bpm = this.snap.measuredBpm;
    this.stop();
    const ok =
      stats.skips === 0 && stats.dupes === 0 && stats.missed === 0 && stats.played > 0;
    this.snap = {
      ...this.snap,
      endurance: {
        running: false,
        remainingMs: 0,
        durationMs,
        result: {
          played: stats.played,
          skipped: stats.skips,
          dupes: stats.dupes,
          missed: stats.missed,
          measuredBpm: bpm,
          ok,
        },
      },
    };
    this.emit();
    return this.snap.endurance.result;
  }

  async runExperiment(opts: {
    protocol: "probe" | "quick" | "full";
    lookAheads?: number[];
    stallMs?: number;
    stallEveryMs?: number;
    runMs?: number;
    runs?: number;
  }) {
    if (this.snap.experiment.running) return;
    this.stop();
    const lookAheads = opts.lookAheads ?? [10, 25, 50, 100, 200];
    const runs =
      opts.runs ?? (opts.protocol === "probe" ? 1 : 3);
    const runMs =
      opts.runMs ??
      (opts.protocol === "full" ? 60_000 : opts.protocol === "quick" ? 12_000 : 5_000);
    const stallMs = opts.stallMs ?? 20;
    const stallEveryMs = opts.stallEveryMs ?? 80;
    const total = lookAheads.length * runs;
    this.cancelFlag = { cancelled: false };
    this.snap = {
      ...this.snap,
      experiment: {
        running: true,
        cancelling: false,
        protocol: opts.protocol,
        progressLabel: "Starting…",
        completed: 0,
        total,
        rows: [],
        winnerMs: null,
        hypothesisHeld: null,
      },
    };
    this.emit();

    const rows: ExperimentRow[] = [];
    try {
      for (const la of lookAheads) {
        for (let run = 1; run <= runs; run++) {
          if (this.cancelFlag.cancelled) break;
          this.setLookAhead(la);
          this.snap = {
            ...this.snap,
            experiment: {
              ...this.snap.experiment,
              progressLabel: `${la} ms · run ${run}/${runs}`,
            },
          };
          this.emit();
          await this.start();
          this.startStalls(stallMs, stallEveryMs);
          await sleep(runMs, this.cancelFlag);
          this.stopStalls();
          this.node?.port.postMessage(2);
          await sleep(40);
          const stats = this.workletStats;
          const row: ExperimentRow = {
            lookAheadMs: la,
            run,
            durationMs: runMs,
            played: stats.played,
            late: stats.late,
            missed: stats.missed,
            skips: stats.skips,
            dupes: stats.dupes,
            underruns: stats.underruns,
            queueMax: stats.queueMax,
            errMeanMs: stats.errMeanMs,
            errMaxMs: stats.errMaxMs,
            within5pct: stats.within5pct,
            stallCount: this.stallCount,
            timerFires: this.timerFires,
            notesPosted: this.notesPosted,
          };
          rows.push(row);
          this.stop();
          const { winnerMs, hypothesisHeld } = pickWinner(rows);
          this.snap = {
            ...this.snap,
            experiment: {
              ...this.snap.experiment,
              completed: rows.length,
              rows: [...rows],
              winnerMs,
              hypothesisHeld,
              progressLabel: this.cancelFlag.cancelled
                ? "Cancelled"
                : `${la} ms · run ${run}/${runs} done`,
            },
          };
          this.emit();
          await sleep(250, this.cancelFlag);
        }
        if (this.cancelFlag.cancelled) break;
      }
    } finally {
      this.stopStalls();
      this.stop();
      const { winnerMs, hypothesisHeld } = pickWinner(rows);
      this.snap = {
        ...this.snap,
        experiment: {
          ...this.snap.experiment,
          running: false,
          cancelling: false,
          rows,
          winnerMs,
          hypothesisHeld,
          completed: rows.length,
          progressLabel: this.cancelFlag.cancelled
            ? "Cancelled"
            : rows.length === total
              ? "Complete"
              : "Stopped",
        },
      };
      this.emit();
    }
  }

  cancelExperiment() {
    this.cancelFlag.cancelled = true;
    this.snap = {
      ...this.snap,
      experiment: {
        ...this.snap.experiment,
        cancelling: true,
        progressLabel: "Cancelling…",
      },
    };
    this.emit();
  }

  api() {
    return {
      start: () => this.startFromGesture(),
      stop: () => this.stop(),
      unlock: () => this.unlock(),
      setLookAhead: (ms: number) => this.setLookAhead(ms),
      getSnapshot: () => this.getSnapshot(),
      runExperiment: (protocol: "probe" | "quick" | "full" = "probe") =>
        this.runExperiment({ protocol }),
      runCustomExperiment: (
        opts: Parameters<LookaheadEngine["runExperiment"]>[0],
      ) => this.runExperiment(opts),
      runEndurance: (ms?: number) => this.runEndurance(ms),
      cancelExperiment: () => this.cancelExperiment(),
    };
  }
}

let engine: LookaheadEngine | null = null;

export function getEngine(): LookaheadEngine {
  if (!engine) engine = new LookaheadEngine();
  return engine;
}
