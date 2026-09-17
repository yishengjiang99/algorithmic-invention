export type TuneNote = { n: string; d: number };

export type Tune = {
  id: string;
  name: string;
  bpm: number;
  notes: TuneNote[];
};

/** Equal-tempered A4 = 440. */
const A4 = 440;
const SEMI: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

export function noteHz(name: string): number {
  if (name === "rest" || name === ".") return 0;
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) return 0;
  const letter = m[1]!;
  const acc = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  const oct = Number(m[3]);
  const n = (SEMI[letter] ?? 0) + acc + (oct + 1) * 12;
  const a4 = 9 + 5 * 12; // A4 MIDI 69
  return A4 * Math.pow(2, (n - a4) / 12);
}

/** Beethoven — Symphony No. 9, public domain. Quarter = 1 beat. */
export const ODE_TO_JOY: Tune = {
  id: "ode",
  name: "Ode to Joy",
  bpm: 108,
  notes: [
    { n: "E4", d: 1 },
    { n: "E4", d: 1 },
    { n: "F4", d: 1 },
    { n: "G4", d: 1 },
    { n: "G4", d: 1 },
    { n: "F4", d: 1 },
    { n: "E4", d: 1 },
    { n: "D4", d: 1 },
    { n: "C4", d: 1 },
    { n: "C4", d: 1 },
    { n: "D4", d: 1 },
    { n: "E4", d: 1 },
    { n: "E4", d: 1.5 },
    { n: "D4", d: 0.5 },
    { n: "D4", d: 2 },

    { n: "E4", d: 1 },
    { n: "E4", d: 1 },
    { n: "F4", d: 1 },
    { n: "G4", d: 1 },
    { n: "G4", d: 1 },
    { n: "F4", d: 1 },
    { n: "E4", d: 1 },
    { n: "D4", d: 1 },
    { n: "C4", d: 1 },
    { n: "C4", d: 1 },
    { n: "D4", d: 1 },
    { n: "E4", d: 1 },
    { n: "D4", d: 1.5 },
    { n: "C4", d: 0.5 },
    { n: "C4", d: 2 },
  ],
};

export const TUNE_LIST: Tune[] = [ODE_TO_JOY];

export function tuneDuration(tune: Tune): number {
  const beat = 60 / tune.bpm;
  return tune.notes.reduce((s, n) => s + n.d * beat, 0);
}

export function noteAt(tune: Tune, elapsed: number): { n: string; i: number } {
  const beat = 60 / tune.bpm;
  const loop = tuneDuration(tune);
  let t = ((elapsed % loop) + loop) % loop;
  for (let i = 0; i < tune.notes.length; i++) {
    const d = tune.notes[i]!.d * beat;
    if (t < d) return { n: tune.notes[i]!.n, i };
    t -= d;
  }
  return { n: tune.notes[0]?.n ?? "rest", i: 0 };
}
