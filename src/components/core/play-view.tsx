import { useEffect, useState, type ReactNode } from "react";
import { Pause, Play, Music2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { StatCard } from "@/components/ahead/stat-card";
import { Scope } from "./scope";
import { useCore } from "@/hooks/use-core";
import { ODE_TO_JOY } from "@/lib/wavetable/tunes";

function fmtUs(n: number) {
  if (n <= 0) return "<1 µs";
  if (n < 10) return n.toFixed(1) + " µs";
  return Math.round(n) + " µs";
}

function fmtTime(n: number) {
  const s = Math.max(0, n) | 0;
  const m = (s / 60) | 0;
  const r = s % 60;
  return m + ":" + (r < 10 ? "0" : "") + r;
}

export function PlayView() {
  const { engine, snap } = useCore();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const playing = snap.playing;
  const tune = snap.tune ?? { playing: false, name: "", note: "", index: -1 };
  const overrunTone = snap.overruns > 0 ? "danger" : "ok";

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-xl bg-surface p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-base font-medium">Band-limited oscillator</h2>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted text-pretty">
              A C wavetable (mipmapped saw / square) compiled in the browser
              with wabt, then run inside an AudioWorkletProcessor. Tap Ode to
              Joy to hear a sequenced melody through the same click-free ramps.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => void engine.playTune()}
              disabled={tune.playing}
            >
              <Music2 className="size-4" />
              Ode to Joy
            </Button>
            <Button
              variant="secondary"
              onClick={() => void engine.hold(120)}
              disabled={playing}
            >
              2 min
            </Button>
            <Button
              onClick={() => {
                if (playing) engine.stop();
                else void engine.start();
              }}
            >
              {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
              {playing ? "Stop" : "Start"}
            </Button>
          </div>
        </div>

        <div className="mt-5">
          <Scope active={playing} />
        </div>
        <NoteStrip />

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge variant={snap.ready ? "ok" : "default"}>
            {snap.ready
              ? `C → WASM ${snap.compile.wasmBytes || "?"} B`
              : snap.error
                ? "WASM error"
                : snap.compile.status === "idle"
                  ? "tap Start to compile C"
                  : snap.compile.status}
          </Badge>
          <Badge variant={snap.engine === "wasm" ? "accent" : "default"}>
            {snap.engine === "wasm" ? "WASM path" : "JS path"}
          </Badge>
          <Badge variant="default">{snap.wave === "saw" ? "Saw" : "Square"}</Badge>
          {playing ? (
            <Badge variant="ok">
              {fmtTime(snap.playSeconds)}
              {snap.hold.target ? ` / ${fmtTime(snap.hold.target)}` : ""}
            </Badge>
          ) : null}
          {tune.playing ? (
            <Badge variant="accent">
              {tune.name} · {tune.note}
            </Badge>
          ) : null}
          {snap.hold.done ? (
            <Badge variant={snap.hold.nan || snap.hold.overruns ? "danger" : "ok"}>
              2 min held · NaN {snap.hold.nan} · over {snap.hold.overruns}
            </Badge>
          ) : null}
        </div>
        {snap.error ? <p className="mt-3 text-sm text-danger">{snap.error}</p> : null}
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <ControlCard title="Engine">
          <Seg
            value={snap.engine}
            onChange={(v) => engine.setEngine(v)}
            options={[
              { id: "wasm", label: "WASM" },
              { id: "js", label: "JavaScript" },
            ]}
          />
          <Seg
            value={snap.wave}
            onChange={(v) => engine.setWave(v)}
            options={[
              { id: "saw", label: "Saw" },
              { id: "square", label: "Square" },
            ]}
          />
        </ControlCard>

        <ControlCard title="Voices">
          <Seg
            value={String(snap.voices === 32 ? 32 : snap.voices === 16 ? 16 : snap.voices === 8 ? 8 : 1)}
            onChange={(v) => engine.setVoices(Number(v))}
            options={[
              { id: "1", label: "1" },
              { id: "8", label: "8" },
              { id: "16", label: "16" },
              { id: "32", label: "32" },
            ]}
          />
          <p className="text-xs leading-relaxed text-subtle">
            Extra voices detune around the root. Gain is equal-power scaled.
          </p>
        </ControlCard>
      </section>

      <section className="rounded-xl bg-surface p-4 sm:p-5">
        <div className="flex flex-col gap-5">
          <Field label="Frequency" value={`${Math.round(snap.freq)} Hz`}>
            {mounted ? (
              <Slider
                min={40}
                max={1600}
                step={1}
                value={[snap.freq]}
                onValueChange={(v) => engine.setFreq(v[0] ?? 220)}
                aria-label="Frequency"
              />
            ) : (
              <div className="h-11" />
            )}
          </Field>
          <Field label="Gain" value={snap.gain.toFixed(2)}>
            {mounted ? (
              <Slider
                min={0}
                max={0.6}
                step={0.01}
                value={[snap.gain]}
                onValueChange={(v) => engine.setGain(v[0] ?? 0)}
                aria-label="Gain"
              />
            ) : (
              <div className="h-11" />
            )}
          </Field>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Median" value={fmtUs(snap.medianUs)} hint="per 128-frame quantum" />
        <StatCard label="p99" value={fmtUs(snap.p99Us)} hint={`budget ${fmtUs(snap.budgetUs)}`} />
        <StatCard label="Overruns" value={snap.overruns} tone={overrunTone} hint="> 50% budget" />
        <StatCard
          label="NaN / Inf"
          value={`${snap.nan} / ${snap.inf}`}
          tone={snap.nan || snap.inf ? "danger" : "ok"}
        />
      </section>
    </div>
  );
}

function NoteStrip() {
  const { snap } = useCore();
  const on = snap.tune?.playing;
  return (
    <div className="mt-4 flex flex-wrap gap-1" aria-hidden={!on}>
      {ODE_TO_JOY.notes.map((note, i) => {
        const active = on && snap.tune.index === i;
        return (
          <span
            key={i}
            className={
              active
                ? "rounded-md bg-primary px-1.5 py-1 font-mono text-micro text-primary-fg"
                : "rounded-md bg-surface-2 px-1.5 py-1 font-mono text-micro text-subtle"
            }
          >
            {note.n}
          </span>
        );
      })}
    </div>
  );
}

function ControlCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-surface p-4">
      <div className="font-mono text-micro tracking-wider text-subtle uppercase">{title}</div>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-sm text-muted">{label}</span>
        <span className="font-mono text-sm tabular-nums text-fg">{value}</span>
      </div>
      {children}
    </div>
  );
}

function Seg<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <div className="flex h-11 items-center gap-1 rounded-full bg-surface-2 p-1">
      {options.map((opt) => {
        const on = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className={
              on
                ? "h-9 flex-1 rounded-full bg-primary px-2 text-sm font-medium text-primary-fg"
                : "h-9 flex-1 rounded-full px-2 text-sm font-medium text-muted hover:text-fg"
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
