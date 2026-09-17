import { useSyncExternalStore } from "react";
import { getEngine, type AheadSnapshot } from "@/lib/scheduler/engine";

const serverSnap: AheadSnapshot = getEngine().getServerSnapshot();

export function useAhead() {
  const engine = getEngine();
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot, () => serverSnap);
  return { engine, snap };
}
