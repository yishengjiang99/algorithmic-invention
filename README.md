# Algorithmic Invention

A two-part invention in D minor, grown from one motif and played by a **band-limited wavetable written in C**, compiled to WASM in the browser, and rendered on the audio thread.

[https://github.com/yishengjiang99/algorithmic-invention](https://github.com/yishengjiang99/algorithmic-invention)

## What it does

Tap **Generate New Motif** and **Play**. The score is a small counterpoint recipe — subject, answer at the fifth, sequential episode, cadence — not a stock synth preset and not an LLM.

On first Play the page fetches `wavetable.c` and [wabt](https://github.com/WebAssembly/wabt), compiles C → WAT → WASM, then hands the module to an `AudioWorkletProcessor`. Later plays just re-schedule notes.

**Audio lab** (Core) is the instrument and the proof it is honest:

| Tab | What it shows |
| --- | --- |
| Play | WASM vs JS path, saw / square, 1–32 voices, scope, *Ode to Joy* |
| Bench | Same oscillator loop in two languages at 1 / 8 / 16 / 32 voices |
| Discipline | 32 voices, one 64 KiB WASM page, zero alloc in `process()` |
| C | The live `wavetable.c` that wabt assembled |

`src/lib/scheduler` and `src/components/ahead` are an earlier look-ahead note scheduler (main thread timestamps, worklet starts on a sample boundary). It is in the tree; the home route is the invention + Core.

## Architecture

```
score (JS)  →  AudioParam automation  →  worklet process()  →  C / WASM wavetable  →  speakers
```

- [`src/lib/invention/generate.ts`](src/lib/invention/generate.ts) — D harmonic minor, scale-degree invert / transpose
- [`src/lib/wavetable/engine.ts`](src/lib/wavetable/engine.ts) — `AudioContext` singleton, compile, schedule, bench
- [`public/wavetable.c`](public/wavetable.c) — freestanding C, no malloc, no libm, no WASI
- [`public/worklets/wavetable-processor.js`](public/worklets/wavetable-processor.js) — WASM + JS twins of the same loop
- [`wasm/wavetable/src/lib.rs`](wasm/wavetable/src/lib.rs) — `no_std` Rust twin (not the live path)

WASM memory is one page (`initial = max = 1`). `process()` does not allocate.

## Run

```bash
npm install
npm run dev
```

Open the printed local URL. First Play needs a user gesture (browser autoplay policy) and a network fetch of wabt from jsDelivr.

```bash
npm run build
npm run typecheck
```

Optional: rebuild the precompiled module (the live path compiles C in-page either way):

```bash
# C → wasm32 with a WASI clang
./wasm/wavetable/build.sh

# or the Rust twin
./scripts/build-wasm.sh
```

## Stack

React 19, TanStack Start / Router, Tailwind v4, AudioWorklet. No accounts, no database.

## License

MIT
