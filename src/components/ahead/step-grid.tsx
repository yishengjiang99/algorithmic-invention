import { PATTERN_MIDI } from "@/lib/scheduler/pattern";
import { cn } from "@/lib/utils";

export function StepGrid({ step, playing }: { step: number; playing: boolean }) {
  return (
    <div className="grid grid-cols-8 gap-1.5 sm:grid-cols-16">
      {PATTERN_MIDI.map((midi, i) => {
        const active = playing && i === step;
        const sounded = midi > 0;
        return (
          <div
            key={i}
            className={cn(
              "relative flex h-14 flex-col justify-end overflow-hidden rounded-md sm:h-16",
              sounded ? "bg-surface-2" : "bg-bg",
              active && "ring-1 ring-primary",
            )}
          >
            {sounded ? (
              <div
                className={cn(
                  "w-full rounded-sm transition-colors duration-150",
                  active ? "bg-primary" : "bg-accent/45",
                )}
                style={{ height: `${28 + ((midi - 48) / 14) * 52}%` }}
              />
            ) : (
              <div className="mx-auto mb-2 h-px w-3 bg-border" />
            )}
            <span className="pointer-events-none absolute top-1 left-1 font-mono text-micro text-subtle tabular-nums">
              {i + 1}
            </span>
          </div>
        );
      })}
    </div>
  );
}
