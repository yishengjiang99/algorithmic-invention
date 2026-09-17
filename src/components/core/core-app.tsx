import { useEffect, useState } from "react";
import { Activity, AudioLines, Code2, Shield } from "lucide-react";
import { PlayView } from "./play-view";
import { BenchView } from "./bench-view";
import { DisciplineView } from "./discipline-view";
import { CView } from "./c-view";
import { getEngine } from "@/lib/wavetable/engine";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "play", label: "Play", icon: AudioLines },
  { id: "bench", label: "Bench", icon: Activity },
  { id: "discipline", label: "Discipline", icon: Shield },
  { id: "c", label: "C", icon: Code2 },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function CoreApp({ onBack }: { onBack?: () => void }) {
  const [tab, setTab] = useState<TabId>("play");

  useEffect(() => {
    const engine = getEngine();
    window.__core = engine.api();
    const onVis = () => {
      if (document.visibilityState === "visible") engine.unlock();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-xs tracking-widest text-subtle uppercase">
              AudioWorklet lab
            </p>
            <h1 className="mt-1 text-3xl font-medium tracking-tight text-balance sm:text-4xl">
              Core
            </h1>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-muted text-pretty">
              A band-limited wavetable written in C. On Start, wabt is fetched
              and assembles it to WASM on the audio thread.
            </p>
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                className="mt-3 font-serif text-sm text-gold hover:underline"
              >
                Back to the invention
              </button>
            ) : null}
          </div>
          <nav
            aria-label="Lab sections"
            className="flex h-11 items-center gap-1 rounded-full bg-surface p-1"
          >
            {TABS.map((item) => {
              const Icon = item.icon;
              const on = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={cn(
                    "flex h-9 items-center gap-2 rounded-full px-3.5 text-sm font-medium transition-colors duration-150",
                    on ? "bg-primary text-primary-fg" : "text-muted hover:text-fg",
                  )}
                  aria-current={on ? "page" : undefined}
                >
                  <Icon className="size-3.5" />
                  {item.label}
                </button>
              );
            })}
          </nav>
        </header>

        {tab === "play" ? <PlayView /> : null}
        {tab === "bench" ? <BenchView /> : null}
        {tab === "discipline" ? <DisciplineView /> : null}
        {tab === "c" ? <CView /> : null}

        <footer className="border-t border-border pt-4 text-xs text-subtle">
          C source is compiled in-page with wabt. WASM memory is one 64 KiB page.
          process() allocates nothing.
        </footer>
      </div>
    </div>
  );
}
