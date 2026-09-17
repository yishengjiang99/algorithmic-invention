import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "ok" | "warn" | "danger";
}) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-3">
      <div className="font-mono text-micro tracking-wider text-subtle uppercase">{label}</div>
      <div
        className={cn(
          "mt-1 font-mono text-xl text-fg tabular-nums",
          tone === "ok" && "text-ok",
          tone === "warn" && "text-warn",
          tone === "danger" && "text-danger",
        )}
      >
        {value}
      </div>
      {hint ? <div className="mt-1 text-xs text-subtle">{hint}</div> : null}
    </div>
  );
}
