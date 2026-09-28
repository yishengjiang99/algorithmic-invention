# SharedArrayBuffer analysis ring

Used by `public/worklets/wavetable-processor.js` as a tap on the existing
wavetable output. The audio thread never waits on the worker.

## Layout

```
SharedArrayBuffer
 ├─ Int32 header[16]           64 bytes
 └─ Float32 samples[32768]     128 KiB, capacity is a power of two
```

| Index | Name | Who writes |
| --- | --- | --- |
| 0 | write (total samples) | worklet |
| 1 | read (total samples) | worker only |
| 2 | capacity | main, once |
| 3 | overrunSamples | worklet |
| 4 | overrunEvents | worklet |
| 5 | writtenBlocks | worklet |
| 6 | droppedBlocks | worklet |
| 7 | writeTime (now * 100) | worklet |
| 8 | processUs | worklet |
| 9 | deadlineMiss | worklet |
| 10 | analyzedBlocks | worker |
| 11 | displayPosts | worker |
| 12 | seq | worklet |
| 13 | flags | worklet |
| 14 | lastBlockFrames | worklet |
| 15 | analyzedSamples | worker |

## Overflow

Strict SPSC: only the consumer stores `read`. If `used + n > capacity`,
the writer refuses the block, increments overrun counters, and returns
0. Audio output is unchanged — this ring is a tap, not the playback
buffer.

## Memory ordering

1. Worklet stores samples into the float region.
2. `Atomics.add(write, n)` publishes them (seq_cst).
3. Worker `Atomics.load(write)`, copies, then
   `compareExchange(read, expected, expected + n)`.
4. A failed CAS means that window is dropped instead of moving `read`
   backwards. The producer never stores `read`.

## Capacity

32 768 mono samples ≈ 682 ms at 48 kHz. That covers a 25 ms main-thread
stall plus UI work (resize, CSS animation) with margin. Quantum size is
typically 128 frames (~2.67 ms).

## Transferable path

The same worklet can copy a quantum into a preallocated `Float32Array`
pool and `postMessage(..., [buffer])`. The worker analyzes and returns
the buffer. No SharedArrayBuffer, so this path works without
cross-origin isolation. Pool exhaustion increments `droppedBlocks`.

## Isolation

SharedArrayBuffer requires `crossOriginIsolated`. `npm run dev` sends
`COOP: same-origin` and `COEP: credentialless`. GitHub Pages cannot set
those headers; the Ring tab shows an unsupported-state message and
falls back to transferable blocks.
