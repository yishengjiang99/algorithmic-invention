#!/usr/bin/env node
/**
 * Headless-Chromium verification of public/midi-clock.html.
 *
 * Not part of `npm test` (needs a browser). Requires playwright-core, which is
 * deliberately not a dependency of this repo:
 *
 *   npm i --no-save playwright-core
 *   npm run dev                       # in another shell (or point URL at a preview)
 *   CHROME_PATH=/path/to/chrome node scripts/midi-clock-headless.mjs [--quick]
 *
 * Scenarios (each prints PASS/FAIL, exit code 1 on any FAIL):
 *   transport  start / stop / continue / silence (sync loss) / unplug+replug / dispose
 *   webmidi    a faked Web MIDI access: attach once, reconnect x5, no duplicate listeners
 *   long       120 BPM synthetic source for 120 s: no duplicate or skipped beats
 */
import process from "node:process";

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error("playwright-core is not installed: npm i --no-save playwright-core");
  process.exit(2);
}

const URL_ = process.env.URL || "http://127.0.0.1:5173/midi-clock.html";
const QUICK = process.argv.includes("--quick");
const LONG_MS = QUICK ? 15000 : 120000;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
});

/** Count outstanding workers, intervals, contexts and listeners from page start. */
const TRACKER = () => {
  const t = (window.__track = {
    workers: 0,
    terminated: 0,
    intervals: new Set(),
    contexts: 0,
    closed: 0,
    errors: [],
  });
  const W = window.Worker;
  window.Worker = class extends W {
    constructor(...a) {
      super(...a);
      t.workers++;
      const term = this.terminate.bind(this);
      this.terminate = () => {
        t.terminated++;
        term();
      };
    }
  };
  const si = window.setInterval;
  const ci = window.clearInterval;
  window.setInterval = (...a) => {
    const id = si(...a);
    t.intervals.add(id);
    return id;
  };
  window.clearInterval = (id) => {
    t.intervals.delete(id);
    return ci(id);
  };
  const AC = window.AudioContext;
  window.AudioContext = class extends AC {
    constructor(...a) {
      super(...a);
      t.contexts++;
      const c = this.close.bind(this);
      this.close = () => {
        t.closed++;
        return c();
      };
    }
  };
  window.addEventListener("error", (e) => t.errors.push(String(e.message)));
};

async function open(init) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => {
    failed++;
    console.log("FAIL  pageerror", e.message);
  });
  await page.addInitScript(TRACKER);
  if (init) await page.addInitScript(init);
  await page.goto(URL_);
  await page.waitForFunction(() => window.__midiClock);
  return page;
}

const wait = (page, ms) => page.waitForTimeout(ms);
const ev = (page, fn, arg) => page.evaluate(fn, arg);
const clicks = (page) => ev(page, () => window.__midiClock.log.clicks.map((c) => ({ ...c })));

function beatReport(list) {
  const keys = new Set(list.map((c) => c.key));
  let gaps = 0;
  let maxDev = 0;
  for (let i = 1; i < list.length; i++) {
    if (list[i].runId === list[i - 1].runId) {
      if (list[i].beat !== list[i - 1].beat + 1) gaps++;
      // a late-fired click (the Start downbeat) has no meaningful spacing to its successor
      if (list[i - 1].lateFrames === 0 && list[i].beat === list[i - 1].beat + 1)
        maxDev = Math.max(maxDev, Math.abs(list[i].audioTime - list[i - 1].audioTime - 0.5));
    }
  }
  return { dup: list.length - keys.size, gaps, maxDevMs: maxDev * 1000 };
}

