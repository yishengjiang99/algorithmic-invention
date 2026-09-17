import { useEffect, useRef } from "react";
import type { Invention } from "@/lib/invention/generate";

const MIN_MIDI = 40;
const MAX_MIDI = 85;

export function PianoRoll({
  score,
  playhead,
}: {
  score: Invention | null;
  playhead: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cssW = wrap.clientWidth;
      const cssH = Math.max(220, Math.min(400, Math.round(cssW * 0.5)));
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas.style.width = cssW + "px";
        canvas.style.height = cssH + "px";
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(ctx, cssW, cssH, score, playhead);
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [score, playhead]);

  return (
    <div ref={wrapRef} className="w-full">
      <canvas
        ref={canvasRef}
        className="block w-full rounded bg-panel shadow-[0_4px_6px_rgba(0,0,0,0.5)] ring-2 ring-border"
        aria-label="Piano roll of the two-part invention"
      />
    </div>
  );
}

function paint(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  score: Invention | null,
  playhead: number,
) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#1e1e1e";
  ctx.fillRect(0, 0, w, h);

  const totalBeats = score?.beats ?? 20;
  const pxBeat = w / totalBeats;
  const pxPitch = h / (MAX_MIDI - MIN_MIDI);

  ctx.strokeStyle = "#333333";
  ctx.lineWidth = 1;
  for (let i = 0; i <= totalBeats; i++) {
    ctx.beginPath();
    ctx.moveTo(i * pxBeat, 0);
    ctx.lineTo(i * pxBeat, h);
    ctx.stroke();
  }
  for (let i = 0; i <= 5; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 4 * pxBeat, 0);
    ctx.lineTo(i * 4 * pxBeat, h);
    ctx.strokeStyle = "#444444";
    ctx.stroke();
    ctx.strokeStyle = "#333333";
  }

  const drawNotes = (
    notes: { midi: number; time: number; duration: number }[],
    color: string,
  ) => {
    for (const note of notes) {
      const x = note.time * pxBeat;
      const y = h - (note.midi - MIN_MIDI) * pxPitch;
      const width = Math.max(2, note.duration * pxBeat - 1);
      const height = Math.max(pxPitch - 2, 4);
      const on = playhead >= note.time && playhead <= note.time + note.duration;
      ctx.fillStyle = on ? "#ffffff" : color;
      ctx.fillRect(x, y - height / 2, width, height);
    }
  };

  if (score) {
    drawNotes(score.voice2, "#ff6666");
    drawNotes(score.voice1, "#4da6ff");
  }

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  const x = playhead * pxBeat;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, h);
  ctx.stroke();
}
