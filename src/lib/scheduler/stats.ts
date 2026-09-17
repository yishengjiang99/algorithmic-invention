export const S = {
  PLAYED: 0,
  LATE: 1,
  MISSED: 2,
  QUEUE: 3,
  QUEUE_MAX: 4,
  UNDERRUNS: 5,
  VOICES: 6,
  ERR_SUM: 7,
  ERR_MAX: 8,
  WITHIN_5: 9,
  RECEIVED: 10,
  DROPPED: 11,
  SKIPS: 12,
  DUPES: 13,
  LAST_ID: 14,
  QUANTUM: 15,
  AUDIO_TIME: 16,
  ALLOC: 17,
  STARTED_Q: 18,
  LAST_FREQ: 19,
} as const;

export type WorkletStats = {
  played: number;
  late: number;
  missed: number;
  queue: number;
  queueMax: number;
  underruns: number;
  voices: number;
  errMeanMs: number;
  errMaxMs: number;
  within5: number;
  within5pct: number;
  received: number;
  dropped: number;
  skips: number;
  dupes: number;
  quantum: number;
  audioTime: number;
  alloc: number;
};

export function emptyWorkletStats(): WorkletStats {
  return {
    played: 0,
    late: 0,
    missed: 0,
    queue: 0,
    queueMax: 0,
    underruns: 0,
    voices: 0,
    errMeanMs: 0,
    errMaxMs: 0,
    within5: 0,
    within5pct: 100,
    received: 0,
    dropped: 0,
    skips: 0,
    dupes: 0,
    quantum: 128,
    audioTime: 0,
    alloc: 0,
  };
}

export function decodeStats(buf: Float64Array): WorkletStats {
  const played = buf[S.PLAYED] ?? 0;
  const within5 = buf[S.WITHIN_5] ?? 0;
  const errSum = buf[S.ERR_SUM] ?? 0;
  return {
    played,
    late: buf[S.LATE] ?? 0,
    missed: buf[S.MISSED] ?? 0,
    queue: buf[S.QUEUE] ?? 0,
    queueMax: buf[S.QUEUE_MAX] ?? 0,
    underruns: buf[S.UNDERRUNS] ?? 0,
    voices: buf[S.VOICES] ?? 0,
    errMeanMs: played > 0 ? (errSum / played) * 1000 : 0,
    errMaxMs: (buf[S.ERR_MAX] ?? 0) * 1000,
    within5,
    within5pct: played > 0 ? (within5 / played) * 100 : 100,
    received: buf[S.RECEIVED] ?? 0,
    dropped: buf[S.DROPPED] ?? 0,
    skips: buf[S.SKIPS] ?? 0,
    dupes: buf[S.DUPES] ?? 0,
    quantum: buf[S.QUANTUM] ?? 128,
    audioTime: buf[S.AUDIO_TIME] ?? 0,
    alloc: buf[S.ALLOC] ?? 0,
  };
}

export type ExperimentRow = {
  lookAheadMs: number;
  run: number;
  durationMs: number;
  played: number;
  late: number;
  missed: number;
  skips: number;
  dupes: number;
  underruns: number;
  queueMax: number;
  errMeanMs: number;
  errMaxMs: number;
  within5pct: number;
  stallCount: number;
  timerFires: number;
  notesPosted: number;
};

export type ExperimentState = {
  running: boolean;
  cancelling: boolean;
  protocol: "probe" | "quick" | "full";
  progressLabel: string;
  completed: number;
  total: number;
  rows: ExperimentRow[];
  winnerMs: number | null;
  hypothesisHeld: boolean | null;
};

export function emptyExperiment(): ExperimentState {
  return {
    running: false,
    cancelling: false,
    protocol: "quick",
    progressLabel: "",
    completed: 0,
    total: 0,
    rows: [],
    winnerMs: null,
    hypothesisHeld: null,
  };
}

export function summarizeByLookAhead(rows: ExperimentRow[]) {
  const groups = new Map<number, ExperimentRow[]>();
  for (const row of rows) {
    const list = groups.get(row.lookAheadMs) ?? [];
    list.push(row);
    groups.set(row.lookAheadMs, list);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lookAheadMs, list]) => {
      const missed = list.reduce((s, r) => s + r.missed, 0);
      const late = list.reduce((s, r) => s + r.late, 0);
      const played = list.reduce((s, r) => s + r.played, 0);
      const within5pct =
        list.reduce((s, r) => s + r.within5pct, 0) / Math.max(1, list.length);
      const errMeanMs =
        list.reduce((s, r) => s + r.errMeanMs, 0) / Math.max(1, list.length);
      const errMaxMs = Math.max(...list.map((r) => r.errMaxMs), 0);
      const allZeroMiss = list.every((r) => r.missed === 0);
      const allP99 = list.every((r) => r.within5pct >= 99);
      return {
        lookAheadMs,
        runs: list.length,
        played,
        missed,
        late,
        within5pct,
        errMeanMs,
        errMaxMs,
        pass: allZeroMiss && allP99 && list.length > 0,
      };
    });
}

export function pickWinner(rows: ExperimentRow[]): {
  winnerMs: number | null;
  hypothesisHeld: boolean | null;
} {
  if (rows.length === 0) return { winnerMs: null, hypothesisHeld: null };
  const summary = summarizeByLookAhead(rows);
  const winner = summary.find((s) => s.pass);
  const winnerMs = winner?.lookAheadMs ?? null;
  const hypothesisHeld = winnerMs !== null ? winnerMs <= 50 : false;
  return { winnerMs, hypothesisHeld };
}