/* ---------------- transport ---------------- */
{
  console.log("# transport (synthetic source)");
  const page = await open();
  await page.click("#btn-audio");
  await wait(page, 1800);
  let s = await ev(page, () => ({ ...window.__midiClock.snap }));
  check(
    "clocks flowing, stopped, BPM ~120",
    s.state === "stopped" && Math.abs(s.bpm - 120) < 0.5,
    `state=${s.state} bpm=${s.bpm.toFixed(3)}`,
  );

  await page.click("#btn-start");
  await wait(page, 3300);
  s = await ev(page, () => ({ ...window.__midiClock.snap }));
  let c = await clicks(page);
  check("start -> running", s.state === "running");
  check("beat 0 clicks on start", c.length > 0 && c[0].beat === 0, `first beat=${c[0]?.beat}`);
  check("~6-7 clicks in 3.3 s", c.length >= 6 && c.length <= 8, `n=${c.length}`);

  const stopAudio = await ev(page, () => {
    window.__midiClock.synth.send("stop");
    return window.__midiClock.audio.ctx.currentTime;
  });
  const nAtStop = (await clicks(page)).length;
  await wait(page, 1500);
  c = await clicks(page);
  s = await ev(page, () => ({ ...window.__midiClock.snap }));
  const late = c.filter((x) => x.audioTime > stopAudio + 0.05).length;
  check(
    "stop -> stopped, no click after stop",
    s.state === "stopped" && late === 0,
    `after-stop clicks=${late}, total ${nAtStop}->${c.length}`,
  );

  const keysBefore = new Set(c.map((x) => x.key));
  const lastBeat = c[c.length - 1].beat;
  await page.click("#btn-continue");
  await wait(page, 2300);
  c = await clicks(page);
  s = await ev(page, () => ({ ...window.__midiClock.snap }));
  const fresh = c.filter((x) => !keysBefore.has(x.key));
  const rep = beatReport(c);
  check(
    "continue -> running, same run id, beats resume",
    s.state === "running" &&
      s.runId === 1 &&
      fresh.length >= 3 &&
      fresh[0].beat > lastBeat - 1 &&
      rep.dup === 0,
    `lastBeat=${lastBeat} fresh=${fresh.map((x) => x.beat)}`,
  );
  check(
    "no duplicate clicks across stop/continue",
    rep.dup === 0 &&
      (await ev(page, () => window.__midiClock.stats.workletReports.duplicatesDropped)) === 0,
    JSON.stringify(rep),
  );

  // sync loss
  await ev(page, () => window.__midiClock.synth.silence());
  await wait(page, 700);
  s = await ev(page, () => ({ ...window.__midiClock.snap }));
  const lossMs = s.lostSeenAt - s.lastClockT;
  check(
    "silence -> lost, reported < 500 ms after last clock",
    s.state === "lost" && lossMs < 500,
    `latency=${lossMs.toFixed(1)} ms`,
  );
  const lostN = (await clicks(page)).length;
  await wait(page, 800);
  check("no clicks while lost", (await clicks(page)).length === lostN);

  await ev(page, () => window.__midiClock.synth.resume());
  await wait(page, 400);
  s = await ev(page, () => ({ ...window.__midiClock.snap }));
  check(
    "clocks return -> stopped (needs explicit Continue)",
    s.state === "stopped",
    `state=${s.state}`,
  );

  // unplug / replug x3
  for (let i = 0; i < 3; i++) {
    await ev(page, () => window.__midiClock.synth.disconnect());
    await wait(page, 150);
    s = await ev(page, () => ({ ...window.__midiClock.snap }));
    if (i === 0) check("unplug -> disconnected immediately", s.state === "disconnected");
    await ev(page, () => window.__midiClock.synth.connect());
    await wait(page, 1500);
  }
  await page.click("#btn-start");
  await wait(page, 2300);
  c = await clicks(page);
  const rep2 = beatReport(c);
  check(
    "after 3 replugs: running, no duplicate clicks",
    (await ev(page, () => window.__midiClock.snap.state)) === "running" && rep2.dup === 0,
    JSON.stringify(rep2),
  );
  const track1 = await ev(page, () => ({
    workers: window.__track.workers,
    intervals: window.__track.intervals.size,
  }));
  check("replug did not create extra Workers", track1.workers === 1, `workers=${track1.workers}`);

  await page.click("#btn-dispose");
  await wait(page, 500);
  const t = await ev(page, () => ({
    workers: window.__track.workers,
    terminated: window.__track.terminated,
    intervals: window.__track.intervals.size,
    contexts: window.__track.contexts,
    closed: window.__track.closed,
    ctxState: window.__midiClock.audio === null ? "null" : "open",
    seq: window.__midiClock.snap.seq,
  }));
  await wait(page, 300);
  const seq2 = await ev(page, () => window.__midiClock.snap.seq);
  check(
    "dispose: worker terminated, audio context closed",
    t.workers === t.terminated && t.contexts === t.closed && t.ctxState === "null",
    JSON.stringify(t),
  );
  check(
    "dispose: no page-level intervals left running",
    t.intervals === 0,
    `intervals=${t.intervals}`,
  );
  check("dispose: worker silent after teardown", seq2 === t.seq, `seq ${t.seq}->${seq2}`);
  await page.close();
}

