import { useEffect, useMemo, useState } from "react";
import { Pause, Play, RefreshCw, AudioLines } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PianoRoll } from "./piano-roll";
import { Spinner } from "./spinner";
import { generateInvention, type Invention } from "@/lib/invention/generate";
import { useCore } from "@/hooks/use-core";

export function InventionApp({ onLab }: { onLab: () => void }) {
  const { engine, snap } = useCore();
  const [score, setScore] = useState<Invention | null>(null);
  const [generating, setGenerating] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    setScore(generateInvention());
    window.__core = engine.api();
  }, [engine]);

  const playing = snap.invention?.playing ?? false;
  const playhead = playing ? snap.invention.beat : 0;
  const compiling = !snap.ready && snap.compile.status !== "idle" && !snap.error;
  const loading = compiling || starting;

  const status = useMemo(() => {
    if (snap.error) return snap.error;
    if (generating) return "Writing a new subject…";
    if (loading && !snap.ready) {
      return snap.compile.status === "idle" ? "Loading wavetable…" : snap.compile.status;
    }
    if (snap.ready) return `Core wavetable · ${snap.compile.wasmBytes} B WASM`;
    return "Tap Play — C compiles in the browser, then the worklet sings.";
  }, [snap, generating, loading]);

  const generate = async () => {
    if (generating) return;
    setGenerating(true);
    if (playing) engine.stop();
    const started = Date.now();
    setScore(generateInvention());
    try {
      await engine.unlock();
    } finally {
      const wait = 420 - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      setGenerating(false);
    }
  };

  const toggle = async () => {
    if (playing || starting) {
      engine.stop();
      setStarting(false);
      return;
    }
    if (!score) return;
    setStarting(true);
    try {
      await engine.playInvention(score);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="min-h-dvh bg-ink px-4 py-8 text-parchment sm:px-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center">
        <h1 className="font-serif text-3xl font-semibold tracking-tight text-gold sm:text-4xl">
          Algorithmic Invention in D Minor
        </h1>
        <div className="mt-3 h-0.5 w-full max-w-md bg-gold" />
        <p className="mt-4 max-w-lg text-center font-serif text-base leading-relaxed text-parchment-muted">
          A two-part invention grown from one motif — subject, answer at the
          fifth, sequential episode, cadence. Played by the Core band-limited
          wavetable, not a stock synth.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3 rounded-lg bg-panel p-4 shadow-[0_4px_6px_rgba(0,0,0,0.5)]">
          <Button variant="gold" onClick={() => void generate()} disabled={generating || loading}>
            {generating ? <Spinner label="Generating motif" /> : <RefreshCw className="size-4" />}
            {generating ? "Generating…" : "Generate New Motif"}
          </Button>
          <Button
            variant="gold"
            onClick={() => void toggle()}
            disabled={!score || generating || (loading && !playing)}
          >
            {loading && !playing ? (
              <Spinner label="Loading engine" />
            ) : playing ? (
              <Pause className="size-4" />
            ) : (
              <Play className="size-4" />
            )}
            {loading && !playing ? "Loading…" : playing ? "Stop" : "Play"}
          </Button>
          <Button variant="ghost" className="font-serif text-parchment" onClick={onLab}>
            <AudioLines className="size-4" />
            Audio lab
          </Button>
        </div>

        <div className="relative mt-6 w-full">
          <PianoRoll score={score} playhead={playhead} />
          {loading && !playing ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded bg-ink/70">
              <Spinner className="size-8 border-gold" label="Compiling wavetable" />
              <p className="font-serif text-sm text-gold">
                {snap.compile.status !== "idle" ? snap.compile.status : "Assembling wavetable…"}
              </p>
            </div>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-5 font-serif text-sm">
          <span className="flex items-center gap-2">
            <span className="size-3.5 rounded-sm bg-dux" />
            Dux (Voice 1 — Soprano)
          </span>
          <span className="flex items-center gap-2">
            <span className="size-3.5 rounded-sm bg-comes" />
            Comes (Voice 2 — Bass)
          </span>
        </div>

        <p className="mt-5 inline-flex items-center gap-2 text-center font-mono text-xs text-parchment-dim">
          {generating || (loading && !playing) ? <Spinner className="size-3 border-parchment-dim" /> : null}
          {status}
        </p>
      </div>
    </div>
  );
}
