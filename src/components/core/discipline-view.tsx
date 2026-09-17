import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/ahead/stat-card";
import { useCore } from "@/hooks/use-core";

export function DisciplineView() {
  const { engine, snap } = useCore();
  const d = snap.discipline;
  const pct = d.seconds > 0 ? Math.min(1, d.elapsed / d.seconds) : 0;

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-xl bg-surface p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-xl">
            <h2 className="text-base font-medium">Real-time memory discipline</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted text-pretty">
              The WASM module is linked with <code className="text-fg">initial = max = 1</code>{" "}
              page (64 KiB). Growth is structurally impossible. Both render paths
              preallocate tables, voice state, and the output scratch;{" "}
              <code className="text-fg">process()</code> does not construct arrays
              or objects. A 32-voice run should report zero NaN/Inf samples and
              zero deadline overruns.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {d.running ? (
              <Button variant="danger" onClick={() => engine.cancelDiscipline()}>
                Stop
              </Button>
            ) : (
              <>
                <Button
                  variant="secondary"
                  onClick={() => {
                    engine.unlock();
                    void engine.runDiscipline(20);
                  }}
                >
                  Probe · 20s
                </Button>
                <Button
                  onClick={() => {
                    engine.unlock();
                    void engine.runDiscipline(300);
                  }}
                >
                  Full · 5 min
                </Button>
              </>
            )}
          </div>
        </div>
        {(d.running || d.done) && (
          <div className="mt-5">
            <div className="mb-2 flex justify-between font-mono text-xs text-subtle tabular-nums">
              <span>
                {d.elapsed.toFixed(1)}s / {d.seconds}s
              </span>
              <span>{Math.round(pct * 100)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${pct * 100}%` }}
              />
            </div>
          </div>
        )}
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard
          label="Pages"
          value={`${d.pages} / 1`}
          hint={`start ${d.startPages}`}
          tone={d.grew ? "danger" : "ok"}
        />
        <StatCard label="Grew?" value={d.grew ? "YES" : "no"} tone={d.grew ? "danger" : "ok"} />
        <StatCard
          label="NaN / Inf"
          value={`${d.nan} / ${d.inf}`}
          tone={d.nan || d.inf ? "danger" : "ok"}
        />
        <StatCard
          label="Overruns"
          value={d.overruns}
          hint="> 50% of quantum"
          tone={d.overruns ? "danger" : "ok"}
        />
        <StatCard label="Alloc flag" value={d.allocFlag} tone={d.allocFlag ? "danger" : "ok"} />
        <StatCard label="p99" value={`${d.p99Us.toFixed(1)} µs`} hint={`${d.quanta} quanta`} />
      </section>

      <section className="rounded-xl bg-surface p-4 sm:p-5">
        <h3 className="text-sm font-medium">Timing model</h3>
        <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted text-pretty">
          <p>
            The audio thread wakes once per render quantum (128 frames at the
            hardware rate, typically 2.67 ms at 48 kHz). That interval is the
            deadline. Main-thread timers never write samples; they only push
            k-rate AudioParam values and compact control messages.
          </p>
          <p>
            WASM <code className="text-fg">render(n)</code> is the single
            JS↔WASM call per quantum. Frequency and gain targets are poked into
            a pre-bound Float32Array view on WASM memory — no
            <code className="text-fg"> set_voice</code> trampoline in the hot
            path. Tables live in BSS; the module cannot grow because the memory
            section is <code className="text-fg">(memory 1 1)</code>.
          </p>
          <p>
            Click-free envelopes are one-pole ramps inside the voice loop (5 ms
            gain, 8 ms pitch) plus <code className="text-fg">setTargetAtTime</code>{" "}
            on the AudioParams. Mipmapped tables drop harmonics above Nyquist
            for the voice’s frequency, so pitch glides do not alias.
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge variant="ok">0 alloc in process()</Badge>
          <Badge variant="ok">memory 1 / 1</Badge>
          <Badge variant="default">Rust · wasm32-unknown-unknown</Badge>
        </div>
      </section>
    </div>
  );
}