/* ---------------- fake Web MIDI ---------------- */
{
  console.log("# webmidi (faked MIDIAccess)");
  const FAKE = () => {
    class Port extends EventTarget {
      constructor(id, name) {
        super();
        this.id = id;
        this.name = name;
        this.state = "connected";
        this.type = "input";
        this._listeners = 0;
        this.opens = 0;
        this.closes = 0;
      }
      addEventListener(t, ...a) {
        if (t === "midimessage") this._listeners++;
        return super.addEventListener(t, ...a);
      }
      removeEventListener(t, ...a) {
        if (t === "midimessage") this._listeners--;
        return super.removeEventListener(t, ...a);
      }
      async open() {
        this.opens++;
        return this;
      }
      async close() {
        this.closes++;
        return this;
      }
    }
    const port = new Port("fake-1", "Fake Clock Device");
    const access = {
      inputs: new Map([[port.id, port]]),
      outputs: new Map(),
      onstatechange: null,
    };
    window.__fake = {
      port,
      send(status, t = performance.now()) {
        const e = new Event("midimessage");
        e.data = Uint8Array.of(status);
        Object.defineProperty(e, "timeStamp", { value: t });
        port.dispatchEvent(e);
      },
      setState(st) {
        port.state = st;
        if (access.onstatechange) access.onstatechange({ port });
      },
      timer: null,
      next: 0,
      run(bpm) {
        window.__fake.next = performance.now();
        const per = 60000 / (bpm * 24);
        window.__fake.timer = setInterval(() => {
          const now = performance.now();
          while (window.__fake.next <= now) {
            window.__fake.send(0xf8, window.__fake.next);
            window.__fake.next += per;
          }
        }, 5);
      },
      halt() {
        clearInterval(window.__fake.timer);
        window.__fake.timer = null;
      },
    };
    navigator.requestMIDIAccess = async () => access;
  };
  const page = await open(FAKE);
  await page.click("#btn-audio");
  await page.click("#btn-source-midi");
  await wait(page, 300);
  let n = await ev(page, () => window.__fake.port._listeners);
  check("web midi: exactly one listener attached", n === 1, `listeners=${n}`);
  await ev(page, () => window.__fake.run(120));
  await wait(page, 1800);
  await ev(page, () => window.__fake.send(0xfa));
  await wait(page, 2300);
  let s = await ev(page, () => ({ ...window.__midiClock.snap }));
  check(
    "web midi: clocks + start -> running @120",
    s.state === "running" && Math.abs(s.bpm - 120) < 0.5,
    `bpm=${s.bpm.toFixed(3)}`,
  );
  await ev(page, () => window.__fake.send(0x90)); // note-on is ignored
  for (let i = 0; i < 5; i++) {
    await ev(page, () => {
      window.__fake.halt();
      window.__fake.setState("disconnected");
    });
    await wait(page, 120);
    s = await ev(page, () => ({ ...window.__midiClock.snap }));
    if (i === 0)
      check("web midi: disconnect reported", s.state === "disconnected", `state=${s.state}`);
    await ev(page, () => {
      window.__fake.setState("connected");
      window.__fake.run(120);
    });
    await wait(page, 800);
    await ev(page, () => window.__fake.send(0xfa));
    await wait(page, 700);
  }
  n = await ev(page, () => window.__fake.port._listeners);
  check("web midi: 5 reconnects -> still one listener", n === 1, `listeners=${n}`);
  await wait(page, 1500);
  const c = await clicks(page);
  const rep = beatReport(c);
  s = await ev(page, () => ({ ...window.__midiClock.snap }));
  check(
    "web midi: running after reconnects, no duplicate clicks",
    s.state === "running" && rep.dup === 0,
    JSON.stringify(rep),
  );
  await ev(page, () => window.__fake.halt());
  await page.click("#btn-dispose");
  await wait(page, 300);
  n = await ev(page, () => window.__fake.port._listeners);
  check(
    "web midi: dispose removes listener and closes port",
    n === 0 && (await ev(page, () => window.__fake.port.closes)) >= 1,
    `listeners=${n}`,
  );
  await page.close();
}

/* ---------------- long run ---------------- */
{
  console.log(`# long run (${LONG_MS / 1000} s, 120 BPM synthetic)`);
  const page = await open();
  await page.click("#btn-audio");
  await wait(page, 1800);
  await page.click("#btn-start");
  const t0 = Date.now();
  while (Date.now() - t0 < LONG_MS) await wait(page, Math.min(5000, LONG_MS - (Date.now() - t0)));
  const c = await clicks(page);
  const rep = beatReport(c);
  const s = await ev(page, () => ({
    ...window.__midiClock.snap,
    rep: window.__midiClock.stats.workletReports,
  }));
  const expected = Math.floor(LONG_MS / 500);
  check(
    "long: running at end, BPM 120",
    s.state === "running" && Math.abs(s.bpm - 120) < 0.05,
    `bpm=${s.bpm.toFixed(4)}`,
  );
  check(
    "long: no duplicate beats",
    rep.dup === 0 && s.rep.duplicatesDropped === 0,
    JSON.stringify(rep),
  );
  check("long: no skipped beats", rep.gaps === 0, `beats=${c.length} expected~${expected}`);
  check(
    "long: click count within 2 of expected",
    Math.abs(c.length - expected) <= 3,
    `n=${c.length} expected~${expected}`,
  );
  check("long: no late drops", s.rep.lateDropped <= 1, JSON.stringify(s.rep));
  check(
    "long: click spacing 500 ms +- 1 ms",
    rep.maxDevMs <= 1,
    `max deviation ${rep.maxDevMs.toFixed(3)} ms`,
  );
  await page.close();
}

await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
