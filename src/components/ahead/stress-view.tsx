import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { pickWinner, summarizeByLookAhead } from "@/lib/scheduler/stats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAhead } from "@/hooks/use-ahead";

export function StressView() {
  const { engine, snap } = useAhead();
  const { experiment } = snap;
  const [protocol, setProtocol] = useState<"probe" | "quick" | "full">("probe");
  const summary = useMemo(
    () => summarizeByLookAhead(experiment.rows),
    [experiment.rows],
  );
  const { winnerMs, hypothesisHeld } = pickWinner(experiment.rows);

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-xl bg-surface p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-xl">
            <h2 className="text-base font-medium">Main-thread stall battery</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted text-pretty">
              Hypothesis: look-ahead of at least 50 ms eliminates missed events
              when the main thread is blocked for 20 ms every 80 ms. Success is
              the smallest setting with zero misses across three runs and timing
              error under 5 ms for at least 99% of notes.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:items-end">
            <div className="flex flex-wrap gap-1.5">
              <ProtocolChip
                active={protocol === "probe"}
                onClick={() => setProtocol("probe")}
                label="Probe · 5s × 1"
              />
              <ProtocolChip
                active={protocol === "quick"}
                onClick={() => setProtocol("quick")}
                label="Quick · 12s × 3"
              />
              <ProtocolChip
                active={protocol === "full"}
                onClick={() => setProtocol("full")}
                label="Full · 60s × 3"
              />
            </div>
            {experiment.running ? (
              <Button
                variant="danger"
                onClick={() => engine.cancelExperiment()}
                disabled={experiment.cancelling}
              >
                {experiment.cancelling ? "Cancelling…" : "Cancel"}
              </Button>
            ) : (
              <Button
                onClick={() => {
                  engine.unlock();
                  void engine.runExperiment({ protocol });
                }}
              >
                Run battery
              </Button>
            )}
          </div>
        </div>
        {experiment.running || experiment.progressLabel ? (
          <p className="mt-4 font-mono text-xs text-muted tabular-nums">
            {experiment.progressLabel}
            {experiment.total > 0
              ? ` · ${experiment.completed}/${experiment.total}`
              : ""}
          </p>
        ) : null}
      </section>

      {summary.length > 0 ? (
        <section className="rounded-xl bg-surface p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium">By look-ahead</h2>
            {winnerMs !== null ? (
              <Badge variant="ok">Safe at {winnerMs} ms</Badge>
            ) : (
              <Badge variant="warn">No passing setting yet</Badge>
            )}
            {hypothesisHeld !== null ? (
              <Badge variant={hypothesisHeld ? "accent" : "warn"}>
                {hypothesisHeld ? "Hypothesis holds" : "Hypothesis missed"}
              </Badge>
            ) : null}
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={summary} barGap={4}>
                <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis
                  dataKey="lookAheadMs"
                  tickFormatter={(v) => `${v} ms`}
                  stroke="#8b8f98"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="#8b8f98"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  cursor={{ fill: "rgba(255,255,255,0.04)" }}
                  contentStyle={{
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 8,
                    fontFamily: "IBM Plex Mono, ui-monospace, monospace",
                    fontSize: 12,
                    color: "var(--color-fg)",
                  }}
                />
                <Bar dataKey="missed" name="Missed" fill="#c47a72" radius={[4, 4, 0, 0]} />
                <Bar dataKey="late" name="Late" fill="#c4a882" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      ) : null}

      <section className="rounded-xl bg-surface p-4 sm:p-5">
        <h2 className="mb-3 text-sm font-medium">Run log</h2>
        {experiment.rows.length === 0 ? (
          <p className="text-sm text-muted">
            No runs yet. Start the battery to fill this table. The UI will hitch
            during stalls — that is the experiment.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs tabular-nums">
              <thead className="text-subtle">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3 font-medium whitespace-nowrap">LA</th>
                  <th className="py-2 pr-3 font-medium whitespace-nowrap">Run</th>
                  <th className="py-2 pr-3 font-medium whitespace-nowrap">Played</th>
                  <th className="py-2 pr-3 font-medium whitespace-nowrap">Late</th>
                  <th className="py-2 pr-3 font-medium whitespace-nowrap">Miss</th>
                  <th className="py-2 pr-3 font-medium whitespace-nowrap">Within 5ms</th>
                  <th className="py-2 pr-3 font-medium whitespace-nowrap">Mean</th>
                  <th className="py-2 pr-3 font-medium whitespace-nowrap">Max</th>
                  <th className="py-2 pr-3 font-medium whitespace-nowrap">Q max</th>
                  <th className="py-2 pr-3 font-medium whitespace-nowrap">Stalls</th>
                </tr>
              </thead>
              <tbody>
                {experiment.rows.map((row) => {
                  const pass = row.missed === 0 && row.within5pct >= 99;
                  return (
                    <tr
                      key={`${row.lookAheadMs}-${row.run}`}
                      className="border-b border-border/60"
                    >
                      <td className="py-2 pr-3 whitespace-nowrap">{row.lookAheadMs} ms</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{row.run}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{row.played}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{row.late}</td>
                      <td
                        className={
                          pass
                            ? "py-2 pr-3 whitespace-nowrap"
                            : "py-2 pr-3 whitespace-nowrap text-danger"
                        }
                      >
                        {row.missed}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {row.within5pct.toFixed(1)}%
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {row.errMeanMs.toFixed(2)} ms
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {row.errMaxMs.toFixed(2)} ms
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">{row.queueMax}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{row.stallCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {winnerMs !== null ? (
          <p className="mt-4 text-sm leading-relaxed text-muted text-pretty">
            Smallest passing look-ahead:{" "}
            <span className="text-fg">{winnerMs} ms</span>. Recommended default is
            50 ms — it covers 20 ms stalls with margin and does not change tempo.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function ProtocolChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-on={active}
      className="h-9 rounded-full px-3 text-xs text-muted shadow-[0_0_0_1px_rgba(255,255,255,0.08)] hover:text-fg data-[on=true]:bg-primary data-[on=true]:text-primary-fg data-[on=true]:shadow-none"
    >
      {label}
    </button>
  );
}
