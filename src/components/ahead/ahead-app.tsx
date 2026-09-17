import { useEffect, useState } from "react";
import { Activity, AudioLines, BookOpen } from "lucide-react";
import { PlayView } from "./play-view";
import { StressView } from "./stress-view";
import { ModelView } from "./model-view";
import { getEngine } from "@/lib/scheduler/engine";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "play", label: "Play", icon: AudioLines },
  { id: "stress", label: "Stress", icon: Activity },
  { id: "model", label: "Model", icon: BookOpen },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function AheadApp() {
  const [tab, setTab] = useState<TabId>("play");

  useEffect(() => {
    const engine = getEngine();
    window.__ahead = engine.api();
    const onVis = () => {
      if (document.visibilityState === "visible") engine.unlock();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
    };
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
              Ahead
            </h1>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-muted text-pretty">
              Sample-accurate notes from a look-ahead queue. The main thread
              timestamps; the worklet renders.
            </p>
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
        {tab === "stress" ? <StressView /> : null}
        {tab === "model" ? <ModelView /> : null}

        <footer className="border-t border-border pt-4 text-xs text-subtle">
          Look-ahead is a time buffer, not a tempo control. Default 50 ms.
        </footer>
      </div>
    </div>
  );
}

declare global {
  interface Window {
    __ahead?: ReturnType<ReturnType<typeof getEngine>["api"]>;
  }
}
