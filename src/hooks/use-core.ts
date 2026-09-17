import { useSyncExternalStore } from "react";
import { getEngine, type CoreSnapshot } from "@/lib/wavetable/engine";

const serverSnap: CoreSnapshot = getEngine().getServerSnapshot();

export function useCore() {
  const engine = getEngine();
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot, () => serverSnap);
  return { engine, snap };
}
