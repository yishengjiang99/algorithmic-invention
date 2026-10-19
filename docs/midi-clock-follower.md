# MIDI clock follower

Demo page: [`public/midi-clock.html`](../public/midi-clock.html) (served at `/midi-clock.html`). Framework-free; all code is plain ES modules in [`public/midi-clock/`](../public/midi-clock/), so the page, the Worker, the AudioWorklet and the Node tests load exactly the same files. Experiment: [`midi-clock-experiment.md`](midi-clock-experiment.md).

```
Web MIDI port ─┐ F8 FA FB FC (+ connect / disconnect)
synthetic src ─┴─► app.js ─ Float64Array [kind, t, ...] ─► follower-worker.js
                                                           │ estimator.js  (tempo + phase)
                                                           │ transport.js  (state machine + watchdog)
                                          snapshot ◄───────┘
app.js ─ scheduler.js (look-ahead, dedupe) ─ clockmap.js (perf.now → audio time)
       └─ postMessage [1, key, audioTime] ─► click-processor.js (AudioWorklet, sample-accurate)
```

## Modules

| File | Pure? | Role |
| --- | --- | --- |
| `estimator.js` | yes | `last-interval` baseline and `filtered` (rolling median + phase correction) estimators, same interface |
| `transport.js` | yes | state machine: idle / stopped / armed / running / lost / disconnected, song position, watchdog `poll()` |
| `scheduler.js` | yes | which beats to send, when; cancel on stop / loss / disconnect; beat keys |
| `clockmap.js` | yes | performance.now ↔ AudioContext time conversion; worker ↔ main clock |
| `synthetic.js` | yes | seeded trace generator and live synthetic source |
| `replay.js` | yes | scoring used by the experiment |
| `follower-worker.js`, `click-processor.js`, `app.js` | no | Worker glue, AudioWorklet, page |

## Clock domains

Three clocks are involved and they are never mixed without a conversion.

1. **MIDI timestamps** are `MIDIMessageEvent.timeStamp`: a `DOMHighResTimeStamp` in the *main thread's* `performance.now()` domain (ms since that realm's `timeOrigin`). They are stamped when the OS delivers the message, not when JavaScript runs, so a busy main thread does not smear them. Everything the Worker and the transport see is in this domain, including the snapshot's `anchorTime`.
2. **The Worker's own `performance.now()`** has a different origin. The watchdog needs "now" in the main domain, so `init` carries the main `performance.timeOrigin` and the Worker uses `performance.now() + performance.timeOrigin − mainTimeOrigin` (`workerToMainMs`). Both origins are epoch-based, so this is exact to clock resolution.
3. **The audio clock** is `AudioContext.currentTime` in seconds. `ctx.getOutputTimestamp()` returns a simultaneous pair `{contextTime, performanceTime}` for the sample the output device is playing now; `performanceTime` is in the main `performance.now()` domain. From each pair `offset = contextTime − performanceTime/1000`, and a predicted beat at main-domain time `t` ms goes to the worklet as `audioTime = t/1000 + offset`.

`clockmap.js` keeps the last 16 offsets (sampled every 100 ms) and uses their **median**: Chrome's pair is quantised and occasionally jittery, and the two clocks drift against each other (sound-card crystal vs. system clock, tens of ppm). A 16-sample median rejects bad pairs and lags a 50 ppm drift by well under 0.2 ms (tested). Because `getOutputTimestamp` describes the sample being *heard*, no separate output-latency term is added; the cost is that a beat must be handed to the worklet at least `outputLatency` before it is audible. The scheduler therefore looks ahead 120 ms.

The worklet compares `audioTime × sampleRate` with `currentFrame` per sample, so the click starts on the exact frame it was scheduled for (tested: fired frame equals scheduled frame for every beat after the first).

**The first beat after Start is the exception.** Tick 0 is the first clock *after* the Start message. If the clock was already flowing (usual), the transport predicts that clock and the scheduler sends beat 0 as soon as Start is known, but that is after the audio render position has moved past it by roughly the output latency. The worklet fires a beat that is late by less than 150 ms immediately (reported in `lateFrames`) instead of dropping it; later beats are on time.

## Sync-loss timeout

`DEFAULT_LOST_TIMEOUT_MS = 250`, checked by a Worker interval every `WATCHDOG_MS = 25`.

- Loss is declared when no *accepted* clock has arrived for more than 250 ms while clocks are required (armed, running, or stopped without an explicit Stop). Worst-case detection latency from the last clock is 250 + 25 = 275 ms, plus one `postMessage` hop; the budget is 500 ms. Measured: 250.3 ms in headless Chromium (see the PR), < 275 ms in the deterministic tests at 30 to 300 BPM.
- 250 ms is 3 ticks at the slowest supported tempo (30 BPM, 83 ms/tick) and 12 ticks at 120 BPM, so the 1% random missing clocks and short dropouts never trip it (tested), while a cable pull is reported within a quarter of a second.
- The watchdog lives in the Worker, not on the main thread, so a busy UI thread cannot delay it.
- A device that sends Stop and then goes quiet is **not** lost: clocks are not required after an explicit Stop.
- Recovery: after `lost` or `disconnected`, a returning clock moves to `stopped`, never `running`. Song position is kept; Continue resumes it, Start restarts. The follower never guesses how many ticks it missed.

