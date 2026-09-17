import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCore } from "@/hooks/use-core";
import type { BenchProtocol } from "@/lib/wavetable/engine";

export function BenchView() {
  const { engine, snap } = useCore();
  const { bench } = snap;
  const [protocol, setProtocol] = useState<BenchProtocol>("probe");

  const chart = [1, 8, 16, 32].map((v) => {
    const js = bench.rows.find((r) => r.engine === "js" && r.voices === v);
    const wasm = bench.rows.find((r) => r.engine === "wasm" && r.voices === v);
    return {
      voices: String(v),
      JS: js ? round1(js.p99Us) : 0,
      WASM: wasm ? round1(wasm.p99Us) : 0,
    };
  });

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-xl bg-surface p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-xl">
            <h2 className="text-base font-medium">JS DSP versus WASM DSP</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted text-pretty">
              Same oscillator loop, two languages. Render time is recorded for
              every 128-frame quantum at 1, 8, 16, and 32 voices. Hypothesis:
              WASM pulls ahead as voice count rises, but JS stays competitive at
              one voice because of the boundary call.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:items-end">
            <div className="flex flex-wrap gap-1.5">
              <Chip active={protocol === "probe"} onClick={() => setProtocol("probe")} label="Probe · 1.5s" />
              <Chip active={protocol === "quick"} onClick={() => setProtocol("quick")} label="Quick · 4s" />
              <Chip active={protocol === "full"} onClick={() => setProtocol("full")} label="Full · 8s" />
            </div>
            {bench.running ? (
              <Button variant="danger" onClick={() => engine.cancelBench()} disabled={bench.cancelling}>
                {bench.cancelling ? "Cancelling…" : "Cancel"}
              </Button>
            ) : (
              <Button
                onClick={() => {
                  engine.unlock();
                  void engine.runBench({ protocol });
                }}
              >
                Run battery
              </Button>
            )}
          </div>
        </div>
        {bench.running || bench.progressLabel ? (
          <p className="mt-4 font-mono text-xs text-muted tabular-nums">
            {bench.progressLabel}
            {bench.total > 0 ? ` · ${bench.current}/${bench.total}` : ""}
          </p>
        ) : null}
      </section>

      {bench.rows.length > 0 ? (
        <section className="rounded-xl bg-surface p-4 sm:p-5">
          <h3 className="text-sm font-medium">p99 render time (µs)</h3>
          <div className="mt-4 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} barGap={4}>
                <CartesianGrid stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                <XAxis dataKey="voices" tick={{ fill: "currentColor", fontSize: 12 }} stroke="transparent" />
                <YAxis tick={{ fill: "currentColor", fontSize: 11 }} stroke="transparent" width={40} />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 12,
                    fontSize: 12,
                    color: "var(--color-fg)",
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="JS" fill="var(--color-warn)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="WASM" fill="var(--color-accent)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-3 text-xs text-subtle">
            Quantum budget ≈ {snap.budgetUs.toFixed(0)} µs. Success line is 50% (
            {(snap.budgetUs * 0.5).toFixed(0)} µs).
          </p>
        </section>
      ) : null}

      {bench.rows.length > 0 ? (
        <section className="overflow-x-auto rounded-xl bg-surface p-4 sm:p-5">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="font-mono text-micro tracking-wider text-subtle uppercase">
                <th className="pb-3 font-medium">Engine</th>
                <th className="pb-3 font-medium">Voices</th>
                <th className="pb-3 font-medium">Median</th>
                <th className="pb-3 font-medium">p99</th>
                <th className="pb-3 font-medium">Worst</th>
                <th className="pb-3 font-medium">Over</th>
                <th className="pb-3 font-medium">NaN</th>
                <th className="pb-3 font-medium">Half?</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {bench.rows.map((r) => (
                <tr key={r.engine + r.voices} className="border-t border-border">
                  <td className="py-2.5 uppercase">{r.engine}</td>
                  <td className="py-2.5">{r.voices}</td>
                  <td className="py-2.5">{r.medianUs.toFixed(1)}</td>
                  <td className="py-2.5">{r.p99Us.toFixed(1)}</td>
                  <td className="py-2.5">{r.maxUs.toFixed(1)}</td>
                  <td className="py-2.5">{r.overruns}</td>
                  <td className="py-2.5">{r.nan + r.inf}</td>
                  <td className="py-2.5">
                    {r.underHalf ? (
                      <Badge variant="ok">pass</Badge>
                    ) : (
                      <Badge variant="danger">fail</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {bench.rows.length > 0 && !bench.running ? (
        <section className="rounded-xl bg-surface p-4 sm:p-5">
          <h3 className="text-sm font-medium">Reading</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted text-pretty">{bench.crossover}</p>
          <ul className="mt-3 space-y-1 text-sm text-muted">
            <li>
              Max JS voices under 50% budget:{" "}
              <span className="text-fg">{bench.maxStableJs ?? "none"}</span>
            </li>
            <li>
              Max WASM voices under 50% budget:{" "}
              <span className="text-fg">{bench.maxStableWasm ?? "none"}</span>
            </li>
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function Chip({
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
      className={
        active
          ? "h-9 rounded-full bg-primary px-3 text-xs font-medium text-primary-fg"
          : "h-9 rounded-full bg-surface-2 px-3 text-xs font-medium text-muted hover:text-fg"
      }
    >
      {label}
    </button>
  );
}
