/**
 * Click scheduler — AudioWorkletProcessor (classic worklet script).
 *
 * The main thread converts predicted beat times to AudioContext seconds and
 * posts them here as Float64Array messages; the processor starts the click on
 * the exact sample by comparing against currentFrame.
 *
 * Messages (main -> worklet), Float64Array:
 *   [1, key, audioTimeSec]   schedule a click. key must increase (run id and
 *                            beat number: runId * 2^20 + beat); a key <= the
 *                            last accepted key is a duplicate and is dropped.
 *   [2]                      cancel everything queued (transport stopped)
 *   [3]                      reset counters and key history
 * Messages (worklet -> main), Float64Array(REPORT_LEN), sent when a click
 * starts (never per block):
 *   [key, startFrame, scheduledFrame, firedTotal, duplicatesDropped,
 *    lateDropped, queueOverflow, queueLength]
 *
 * Allocation contract: the constructor and onMessage() may allocate; process()
 * must not create arrays, objects, closures or strings. All buffers live on
 * `this`. The one postMessage per click reuses a preallocated Float64Array;
 * the structured-clone copy it triggers is made by the browser, not by this
 * code, and happens at click rate (a few per second), not block rate.
 */

const QCAP = 64;
const REPORT_LEN = 8;
const KEY_BEAT_MOD = 1048576; // 2^20
const CLICK_SECONDS = 0.03;
// A click whose time has already passed by less than this still fires (immediately);
// later than this it is dropped and counted. The downbeat of Start is the one beat
// that is inherently late: it is only known once Start arrives, and the output
// device then needs outputLatency before it can be heard.
const LATE_TOLERANCE_SECONDS = 0.15;
const TWO_PI = 6.283185307179586;
const sin = Math.sin; // one global lookup at load, not one per sample

class ClickProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.qKey = new Float64Array(QCAP);
    this.qFrame = new Float64Array(QCAP);
    this.qHead = 0;
    this.qLen = 0;
    this.lastQueuedKey = -1;
    this.lastFiredKey = -1;
    this.fired = 0;
    this.duplicates = 0;
    this.lateDropped = 0;
    this.overflow = 0;
    this.report = new Float64Array(REPORT_LEN);

    this.lateFrames = Math.round(LATE_TOLERANCE_SECONDS * sampleRate);
    this.clickFrames = Math.round(CLICK_SECONDS * sampleRate);
    this.active = 0;
    this.pos = 0;
    this.phase = 0;
    this.phaseInc = 0;
    this.amp = 0;
    this.decay = Math.exp(-6.9 / this.clickFrames); // -60 dB over the click
    this.incAccent = (TWO_PI * 1500) / sampleRate;
    this.incBeat = (TWO_PI * 1000) / sampleRate;

    this.port.onmessage = (ev) => this.onMessage(ev.data);
  }

  onMessage(d) {
    if (!d || d.length === 0) return;
    const cmd = d[0];
    if (cmd === 1) {
      const key = d[1];
      if (!(key > this.lastQueuedKey)) {
        this.duplicates++;
        return;
      }
      if (this.qLen >= QCAP) {
        this.overflow++;
        return;
      }
      const slot = (this.qHead + this.qLen) % QCAP;
      this.qKey[slot] = key;
      this.qFrame[slot] = Math.round(d[2] * sampleRate);
      this.qLen++;
      this.lastQueuedKey = key;
    } else if (cmd === 2) {
      this.qLen = 0;
      this.lastQueuedKey = this.lastFiredKey;
    } else if (cmd === 3) {
      this.qLen = 0;
      this.lastQueuedKey = -1;
      this.lastFiredKey = -1;
      this.fired = this.duplicates = this.lateDropped = this.overflow = 0;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const out = output[0];
    const n = out.length;
    const base = currentFrame;
    // Voice state lives in locals for the block and is written back once.
    let active = this.active;
    let pos = this.pos;
    let phase = this.phase;
    let amp = this.amp;
    let inc = this.phaseInc;
    const decay = this.decay;
    const clickFrames = this.clickFrames;

    for (let i = 0; i < n; i++) {
      const frame = base + i;
      while (this.qLen > 0 && this.qFrame[this.qHead] <= frame) {
        const head = this.qHead;
        const scheduled = this.qFrame[head];
        const key = this.qKey[head];
        this.qHead = (head + 1) % QCAP;
        this.qLen--;
        if (frame - scheduled > this.lateFrames) {
          this.lateDropped++;
          continue;
        }
        this.lastFiredKey = key;
        this.fired++;
        active = 1;
        pos = 0;
        phase = 0;
        amp = 0.8;
        inc = (key % KEY_BEAT_MOD) % 4 === 0 ? this.incAccent : this.incBeat;
        const r = this.report;
        r[0] = key;
        r[1] = frame;
        r[2] = scheduled;
        r[3] = this.fired;
        r[4] = this.duplicates;
        r[5] = this.lateDropped;
        r[6] = this.overflow;
        r[7] = this.qLen;
        this.port.postMessage(r);
      }
      let s = 0;
      if (active === 1) {
        s = sin(phase) * amp;
        phase += inc;
        amp *= decay;
        pos++;
        if (pos >= clickFrames) active = 0;
      }
      out[i] = s;
    }
    this.active = active;
    this.pos = pos;
    this.phase = phase;
    this.amp = amp;
    this.phaseInc = inc;
    for (let c = 1; c < output.length; c++) {
      const ch = output[c];
      for (let i = 0; i < n; i++) ch[i] = out[i];
    }
    return true;
  }
}

registerProcessor("click-processor", ClickProcessor);