## Transport semantics

- **Start (FA)**: song tick 0 is the next clock; `runId` increments; beat numbers restart.
- **Continue (FB)**: the next clock is the tick after the last one played; same `runId`.
- **Stop (FC)**: position kept; clocks may keep flowing and keep updating tempo; queued beats are cancelled.
- **Missing clocks** advance the unwrapped tick index (a 2×period gap is one missing clock), so position stays right. **Duplicated or reordered stamps** (`dt < 0.4 × period`) are dropped and counted and do not advance position.
- **Tempo change** (120 → 90 BPM): 8 consecutive 8-tick spans more than 6% off the current period declare a step and re-derive tempo and phase from the newest clocks. Tested: detected after 9 ticks (about 250 ms at 90 BPM), position error up to 2.7 ticks during that interval, exact afterwards. Smooth ramps are followed by the rolling windows with a lag of roughly one window. Steps larger than ×1.5 per tick are indistinguishable from missing clocks.

## Teardown audit

Every long-lived resource, where it is created, where it is released, and how that is checked.

| Resource | Created | Released | Verified by |
| --- | --- | --- | --- |
| Web MIDI `midimessage` listener | `attach()` in `createMidiSource` (one per selected port, kept in a `Map` keyed by port id; `detach` runs before every `attach`) | `detach()` on port disconnect, port change and `dispose()`; the port is also `close()`d | headless: fake `MIDIAccess` counts `addEventListener`/`removeEventListener`; 5 reconnects leave exactly 1 listener, `dispose` leaves 0 |
| `MIDIAccess.onstatechange` | `init()` | set to `null` in `dispose()` | code review, headless dispose |
| Worker | `createFollower` | `dispose()`: flush, `onmessage = null`, post `close`, `terminate()`; the Worker also clears its watchdog and calls `self.close()` | headless: constructor/terminate counters (1 created, 1 terminated, reconnects create none); `audit.test.mjs` runs the real worker module with fake `self` |
| Worker watchdog interval | `init` message | `close` message; a second `init` clears the first | `audit.test.mjs` (re-init leaves 1 timer, close leaves 0, nothing posted afterwards) |
| Main-thread intervals (scheduler, clock map, synthetic source) | `createApp`, `createClickAudio`, `ensureSynth` | `disposers` and `audio.dispose()` | headless: patched `setInterval`/`clearInterval` track the live set: 0 after dispose |
| `MessagePort` of the worklet node | `AudioWorkletNode` | `port.onmessage = null`, `port.close()`, `node.disconnect()` | headless dispose |
| `AudioContext` | `enableAudio` | `ctx.close()` in `audio.dispose()` | headless: constructor/close counters, `contexts == closed` |
| `pagehide` handler | `mountUi` | page unload | n/a |

Not leaking by design: the click voice, the 64-entry beat queue and the report array are allocated once in the processor constructor.

Allocation rules for the render loop (`click-processor.js`): `process()` creates no objects, arrays, closures, strings or typed arrays; voice state is copied to locals and written back once per block; `Math.sin` is captured once at load. The only message sent from `process()` reuses a preallocated `Float64Array` and is posted when a click starts (a few per second), not per block; the structured-clone copy is made by the browser. Checked two ways in `audit.test.mjs`: a static scan of the `process()` source for allocating constructs, and a heap measurement over 200 000 blocks (about 9 minutes of audio, clicks firing) that is shown, by a mutation self-check, to catch a per-block allocation. Message handling (`onMessage`) is outside the render loop and may allocate.

## Verification

- `npm test`: estimator, transport state machine, clock map, scheduler → real processor pipeline (120 BPM for 120 s with and without jitter, stop/continue, loss, 10 reconnects, tempo change), allocation and teardown audit, experiment reproducibility.
- `scripts/midi-clock-headless.mjs`: headless Chromium against the running page (synthetic source, a faked `MIDIAccess`, and a 120 s run). Needs `playwright-core` (not a repo dependency); see the script header.

## Limits

- Verified in Chromium only. Safari has no Web MIDI. Real hardware (jitter, USB hubs, running status) was not available; the faked `MIDIAccess` exercises the listener lifecycle, not a real device.
- Headless Chromium has no real audio device; click timing is checked from the worklet's own `currentFrame`, not by recording the speaker.
- Output latency is handled by look-ahead and `getOutputTimestamp`; browsers that report a poor `getOutputTimestamp` will shift the click by that error.
- Only the selected input is followed; there is no merge of multiple clock sources.
