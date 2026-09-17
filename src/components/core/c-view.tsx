import { useCore } from "@/hooks/use-core";

export function CView() {
  const { snap } = useCore();
  const src = snap.cSource || "// tap Start to load wavetable.c";

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-xl bg-surface p-4 sm:p-5">
        <h2 className="text-base font-medium">wavetable.c</h2>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted text-pretty">
          Freestanding C — no libc, no grow. This is the file wabt assembles into
          a single-page WASM module inside the AudioWorklet.
        </p>
        <pre className="mt-4 max-h-[70vh] overflow-auto rounded-lg bg-bg p-4 font-mono text-xs leading-relaxed text-fg">
          {src}
        </pre>
      </section>
    </div>
  );
}
