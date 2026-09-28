import { useEffect, useState } from "react";
import { Activity, Mic, Radio } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/ahead/stat-card";
import { useCore } from "@/hooks/use-core";
import type { AnalysisPath } from "@/lib/wavetable/engine";

function dbfs(x: number) {
  if (x <= 1e-9) return -120;
  return 20 * Math.log10(x);
}

function Meter({ label, value }: { label: string; value: number }) {
  const db = dbfs(value);
  const pct = Math.max(0, Math.min(1, (db + 60) / 60));
  return (
    <div>
      <div className="mb-1 flex justify-between font-mono text-micro text-subtle uppercase">
        <span>{label}</span>
        <span className="tabular-nums text-fg">{db.toFixed(1)} dBFS</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-bg">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  );
}

export function RingView() {
  const { engine, snap } = useCore();
  const a = snap.analysis;
  const exp = a.experiment;
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const el = document.getElementById("ring-pressure");
    if (!el) return;
    const on = () => el.classList.toggle("scale-105");
    const id = window.setInterval(on, 900);
    return () => clearInterval(id);
  }, []);

  const startPath = async (path: AnalysisPath, seconds: number) => {
    setBusy(true);
    try {
      await engine.unlock();
      if (!snap.playing) await engine.start();
      await engine.runRingExperiment({ path, seconds });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <section
        id="ring-pressure"
        className="rounded-xl bg-surface p-4 transition-transform duration-700 sm:p-5"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-xl">
            <h2 className="text-base font-medium">Lock-free analysis tap</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted text-pretty">
              The existing <code className="text-fg">WavetableProcessor</code> writes
              each output quantum into a preallocated SharedArrayBuffer ring.
              A worker reads it, computes RMS and peak, and posts only low-rate
              meter values. <code className="text-fg">process()</code> still
              allocates nothing.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={a.source === "osc" ? "default" : "secondary"}
              onClick={() => void engine.setAnalysisSource("osc")}
            >
              <Radio className="size-4" />
              Oscillator
            </Button>
            <Button
              variant={a.source === "mic" ? "default" : "secondary"}
              onClick={() => void engine.setAnalysisSource("mic")}
            >
              <Mic className="size-4" />
              Microphone
            </Button>
          </div>
        </div>

        {!a.isolated ? (
          <div className="mt-4 rounded-lg border border-warn/40 bg-warn/10 px-3 py-3 text-sm text-warn">
            Cross-origin isolation is unavailable in this document (
            <code>crossOriginIsolated === false</code>). SharedArrayBuffer
            cannot be constructed, so the shared ring is disabled. The
            transferable-block path still runs. Locally, <code>npm run dev</code>{" "}
            sends COOP/COEP headers and enables the shared path.
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            <Badge variant="ok">crossOriginIsolated</Badge>
            <Badge variant="ok">SharedArrayBuffer ring · 32 768 samples</Badge>
          </div>
        )}

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Meter label="RMS" value={a.rms} />
          <Meter label="Peak hold" value={a.peakHold} />
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Path" value={a.path} hint={a.isolated ? "SAB armed" : "transfer only"} />
        <StatCard label="Written" value={a.writtenBlocks} hint="worklet quanta" />
        <StatCard
          label="Dropped"
          value={a.droppedBlocks}
          tone={a.droppedBlocks ? "warn" : "ok"}
          hint="writer lapped / pool empty"
        />
        <StatCard
          label="p99 tap"
          value={`${a.latencyMs.toFixed(1)} ms`}
          hint={`${a.processUs.toFixed(0)} µs render`}
        />
        <StatCard label="Analyzed" value={a.analyzedBlocks} />
        <StatCard label="Display posts" value={a.displayPosts} hint="≤ 60 Hz" />
        <StatCard
          label="Overruns"
          value={a.overrunEvents}
          tone={a.overrunEvents ? "warn" : "ok"}
        />
        <StatCard
          label="Deadline miss"
          value={a.deadlineMiss}
          tone={a.deadlineMiss ? "danger" : "ok"}
        />
      </section>

      <section className="rounded-xl bg-surface p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-xl">
            <h3 className="text-sm font-medium">Shared ring vs transferable blocks</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted text-pretty">
              One-minute run with a 25 ms main-thread stall every 200 ms.
              Success: ≥ 99% of intended analysis updates, p99 latency under
              30 ms, zero audio deadline misses.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={busy || !a.isolated}
              onClick={() => void startPath("shared", 60)}
            >
              <Activity className="size-4" />
              Shared · 60s
            </Button>
            <Button disabled={busy} onClick={() => void startPath("transfer", 60)}>
              Transfer · 60s
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void startPath(a.isolated ? "shared" : "transfer", 8)}
            >
              Probe · 8s
            </Button>
            {exp.running ? (
              <Button variant="danger" onClick={() => engine.cancelRingExperiment()}>
                Stop
              </Button>
            ) : null}
          </div>
        </div>
        {(exp.running || exp.notes) && (
          <div className="mt-4">
            <div className="mb-2 flex justify-between font-mono text-xs text-subtle tabular-nums">
              <span>
                {exp.elapsed.toFixed(1)}s / {exp.seconds}s · {exp.path}
              </span>
              <span>{Math.round(Math.min(1, exp.elapsed / exp.seconds) * 100)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.min(100, (exp.elapsed / exp.seconds) * 100)}%` }}
              />
            </div>
          </div>
        )}
        {exp.notes ? (
          <p className={`mt-3 text-sm ${exp.pass ? "text-ok" : "text-warn"}`}>{exp.notes}</p>
        ) : null}
        {exp.intended > 0 && !exp.running ? (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Intended" value={exp.intended} />
            <StatCard label="Delivered" value={exp.delivered} />
            <StatCard label="Dropped" value={exp.dropped} />
            <StatCard label="Median / p99" value={`${exp.medianMs.toFixed(1)} / ${exp.p99Ms.toFixed(1)} ms`} />
          </div>
        ) : null}
      </section>
    </div>
  );
}
