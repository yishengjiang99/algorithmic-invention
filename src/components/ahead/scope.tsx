import { useEffect, useRef } from "react";
import { getEngine } from "@/lib/scheduler/engine";

const W = 640;
const H = 120;
const POINTS = 160;

export function Scope({ active }: { active: boolean }) {
  const polyRef = useRef<SVGPolylineElement>(null);

  useEffect(() => {
    const poly = polyRef.current;
    if (!poly) return;
    let raf = 0;
    const draw = () => {
      const engine = getEngine();
      const analyser = engine.getAnalyser();
      const buf = engine.getScopeBuffer();
      if (analyser && buf && active) {
        analyser.getByteTimeDomainData(buf as Uint8Array<ArrayBuffer>);
        const step = Math.max(1, (buf.length / POINTS) | 0);
        let pts = "";
        for (let i = 0; i < POINTS; i++) {
          const v = buf[i * step] ?? 128;
          const x = (i / (POINTS - 1)) * W;
          const y = (v / 255) * H;
          pts += (i === 0 ? "" : " ") + x.toFixed(1) + "," + y.toFixed(1);
        }
        poly.setAttribute("points", pts);
      } else {
        poly.setAttribute("points", `0,${H / 2} ${W},${H / 2}`);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-28 w-full rounded-lg bg-bg"
      aria-hidden="true"
    >
      <line
        x1="0"
        y1={H / 2}
        x2={W}
        y2={H / 2}
        className="stroke-border"
        strokeWidth="1"
      />
      <polyline
        ref={polyRef}
        points={`0,${H / 2} ${W},${H / 2}`}
        className="fill-none stroke-accent"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
