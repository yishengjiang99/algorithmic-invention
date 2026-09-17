/**
 * WavetableProcessor
 *
 * Two render paths share the same band-limited mipmapped wavetable:
 *   - WASM: rustc --target wasm32-unknown-unknown, memory 1/1 page
 *   - JS:   identical loop over preallocated tables
 *
 * process() contract:
 *   no new arrays, objects, strings, or WASM calls other than render()
 *   views bound once after instantiate; memory cannot grow (max 1 page)
 */

const TABLE = 1024;
const TABLE_MASK = 1023;
const TABLES = 6;
const MAX_VOICES = 32;
const OUT_CAP = 256;
const BINS = 256;
const POST_EVERY = 32;

function nowMs() {
  const p = globalThis.performance;
  if (p && typeof p.now === "function") return p.now();
  return Date.now();
}

function tableIndex(freq) {
  let t = 0;
  let edge = 110;
  while (t + 1 < TABLES && freq >= edge) {
    edge *= 2;
    t++;
  }
  return t;
}

function harmonicsForTable(t, sr) {
  const nyq = sr * 0.5;
  const fHi = t + 1 === TABLES ? nyq : 110 * (1 << t);
  const n = (nyq / fHi) | 0;
  return n < 1 ? 1 : n > 512 ? 512 : n;
}

function buildTables(sr) {
  const tables = [
    [new Float32Array(TABLE), new Float32Array(TABLE), new Float32Array(TABLE), new Float32Array(TABLE), new Float32Array(TABLE), new Float32Array(TABLE)],
    [new Float32Array(TABLE), new Float32Array(TABLE), new Float32Array(TABLE), new Float32Array(TABLE), new Float32Array(TABLE), new Float32Array(TABLE)],
  ];
  for (let wave = 0; wave < 2; wave++) {
    for (let t = 0; t < TABLES; t++) {
      const nHarm = harmonicsForTable(t, sr);
      const buf = tables[wave][t];
      let peak = 1e-12;
      for (let i = 0; i < TABLE; i++) {
        const phase = i / TABLE;
        let acc = 0;
        for (let h = 1; h <= nHarm; h++) {
          if (wave === 1 && (h & 1) === 0) continue;
          acc += Math.sin(Math.PI * 2 * h * phase) / h;
        }
        buf[i] = acc;
        const a = acc < 0 ? -acc : acc;
        if (a > peak) peak = a;
      }
      const scale = 0.85 / peak;
      for (let i = 0; i < TABLE; i++) buf[i] *= scale;
    }
  }
  return tables;
}

class WavetableProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "frequency", defaultValue: 220, minValue: 20, maxValue: 8000, automationRate: "k-rate" },
      { name: "gain", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "frequency2", defaultValue: 110, minValue: 20, maxValue: 8000, automationRate: "k-rate" },
      { name: "gain2", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.tables = buildTables(sampleRate);
    this.invSr = 1 / sampleRate;
    this.gainRamp = 1 - Math.exp(-1 / (0.005 * sampleRate));
    this.freqRamp = 1 - Math.exp(-1 / (0.008 * sampleRate));

    this.jsPhase = new Float32Array(MAX_VOICES);
    this.jsFreq = new Float32Array(MAX_VOICES);
    this.jsFreqTgt = new Float32Array(MAX_VOICES);
    this.jsGain = new Float32Array(MAX_VOICES);
    this.jsGainTgt = new Float32Array(MAX_VOICES);
    this.jsOut = new Float32Array(OUT_CAP);
    for (let i = 0; i < MAX_VOICES; i++) this.jsFreq[i] = this.jsFreqTgt[i] = 220;

    this.nVoices = 1;
    this.wave = 0;
    this.engine = 1;
    this.live = 1;
    this.detune = 0.004;

    this.wasm = null;
    this.outView = null;
    this.freqTgtView = null;
    this.gainTgtView = null;
    this.initialPages = 0;
    this.pages = 0;
    this.grew = 0;
    this.nan = 0;
    this.inf = 0;

    this.bins = new Uint32Array(BINS);
    this.binCount = 0;
    this.maxUs = 0;
    this.lastUs = 0;
    this.overruns = 0;
    this.quanta = 0;
    this.sincePost = 0;
    this.ready = 0;
    this.hasHiRes = !!(globalThis.performance && typeof globalThis.performance.now === "function");

    this.port.onmessage = (ev) => this.onMsg(ev.data);
  }

  onMsg(data) {
    if (!data) return;
    const type = data.type;
    if (type === "wasm") {
      this.bootWasm(data.module, data.bytes);
      return;
    }
    if (type === "engine") {
      this.engine = data.engine === "js" ? 0 : 1;
      return;
    }
    if (type === "wave") {
      this.wave = data.wave === "square" ? 1 : 0;
      if (this.wasm) this.wasm.set_wave(this.wave);
      return;
    }
    if (type === "voices") {
      const n = data.n | 0;
      this.nVoices = n < 1 ? 1 : n > MAX_VOICES ? MAX_VOICES : n;
      if (this.wasm) this.wasm.set_voices(this.nVoices);
      return;
    }
    if (type === "live") {
      this.live = data.on === 2 ? 2 : data.on ? 1 : 0;
      return;
    }
    if (type === "detune") {
      this.detune = +data.value || 0;
      return;
    }
    if (type === "set_voices_abs") {
      const packed = data.packed;
      const n = packed[0] | 0;
      this.nVoices = n < 1 ? 1 : n > MAX_VOICES ? MAX_VOICES : n;
      this.live = 0;
      if (this.wasm) this.wasm.set_voices(this.nVoices);
      for (let i = 0; i < this.nVoices; i++) {
        const f = packed[1 + i * 2];
        const g = packed[2 + i * 2];
        this.jsFreqTgt[i] = f;
        this.jsGainTgt[i] = g;
        if (this.freqTgtView) {
          this.freqTgtView[i] = f;
          this.gainTgtView[i] = g;
        } else if (this.wasm) {
          this.wasm.set_voice(i, f, g);
        }
      }
      return;
    }
    if (type === "note_off") {
      for (let i = 0; i < MAX_VOICES; i++) this.jsGainTgt[i] = 0;
      if (this.wasm) this.wasm.note_off_all();
      return;
    }
    if (type === "reset") {
      this.bins.fill(0);
      this.binCount = 0;
      this.maxUs = 0;
      this.lastUs = 0;
      this.overruns = 0;
      this.quanta = 0;
      this.nan = 0;
      this.inf = 0;
      if (this.wasm) this.wasm.reset_stats();
      return;
    }
    if (type === "measure") {
      this.runMeasure(data.ms | 0, data.frames | 0);
    }
  }

  async bootWasm(module, bytes) {
    try {
      let instance;
      if (module) {
        instance = await WebAssembly.instantiate(module);
      } else {
        const result = await WebAssembly.instantiate(bytes);
        instance = result.instance;
      }
      const exp = instance.exports;
      exp.init(sampleRate);
      const mem = exp.memory;
      this.initialPages = mem.buffer.byteLength >>> 16;
      this.pages = this.initialPages;
      this.outView = new Float32Array(mem.buffer, exp.out_ptr() >>> 0, OUT_CAP);
      this.freqTgtView = new Float32Array(mem.buffer, exp.freq_tgt_ptr() >>> 0, MAX_VOICES);
      this.gainTgtView = new Float32Array(mem.buffer, exp.gain_tgt_ptr() >>> 0, MAX_VOICES);
      exp.set_voices(this.nVoices);
      exp.set_wave(this.wave);
      this.wasm = exp;
      this.ready = 1;
      this.port.postMessage({ type: "ready", pages: this.pages, hiRes: this.hasHiRes ? 1 : 0 });
    } catch (err) {
      this.port.postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
    }
  }

  dsp(n) {
    const useWasm = this.engine === 1 && this.wasm && this.outView;
    if (useWasm) this.wasm.render(n);
    else this.jsRender(n);
    return useWasm;
  }

  runMeasure(ms, frames) {
    const n = frames > 0 && frames <= OUT_CAP ? frames : 128;
    ms = ms > 0 ? ms : 180;
    try {
      for (let i = 0; i < 800; i++) this.dsp(n);
      const t0 = nowMs();
      let iters = 0;
      while (nowMs() - t0 < ms) {
        this.dsp(n);
        iters++;
      }
      const dt = nowMs() - t0;
      const meanUs = iters > 0 ? (dt * 1000) / iters : 0;
      this.lastUs = meanUs;
      this.maxUs = meanUs;
      this.bins.fill(0);
      let bin = meanUs | 0;
      if (bin < 0) bin = 0;
      if (bin >= BINS) bin = BINS - 1;
      this.bins[bin] = iters;
      this.binCount = iters;
      this.port.postMessage({
        type: "measure",
        engine: this.engine === 1 ? "wasm" : "js",
        voices: this.nVoices,
        iters,
        dtMs: dt,
        meanUs,
        medianUs: meanUs,
        p99Us: meanUs,
        maxUs: meanUs,
        nan: this.wasm ? this.wasm.nan_count() : this.nan,
        inf: this.wasm ? this.wasm.inf_count() : this.inf,
        pages: this.wasm ? this.wasm.memory.buffer.byteLength >>> 16 : this.pages,
        hiRes: this.hasHiRes ? 1 : 0,
        budgetUs: n * this.invSr * 1e6,
      });
    } catch (err) {
      this.port.postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
    }
  }

  jsRender(n) {
    const out = this.jsOut;
    for (let i = 0; i < n; i++) out[i] = 0;
    const voices = this.nVoices;
    const tables = this.tables[this.wave];
    const invSr = this.invSr;
    const gRamp = this.gainRamp;
    const fRamp = this.freqRamp;
    const phase = this.jsPhase;
    const freqA = this.jsFreq;
    const freqT = this.jsFreqTgt;
    const gainA = this.jsGain;
    const gainT = this.jsGainTgt;

    for (let v = 0; v < voices; v++) {
      let freq = freqA[v] + (freqT[v] - freqA[v]) * fRamp;
      if (freq > freqT[v] - 0.001 && freq < freqT[v] + 0.001) freq = freqT[v];
      freqA[v] = freq;

      let gain = gainA[v] + (gainT[v] - gainA[v]) * gRamp;
      const dg = gain - gainT[v];
      if (dg > -1e-6 && dg < 1e-6) gain = gainT[v];
      gainA[v] = gain;

      if (gain <= 1e-8) {
        let ph = phase[v] + freq * invSr * n;
        if (ph >= 1) ph -= ph | 0;
        if (ph < 0) ph = 0;
        phase[v] = ph;
        continue;
      }

      const table = tables[tableIndex(freq)];
      const inc = freq * invSr;
      let ph = phase[v];
      for (let i = 0; i < n; i++) {
        const x = ph * TABLE;
        const i0 = x & TABLE_MASK;
        const frac = x - (x | 0);
        out[i] += (table[i0] * (1 - frac) + table[(i0 + 1) & TABLE_MASK] * frac) * gain;
        ph += inc;
        if (ph >= 1) ph -= 1;
      }
      phase[v] = ph;
    }

    for (let i = 0; i < n; i++) {
      const x = out[i];
      if (x === x && x !== Infinity && x !== -Infinity) continue;
      if (x !== x) this.nan++;
      else this.inf++;
      out[i] = 0;
    }
  }

  applyDuetParams(f1, g1, f2, g2) {
    if (this.nVoices !== 2) {
      this.nVoices = 2;
      if (this.wasm && this.wasm.set_voices) this.wasm.set_voices(2);
    }
    this.jsFreqTgt[0] = f1;
    this.jsGainTgt[0] = g1;
    this.jsFreqTgt[1] = f2;
    this.jsGainTgt[1] = g2;
    if (this.freqTgtView) {
      this.freqTgtView[0] = f1;
      this.gainTgtView[0] = g1;
      this.freqTgtView[1] = f2;
      this.gainTgtView[1] = g2;
    }
  }

  applyLiveParams(frequency, gain) {
    const n = this.nVoices;
    const det = this.detune;
    const mid = (n - 1) * 0.5;
    const g = gain * (n > 1 ? 1 / Math.sqrt(n) : 1);
    for (let i = 0; i < n; i++) {
      const f = frequency * (1 + (i - mid) * det);
      this.jsFreqTgt[i] = f;
      this.jsGainTgt[i] = g;
      if (this.freqTgtView) {
        this.freqTgtView[i] = f;
        this.gainTgtView[i] = g;
      }
    }
  }

  record(us, n) {
    this.quanta++;
    this.lastUs = us;
    if (us > this.maxUs) this.maxUs = us;
    const budget = n * this.invSr * 1e6;
    if (us > budget * 0.5) this.overruns++;
    let bin = us | 0;
    if (bin < 0) bin = 0;
    if (bin >= BINS) bin = BINS - 1;
    this.bins[bin]++;
    this.binCount++;
  }

  percentile(p) {
    const need = this.binCount * p;
    let acc = 0;
    for (let i = 0; i < BINS; i++) {
      acc += this.bins[i];
      if (acc >= need) return i;
    }
    return this.maxUs;
  }

  postStats(n) {
    if (this.wasm) {
      this.nan = this.wasm.nan_count();
      this.inf = this.wasm.inf_count();
      this.pages = this.wasm.memory.buffer.byteLength >>> 16;
      if (this.pages !== this.initialPages) this.grew = 1;
    }
    this.port.postMessage({
      type: "stats",
      quanta: this.quanta,
      medianUs: this.percentile(0.5),
      p99Us: this.percentile(0.99),
      maxUs: this.maxUs,
      overruns: this.overruns,
      nan: this.nan,
      inf: this.inf,
      pages: this.pages || this.initialPages,
      grew: this.grew,
      engine: this.engine,
      voices: this.nVoices,
      lastUs: this.lastUs,
      alloc: 0,
      budgetUs: n * this.invSr * 1e6,
      ready: this.ready,
    });
  }

  process(_inputs, outputs, parameters) {
    try {
      const out = outputs[0] && outputs[0][0];
      if (!out) return true;
      const n = out.length > OUT_CAP ? OUT_CAP : out.length;
      const freq = parameters.frequency[0];
      const gain = parameters.gain[0];
      const freq2 = parameters.frequency2 ? parameters.frequency2[0] : freq;
      const gain2 = parameters.gain2 ? parameters.gain2[0] : 0;

      if (this.live === 2) this.applyDuetParams(freq, gain, freq2, gain2);
      else if (this.live) this.applyLiveParams(freq, gain);

      const t0 = nowMs();
      const useWasm = this.dsp(n);
      const us = (nowMs() - t0) * 1000;
      this.record(us, n);

      const src = useWasm ? this.outView : this.jsOut;
      for (let i = 0; i < n; i++) out[i] = src[i];

      this.sincePost++;
      if (this.quanta === 1 || this.sincePost >= POST_EVERY) {
        this.sincePost = 0;
        this.postStats(n);
      }
    } catch (err) {
      this.port.postMessage({
        type: "error",
        message: String(err && err.message ? err.message : err),
      });
    }
    return true;
  }
}

registerProcessor("wavetable-processor", WavetableProcessor);
