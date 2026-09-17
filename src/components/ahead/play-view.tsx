import { useEffect, useState } from "react";
import { Play, Square, Volume2, VolumeX } from "lucide-react";
import { LOOKAHEAD_PRESETS } from "@/lib/scheduler/pattern";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Scope } from "./scope";
import { StatCard } from "./stat-card";
import { StepGrid } from "./step-grid";
import { useAhead } from "@/hooks/use-ahead";

function fmt(n: number, digits = 0) {
  return n.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

export function PlayView() {
  const { engine, snap } = useAhead();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { stats, endurance } = snap;
  const missTone =
    stats.missed > 0 || stats.skips > 0 || stats.dupes > 0
      ? "danger"
      : stats.late > 0
        ? "warn"
        : "ok";

  return (
    <div className="grid gap-6 lg:grid-cols-12">
      <aside className="flex flex-col gap-4 rounded-xl bg-surface p-4 lg:col-span-4">
        <Button
          size="lg"
          className="h-12 w-full"
          onClick={() => {
            if (snap.playing) engine.stop();
            else void engine.startFromGesture();
          }}
        >
          {snap.playing ? (
            <>
              <Square className="size-4" />
              Stop
            </>
          ) : (
            <>
              <Play className="ml-0.5 size-4" />
              Start pattern
            </>
          )}
        </Button>

        {snap.error ? (
          <p className="text-sm text-danger text-pretty">{snap.error}</p>
        ) : (
          <p className="text-sm text-muted text-pretty">
            16-step phrase at 120 BPM. Events are timestamped on the main thread
            and rendered sample-accurately in the worklet.
          </p>
        )}

        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <label className="text-xs font-medium tracking-wide text-muted uppercase">
              Look-ahead
            </label>
            <span className="font-mono text-sm text-fg tabular-nums">{snap.lookAheadMs} ms</span>
          </div>
          {mounted ? (
            <Slider
              min={10}
              max={200}
              step={1}
              value={[snap.lookAheadMs]}
              onValueChange={(v) => engine.setLookAhead(v[0] ?? 50)}
              aria-label="Look-ahead in milliseconds"
            />
          ) : (
            <div className="h-11" />
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {LOOKAHEAD_PRESETS.map((ms) => (
              <button
                key={ms}
                type="button"
                onClick={() => engine.setLookAhead(ms)}
                className="h-9 rounded-full px-3 font-mono text-xs text-muted tabular-nums shadow-[0_0_0_1px_rgba(255,255,255,0.08)] hover:text-fg data-[on=true]:bg-primary data-[on=true]:text-primary-fg data-[on=true]:shadow-none"
                data-on={snap.lookAheadMs === ms}
              >
                {ms}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs font-medium tracking-wide text-muted uppercase">
              Level
            </label>
            <button
              type="button"
              className="flex size-11 items-center justify-center text-muted hover:text-fg"
              onClick={() => engine.setMuted(!snap.muted)}
              aria-label={snap.muted ? "Unmute" : "Mute"}
            >
              {snap.muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </button>
          </div>
          {mounted ? (
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={[snap.volume]}
              onValueChange={(v) => engine.setVolume(v[0] ?? 0.7)}
              aria-label="Output level"
            />
          ) : (
            <div className="h-11" />
          )}
        </div>

        <div className="mt-auto flex flex-col gap-2">
          <Button
            variant="secondary"
            disabled={endurance.running || snap.experiment.running}
            onClick={() => {
              engine.unlock();
              void engine.runEndurance(120_000);
            }}
          >
            2-minute endurance
          </Button>
          {endurance.running ? (
            <p className="font-mono text-xs text-muted tabular-nums">
              {Math.ceil(endurance.remainingMs / 1000)}s remaining
            </p>
          ) : null}
          {endurance.result ? (
            <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
              <Badge variant={endurance.result.ok ? "ok" : "danger"}>
                {endurance.result.ok ? "Clean" : "Faults"}
              </Badge>
              <p className="mt-2 font-mono text-xs text-muted tabular-nums">
                played {endurance.result.played} · skip {endurance.result.skipped} · dupe{" "}
                {endurance.result.dupes} · miss {endurance.result.missed} ·{" "}
                {fmt(endurance.result.measuredBpm, 1)} BPM
              </p>
            </div>
          ) : null}
        </div>
      </aside>

      <div className="flex flex-col gap-4 lg:col-span-8">
        <div className="rounded-xl bg-surface p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium">Pattern</h2>
            <div className="flex items-center gap-2">
              <Badge variant={snap.playing ? "ok" : "default"}>
                {snap.playing ? "Running" : "Idle"}
              </Badge>
              <span className="font-mono text-xs text-muted tabular-nums">
                {fmt(snap.measuredBpm, 1)} BPM
              </span>
            </div>
          </div>
          <StepGrid step={snap.step} playing={snap.playing} />
        </div>

        <div className="rounded-xl bg-surface p-4">
          <h2 className="mb-3 text-sm font-medium">Output</h2>
          <Scope active={snap.playing} />
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatCard label="Played" value={fmt(stats.played)} hint="sounded notes" />
          <StatCard
            label="Late"
            value={fmt(stats.late)}
            tone={stats.late > 0 ? "warn" : "default"}
          />
          <StatCard label="Missed" value={fmt(stats.missed)} tone={missTone} />
          <StatCard label="Queue" value={fmt(stats.queue)} hint={`max ${fmt(stats.queueMax)}`} />
        </div>

        <div className="rounded-xl bg-surface p-4">
          <h2 className="mb-3 text-sm font-medium">Message path</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-xs tabular-nums sm:grid-cols-4">
            <PathItem k="Timer fires" v={fmt(stats.timerFires)} />
            <PathItem k="Notes posted" v={fmt(stats.notesPosted)} />
            <PathItem k="Received" v={fmt(stats.received)} />
            <PathItem k="Underruns" v={fmt(stats.underruns)} />
            <PathItem k="Skips" v={fmt(stats.skips)} />
            <PathItem k="Dupes" v={fmt(stats.dupes)} />
            <PathItem k="Quantum" v={`${fmt(stats.quantum)} smp`} />
            <PathItem k="process() allocs" v={fmt(stats.alloc)} />
            <PathItem k="Mean error" v={`${fmt(stats.errMeanMs, 3)} ms`} />
            <PathItem k="Max error" v={`${fmt(stats.errMaxMs, 2)} ms`} />
            <PathItem k="Within 5 ms" v={`${fmt(stats.within5pct, 1)}%`} />
            <PathItem k="Dropped" v={fmt(stats.dropped)} />
          </dl>
        </div>
      </div>
    </div>
  );
}

function PathItem({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-subtle uppercase">{k}</dt>
      <dd className="text-fg">{v}</dd>
    </div>
  );
}
