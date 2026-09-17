/**
 * Look-ahead note scheduler — AudioWorkletProcessor
 *
 * Timing model
 * ------------
 * process() runs on the audio thread once per render quantum (typically 128
 * samples, ~2.67 ms at 48 kHz). currentTime is the audio clock at sample 0 of
 * this quantum. Notes arrive from the main thread as a packed Float64Array
 * and sit in a preallocated ring buffer until their time falls inside the
 * current quantum, then a voice starts at
 *
 *     startSample = round((t - currentTime) * sampleRate)
 *
 * so on-time notes are sample-accurate. Look-ahead on the main thread is what
 * keeps this queue from going dry when the main thread stalls.
 *
 * Allocation contract
 * -------------------
 * Constructor and onmessage may allocate. process() must not create arrays,
 * objects, closures, or strings. All buffers live on `this`. Stats are a
 * single Float64Array posted every 8 quanta (structured clone is the
 * browser's copy, not ours).
 *
 * Message protocol
 * ----------------
 * Main → worklet:
 *   Float64Array  [count, t, freq, vel, id, ...]   enqueue notes
 *   number 1      reset
 *   number 2      flush stats now
 * Worklet → main:
 *   Float64Array  STATS (see indices below)
 */

const QUEUE_CAP = 2048;
const QUEUE_MASK = QUEUE_CAP - 1;
const MAX_VOICES = 24;
const STATS_LEN = 20;

const S_PLAYED = 0;
const S_LATE = 1;
const S_MISSED = 2;
const S_QUEUE = 3;
const S_QUEUE_MAX = 4;
const S_UNDERRUNS = 5;
const S_VOICES = 6;
const S_ERR_SUM = 7;
const S_ERR_MAX = 8;
const S_WITHIN_5 = 9;
const S_RECEIVED = 10;
const S_DROPPED = 11;
const S_SKIPS = 12;
const S_DUPES = 13;
const S_LAST_ID = 14;
const S_QUANTUM = 15;
const S_AUDIO_TIME = 16;
const S_ALLOC = 17;
const S_STARTED_Q = 18;
const S_LAST_FREQ = 19;

const TWO_PI = Math.PI * 2;
const FIVE_MS = 0.005;
const MISS_SEC = 0.01;
const DROP_SEC = 0.03;

class LookaheadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.qTime = new Float64Array(QUEUE_CAP);
    this.qFreq = new Float32Array(QUEUE_CAP);
    this.qVel = new Float32Array(QUEUE_CAP);
    this.qId = new Uint32Array(QUEUE_CAP);
    this.qHead = 0;
    this.qTail = 0;
    this.qCount = 0;

    this.vPhase = new Float64Array(MAX_VOICES);
    this.vInc = new Float64Array(MAX_VOICES);
    this.vAmp = new Float32Array(MAX_VOICES);
    this.vGain = new Float32Array(MAX_VOICES);
    this.vWait = new Int32Array(MAX_VOICES);
    this.vAttackLeft = new Int32Array(MAX_VOICES);
    this.vState = new Uint8Array(MAX_VOICES);
    this.vActive = new Uint8Array(MAX_VOICES);

    this.stats = new Float64Array(STATS_LEN);
    this.blockCount = 0;
    this.lastFrame = -1;
    this.lastId = 0;

    const sr = sampleRate;
    this.attackSamples = sr * 0.001 < 8 ? 8 : (sr * 0.001) | 0;
    this.invAttack = 1 / this.attackSamples;
    this.decayCoeff = Math.exp(Math.log(0.001) / (sr * 0.09));
    this.incScale = TWO_PI / sr;

    const proc = this;
    this.port.onmessage = function (event) {
      proc.onControl(event.data);
    };
  }

  onControl(data) {
    if (typeof data === "number") {
      if (data === 1) this.resetAll();
      else if (data === 2) this.port.postMessage(this.stats);
      return;
    }
    if (data instanceof Float64Array) {
      const count = data[0] | 0;
      let o = 1;
      for (let i = 0; i < count; i++) {
        this.enqueue(data[o], data[o + 1], data[o + 2], data[o + 3] | 0);
        o += 4;
      }
    }
  }

  resetAll() {
    this.qHead = 0;
    this.qTail = 0;
    this.qCount = 0;
    this.lastFrame = -1;
    this.lastId = 0;
    this.blockCount = 0;
    for (let v = 0; v < MAX_VOICES; v++) {
      this.vActive[v] = 0;
      this.vGain[v] = 0;
      this.vWait[v] = 0;
    }
    for (let i = 0; i < STATS_LEN; i++) this.stats[i] = 0;
  }

  enqueue(t, freq, vel, id) {
    if (this.qCount >= QUEUE_CAP) {
      this.stats[S_DROPPED] += 1;
      return;
    }
    const i = this.qTail;
    this.qTime[i] = t;
    this.qFreq[i] = freq;
    this.qVel[i] = vel;
    this.qId[i] = id >>> 0;
    this.qTail = (this.qTail + 1) & QUEUE_MASK;
    this.qCount += 1;
    this.stats[S_RECEIVED] += 1;
  }

  startVoice(freq, vel, startSample) {
    let slot = -1;
    let quietest = 99;
    let quietIdx = 0;
    for (let v = 0; v < MAX_VOICES; v++) {
      if (this.vActive[v] === 0) {
        slot = v;
        break;
      }
      if (this.vGain[v] < quietest) {
        quietest = this.vGain[v];
        quietIdx = v;
      }
    }
    if (slot < 0) slot = quietIdx;
    this.vActive[slot] = 1;
    this.vPhase[slot] = 0;
    this.vInc[slot] = freq * this.incScale;
    this.vAmp[slot] = vel * 0.2;
    this.vGain[slot] = 0;
    this.vWait[slot] = startSample;
    this.vAttackLeft[slot] = this.attackSamples;
    this.vState[slot] = 1;
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];
    const n = output.length;
    const sr = sampleRate;
    const now = currentTime;
    const invSr = 1 / sr;
    const quantumEnd = now + n * invSr;
    const stats = this.stats;

    if (this.lastFrame >= 0 && currentFrame > this.lastFrame + n) {
      stats[S_UNDERRUNS] += 1;
    }
    this.lastFrame = currentFrame;

    stats[S_STARTED_Q] = 0;

    while (this.qCount > 0) {
      const idx = this.qHead;
      const t = this.qTime[idx];
      if (t >= quantumEnd) break;

      const freq = this.qFreq[idx];
      const vel = this.qVel[idx];
      const id = this.qId[idx];
      this.qHead = (this.qHead + 1) & QUEUE_MASK;
      this.qCount -= 1;

      if (this.lastId !== 0) {
        if (id <= this.lastId) stats[S_DUPES] += 1;
        else if (id > this.lastId + 1) stats[S_SKIPS] += id - this.lastId - 1;
      }
      this.lastId = id;
      stats[S_LAST_ID] = id;

      if (freq < 1) continue;

      const lateness = now - t;
      if (lateness > DROP_SEC) {
        stats[S_MISSED] += 1;
        continue;
      }
      if (lateness > MISS_SEC) {
        stats[S_MISSED] += 1;
        continue;
      }

      let startSample = Math.round((t - now) * sr);
      if (startSample < 0) {
        startSample = 0;
        stats[S_LATE] += 1;
      } else if (startSample >= n) {
        startSample = n - 1;
      }

      const actualTime = now + startSample * invSr;
      let err = actualTime - t;
      if (err < 0) err = -err;
      stats[S_ERR_SUM] += err;
      if (err > stats[S_ERR_MAX]) stats[S_ERR_MAX] = err;
      if (err < FIVE_MS) stats[S_WITHIN_5] += 1;
      stats[S_PLAYED] += 1;
      stats[S_STARTED_Q] += 1;
      stats[S_LAST_FREQ] = freq;

      this.startVoice(freq, vel, startSample);
    }

    const decay = this.decayCoeff;
    const invAttack = this.invAttack;
    let voices = 0;

    for (let i = 0; i < n; i++) {
      let mix = 0;
      for (let v = 0; v < MAX_VOICES; v++) {
        if (this.vActive[v] === 0) continue;
        if (this.vWait[v] > 0) {
          this.vWait[v] -= 1;
          continue;
        }
        let g = this.vGain[v];
        if (this.vState[v] === 1) {
          g += this.vAmp[v] * invAttack;
          if (g > this.vAmp[v]) g = this.vAmp[v];
          this.vAttackLeft[v] -= 1;
          if (this.vAttackLeft[v] <= 0) this.vState[v] = 2;
        } else {
          g *= decay;
          if (g < 0.00008) {
            this.vActive[v] = 0;
            this.vGain[v] = 0;
            continue;
          }
        }
        this.vGain[v] = g;
        const ph = this.vPhase[v];
        mix += Math.sin(ph) * g + Math.sin(ph + ph) * (g * 0.15);
        this.vPhase[v] = (ph + this.vInc[v]) % TWO_PI;
        voices += 1;
      }
      if (mix > 1) mix = 1;
      else if (mix < -1) mix = -1;
      output[i] = mix;
    }

    if (this.qCount > stats[S_QUEUE_MAX]) stats[S_QUEUE_MAX] = this.qCount;
    stats[S_QUEUE] = this.qCount;
    stats[S_VOICES] = (voices / n) | 0;
    stats[S_QUANTUM] = n;
    stats[S_AUDIO_TIME] = now;
    stats[S_ALLOC] = 0;

    this.blockCount += 1;
    if ((this.blockCount & 7) === 0) {
      this.port.postMessage(this.stats);
    }

    return true;
  }
}

registerProcessor("lookahead-processor", LookaheadProcessor);
