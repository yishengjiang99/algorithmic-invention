import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createEstimator } from "../../../public/midi-clock/estimator.js";
import { generateTrace } from "../../../public/midi-clock/synthetic.js";
import { replay, judge } from "../../../public/midi-clock/replay.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("trace generator is deterministic and honours its impairments", () => {
  const a = generateTrace({ seed: 9 });
  const b = generateTrace({ seed: 9 });
  assert.deepEqual(Array.from(a.t), Array.from(b.t));
  assert.notDeepEqual(
    Array.from(a.t.slice(0, 50)),
    Array.from(generateTrace({ seed: 10 }).t.slice(0, 50)),
  );
  const ideal = a.trueTimes.length;
  const dropped = ideal - a.t.length;
  assert.ok(dropped > ideal * 0.005 && dropped < ideal * 0.02, `dropped ${dropped}/${ideal}`);
  let maxErr = 0;
  let delayed = 0;
  for (let i = 0; i < a.t.length; i++) {
    const err = a.t[i] - a.trueTimes[a.tick[i]];
    if (a.tick[i] % 64 === 63) {
      delayed++;
      assert.ok(err >= 17 && err <= 23, `delayed clock error ${err}`);
    } else maxErr = Math.max(maxErr, Math.abs(err));
  }
  assert.ok(maxErr <= 3 && maxErr > 2.9, `jitter bound ${maxErr}`);
  assert.ok(delayed > 50);
});

test("replay scoring: a jitter-free trace scores ~0 error", () => {
  const trace = generateTrace({ seed: 3, jitterMs: 0, dropRate: 0, delayEvery: 0 });
  const r = replay(createEstimator("filtered"), trace);
  assert.ok(r.phaseP95Ms < 1e-6 && r.bpmMaxErr < 1e-6, JSON.stringify(r));
  assert.ok(judge(r).all);
});

test("docs/midi-clock-experiment.md is exactly what the script produces", () => {
  const out = execFileSync(process.execPath, ["scripts/midi-clock-experiment.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(out, /up to date/);
});
