export type ScoreNote = {
  midi: number;
  time: number;
  duration: number;
  name: string;
};

export type Invention = {
  voice1: ScoreNote[];
  voice2: ScoreNote[];
  beats: number;
  bpm: number;
};

type DegreeNote = { degree: number; timeOffset: number; duration: number; time?: number };

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** D harmonic minor. Degree 0 = D4 (MIDI 62). */
const D_MINOR = [62, 64, 65, 67, 69, 70, 73];

export const INVENTION_BEATS = 20;
export const INVENTION_BPM = 90;

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToName(midi: number): string {
  const n = Math.round(midi);
  return NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

function degreeToMidi(degree: number): number {
  const octaves = Math.floor(degree / 7);
  const scaleDegree = ((degree % 7) + 7) % 7;
  return D_MINOR[scaleDegree]! + octaves * 12;
}

function generateSeedMotif(): DegreeNote[] {
  const rhythm = [0.5, 0.25, 0.25, 0.5, 0.5];
  const motif: DegreeNote[] = [];
  let currentBeat = 0;
  let degree = [0, 2, 4][Math.floor(Math.random() * 3)]!;
  for (let i = 0; i < rhythm.length; i++) {
    const dur = rhythm[i]!;
    motif.push({ degree, timeOffset: currentBeat, duration: dur * 0.9 });
    currentBeat += dur;
    degree += (Math.random() > 0.5 ? 1 : -1) * Math.floor(Math.random() * 3 + 1);
  }
  return motif;
}

function invertMotif(motif: DegreeNote[]): DegreeNote[] {
  const first = motif[0]!.degree;
  return motif.map((note) => ({
    degree: first - (note.degree - first),
    timeOffset: note.timeOffset,
    duration: note.duration,
  }));
}

function transposeMotif(motif: DegreeNote[], degreeOffset: number): DegreeNote[] {
  return motif.map((note) => ({
    degree: note.degree + degreeOffset,
    timeOffset: note.timeOffset,
    duration: note.duration,
  }));
}

function generateCounterSubject(startDegree: number, lengthInBeats: number): DegreeNote[] {
  const cs: DegreeNote[] = [];
  let currentDegree = startDegree;
  for (let beat = 0; beat < lengthInBeats; beat += 0.5) {
    cs.push({ degree: currentDegree, timeOffset: beat, duration: 0.45 });
    currentDegree += Math.random() > 0.4 ? -1 : 1;
  }
  return cs;
}

function finalize(notes: DegreeNote[]): ScoreNote[] {
  return notes.map((n) => {
    const midi = degreeToMidi(n.degree);
    return {
      midi,
      time: n.time ?? n.timeOffset,
      duration: n.duration,
      name: midiToName(midi),
    };
  });
}

/** Two-part invention in D minor: exposition, sequential episode, cadence. */
export function generateInvention(): Invention {
  const voice1: DegreeNote[] = [];
  const voice2: DegreeNote[] = [];
  const motif = generateSeedMotif();
  const invMotif = invertMotif(motif);
  const m = 4;

  motif.forEach((n) => voice1.push({ ...n, time: n.timeOffset }));
  voice2.push({ degree: -7, timeOffset: 0, time: 0, duration: 2.0 });

  const answer = transposeMotif(motif, -3);
  answer.forEach((n) => voice2.push({ ...n, time: n.timeOffset + m }));
  const cs = generateCounterSubject(2, 4);
  cs.forEach((n) => voice1.push({ ...n, time: n.timeOffset + m }));

  const sequenceOffsets = [3, -1, 1, -2];
  for (let i = 0; i < 4; i++) {
    const beatStart = m * 2 + i * 2;
    const v1Frag = transposeMotif(invMotif.slice(0, 3), sequenceOffsets[i]!);
    v1Frag.forEach((n) => voice1.push({ ...n, time: n.timeOffset + beatStart }));
    const v2Frag = transposeMotif(motif.slice(0, 3), sequenceOffsets[i]! - 7);
    v2Frag.forEach((n) => voice2.push({ ...n, time: n.timeOffset + beatStart }));
  }

  const cadTime = m * 4;
  voice1.push({ degree: 6, timeOffset: 0, time: cadTime, duration: 1.0 });
  voice1.push({ degree: 7, timeOffset: 0, time: cadTime + 1, duration: 2.5 });
  voice2.push({ degree: -10, timeOffset: 0, time: cadTime, duration: 1.0 });
  voice2.push({ degree: -7, timeOffset: 0, time: cadTime + 1, duration: 2.5 });

  return {
    voice1: finalize(voice1),
    voice2: finalize(voice2),
    beats: INVENTION_BEATS,
    bpm: INVENTION_BPM,
  };
}
