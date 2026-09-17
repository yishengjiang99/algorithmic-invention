/** 16-step pattern at 120 BPM, 16th notes. 0 = rest. */
export const STEP_COUNT = 16;
export const DEFAULT_TEMPO = 120;
export const LOOKAHEAD_PRESETS = [10, 25, 50, 100, 200] as const;
export const LOOKAHEAD_MIN = 10;
export const LOOKAHEAD_MAX = 200;

export const PATTERN_MIDI = [
  48, 0, 55, 0, 48, 52, 55, 60, 48, 0, 55, 62, 60, 55, 52, 0,
] as const;

export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function stepDuration(tempo: number): number {
  return 60 / tempo / 4;
}

export const PATTERN_FREQ = PATTERN_MIDI.map((m) => (m > 0 ? midiToFreq(m) : 0));

export const SOUNDED_PER_BAR = PATTERN_MIDI.filter((m) => m > 0).length;
