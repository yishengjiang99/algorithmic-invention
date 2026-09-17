import { pickWinner, summarizeByLookAhead } from "@/lib/scheduler/stats";
import { Badge } from "@/components/ui/badge";
import { useAhead } from "@/hooks/use-ahead";

export function ModelView() {
  const { snap } = useAhead();
  const summary = summarizeByLookAhead(snap.experiment.rows);
  const { winnerMs, hypothesisHeld } = pickWinner(snap.experiment.rows);
  const recommended = winnerMs ?? 50;

  return (
    <article className="mx-auto flex max-w-2xl flex-col gap-8 text-pretty">
      <header className="flex flex-col gap-2">
        <h2 className="text-xl font-medium tracking-tight">Timing model</h2>
        <p className="text-sm leading-relaxed text-muted">
          Two clocks, one queue. The audio thread is real-time; the main thread
          is not. Look-ahead is the slack that keeps them in phase.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Two clocks</h3>
        <p className="text-sm leading-relaxed text-muted">
          <code className="font-mono text-fg">AudioContext.currentTime</code> is
          the audio clock — seconds of rendered audio, stable even while the
          page janks. <code className="font-mono text-fg">performance.now()</code>{" "}
          and <code className="font-mono text-fg">setTimeout</code> live on the
          main thread and slip under load. Scheduling notes with the wall clock
          is how you get flams and dropped hits.
        </p>
        <p className="text-sm leading-relaxed text-muted">
          The main-thread scheduler wakes every{" "}
          <span className="text-fg">clamp(lookAhead / 2, 4, 25) ms</span> and
          posts every pattern step whose audio time falls inside{" "}
          <code className="font-mono text-fg">currentTime + lookAhead</code>.
          Changing look-ahead only changes how early those messages leave. Step
          times still advance by a constant 16th (0.125 s at 120 BPM), so tempo
          does not move.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">The worklet quantum</h3>
        <p className="text-sm leading-relaxed text-muted">
          <code className="font-mono text-fg">process()</code> is called once
          per render quantum — usually 128 samples, about 2.7 ms at 48 kHz.
          Notes whose timestamp lands in this window start at
        </p>
        <pre className="overflow-x-auto rounded-lg bg-surface-2 px-4 py-3 font-mono text-xs text-fg">
          startSample = round((t − currentTime) × sampleRate)
        </pre>
        <p className="text-sm leading-relaxed text-muted">
          That offset is sample-accurate. A 1 ms linear attack and exponential
          decay keep the pluck click-free. Voices are a fixed pool of 24; the
          quietest is stolen if needed. Events travel as one packed{" "}
          <code className="font-mono text-fg">Float64Array</code> — no JSON, no
          per-note objects.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">What late and missed mean</h3>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-muted">
          <li>
            <span className="text-fg">On time</span> — scheduled sample is
            inside this quantum.
          </li>
          <li>
            <span className="text-fg">Late</span> — the note arrived after its
            quantum started, still within 10 ms, and is rendered at sample 0.
          </li>
          <li>
            <span className="text-fg">Missed</span> — more than 10 ms late; it
            is dropped so a stall does not dump a clump of overdue notes.
          </li>
        </ul>
        <p className="text-sm leading-relaxed text-muted">
          Skip and dupe counters watch the monotonic note id. They catch a
          broken queue, not a late one.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">process() allocation contract</h3>
        <p className="text-sm leading-relaxed text-muted">
          The constructor owns the ring buffer, voice arrays, and a 20-wide
          stats vector. <code className="font-mono text-fg">process()</code>{" "}
          never calls <code className="font-mono text-fg">new</code>, never
          builds <code className="font-mono text-fg">[]</code> or{" "}
          <code className="font-mono text-fg">{"{}"}</code>, and never maps or
          slices. Stats are posted every 8 quanta by cloning that one typed
          array. The alloc flag in the message path is written as 0 every
          callback — if it is ever nonzero, the contract is broken.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Safe look-ahead</h3>
        <p className="text-sm leading-relaxed text-muted">
          A 20 ms stall uncovers <span className="text-fg">max(0, stall −
          lookAhead)</span> of the audio timeline. Notes that should have been
          posted in that hole arrive late, then miss. Covering the stall wants
          look-ahead ≥ 20 ms plus a couple of quanta and one timer interval —
          in practice 50 ms. 10 ms fails. 25 ms is the borderline. 100–200 ms
          is extra margin, paid for as scheduling latency (irrelevant for a
          pre-sequenced pattern).
        </p>
        <div className="overflow-x-auto rounded-lg bg-surface">
          <table className="w-full text-left font-mono text-xs tabular-nums">
            <thead className="text-subtle">
              <tr className="border-b border-border">
                <th className="px-3 py-2 font-medium">Look-ahead</th>
                <th className="px-3 py-2 font-medium">Cover vs 20 ms stall</th>
                <th className="px-3 py-2 font-medium">Prediction</th>
                <th className="px-3 py-2 font-medium">Measured</th>
              </tr>
            </thead>
            <tbody>
              {PREDICTIONS.map((row) => {
                const measured = summary.find((s) => s.lookAheadMs === row.ms);
                return (
                  <tr key={row.ms} className="border-b border-border/60">
                    <td className="px-3 py-2 text-fg whitespace-nowrap">{row.ms} ms</td>
                    <td className="px-3 py-2 whitespace-nowrap">{row.cover}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{row.prediction}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {measured
                        ? `${measured.missed} miss · ${measured.within5pct.toFixed(1)}% ≤5 ms`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">Recommended default</h3>
          <Badge variant="accent">{recommended} ms</Badge>
          {hypothesisHeld === true ? <Badge variant="ok">Hypothesis holds</Badge> : null}
          {hypothesisHeld === false ? <Badge variant="warn">See stress log</Badge> : null}
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Use 50 ms unless the stress battery names a smaller passing value on
          this device. Dragging the slider while the pattern runs should leave
          the BPM readout still. If it does not, the scheduler is sampling the
          wrong clock.
        </p>
      </section>
    </article>
  );
}

const PREDICTIONS = [
  { ms: 10, cover: "uncovered 10 ms", prediction: "misses" },
  { ms: 25, cover: "≈ stall length", prediction: "borderline" },
  { ms: 50, cover: "~30 ms remaining", prediction: "clean" },
  { ms: 100, cover: "~80 ms remaining", prediction: "clean" },
  { ms: 200, cover: "~180 ms remaining", prediction: "clean" },
] as const;
