import assert from "node:assert/strict";
import { test } from "node:test";
import { ParticipantTracker, SpeakerTap } from "../src/speaker-filter.ts";

/** Unit vector along `axis`, with `mix` blended into a shared axis (to tune similarity). */
function voice(axis: number, mix = 0): Float32Array {
  const v = new Float32Array(8);
  v[axis] = 1;
  v[7] = mix;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

const WOMAN = voice(0);
const MAN = voice(1);
const CHILD = voice(2);

test("real call: the woman and the man are participants, the child behind them is dropped", () => {
  const t = new ParticipantTracker();
  // the agent speaks 0-8.1 s, the woman says her name 2 s later: first voice
  assert.equal(t.decide({ vec: WOMAN, startedAt: 10_170, overAgent: false, lastAgentStopAt: 8_120, durationMs: 1_000 }).accept, true);
  // the agent asks for the number (stops at 25.56), the man says it 2 s later: the answering voice becomes a participant
  const man = t.decide({ vec: MAN, startedAt: 27_520, overAgent: false, lastAgentStopAt: 25_560, durationMs: 1_700 });
  assert.deepEqual([man.accept, man.admitted], [true, true]);
  // the child speaks 7.5 s after the agent stopped: not a participant
  assert.equal(t.decide({ vec: CHILD, startedAt: 33_080, overAgent: false, lastAgentStopAt: 25_560, durationMs: 1_000 }).accept, false);
  assert.equal(t.decide({ vec: CHILD, startedAt: 34_200, overAgent: false, lastAgentStopAt: 25_560, durationMs: 1_400 }).accept, false);
  // the child cuts in while the agent speaks: dropped
  assert.equal(t.decide({ vec: CHILD, startedAt: 44_380, overAgent: true, lastAgentStopAt: 37_000, durationMs: 900 }).accept, false);
  // the man confirms (0.8 s after the agent stopped): known participant
  assert.equal(t.decide({ vec: MAN, startedAt: 55_580, overAgent: false, lastAgentStopAt: 54_780, durationMs: 1_400 }).accept, true);
  // the twice-rejected child speaks 3 s after the agent stopped: outside the strict window (1.5 s), dropped
  assert.equal(t.decide({ vec: CHILD, startedAt: 81_530, overAgent: false, lastAgentStopAt: 78_580, durationMs: 700 }).accept, false);
});

test("the same person's voice with a small difference is the same voice", () => {
  const t = new ParticipantTracker();
  t.decide({ vec: WOMAN, startedAt: 1_000, overAgent: false, lastAgentStopAt: null, durationMs: 1_000 });
  const again = t.decide({ vec: voice(0, 0.4), startedAt: 20_000, overAgent: false, lastAgentStopAt: 5_000, durationMs: 1_000 });
  assert.equal(again.accept, true);
  assert.equal(again.voice, 1);
});

test("a voice heard over the agent (maybe echo) is not added to the profile but is remembered", () => {
  const t = new ParticipantTracker();
  t.decide({ vec: WOMAN, startedAt: 1_000, overAgent: false, lastAgentStopAt: null, durationMs: 1_000 });
  const first = t.decide({ vec: CHILD, startedAt: 5_000, overAgent: true, lastAgentStopAt: 2_000, durationMs: 800 });
  assert.equal(first.accept, false);
  const second = t.decide({ vec: CHILD, startedAt: 9_000, overAgent: true, lastAgentStopAt: 2_000, durationMs: 800 });
  assert.equal(second.voice, first.voice);
});

/** Unit vector with the given weights on the given axes. */
function blend(...parts: [axis: number, weight: number][]): Float32Array {
  const v = new Float32Array(8);
  for (const [axis, weight] of parts) v[axis] = weight;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

test("the caller interrupting is not captured by a weak cluster heard only over the agent", () => {
  /* Live test: the caller tried to interrupt twice and could not. The first interruption was 0.29
     similar to their profile (threshold 0.30) and became a separate voice; the next was 0.47 similar
     to their profile and 0.48 to that single sample, and was swallowed as "not a participant". */
  const t = new ParticipantTracker();
  t.decide({ vec: WOMAN, startedAt: 8_000, overAgent: false, lastAgentStopAt: 7_200, durationMs: 1_000 });
  const first = t.decide({ vec: blend([0, 0.29], [3, 0.957]), startedAt: 15_400, overAgent: true, lastAgentStopAt: 7_200, durationMs: 700 });
  assert.deepEqual([first.voice, first.accept], [2, false]);
  const later = t.decide({ vec: blend([0, 0.47], [3, 0.359], [4, 0.806]), startedAt: 43_400, overAgent: true, lastAgentStopAt: 31_800, durationMs: 1_600 });
  assert.deepEqual([later.voice, later.accept], [1, true]);
});

test("a foreign voice also heard while the agent was silent stays in its own cluster when it interrupts", () => {
  const t = new ParticipantTracker();
  t.decide({ vec: WOMAN, startedAt: 8_000, overAgent: false, lastAgentStopAt: 7_200, durationMs: 1_000 });
  // the child speaks 6 s after the agent stopped: not a participant, but it has a profile
  assert.equal(t.decide({ vec: blend([0, 0.2], [2, 0.98]), startedAt: 13_200, overAgent: false, lastAgentStopAt: 7_200, durationMs: 1_000 }).accept, false);
  // the child again over the agent: 0.32 similar to the woman (above threshold) but much closer to its own cluster
  const over = t.decide({ vec: blend([0, 0.32], [2, 0.947]), startedAt: 20_000, overAgent: true, lastAgentStopAt: 7_200, durationMs: 900 });
  assert.deepEqual([over.voice, over.accept], [2, false]);
});

test("a new participant is accepted when answering the agent's question", () => {
  const t = new ParticipantTracker();
  t.decide({ vec: WOMAN, startedAt: 1_000, overAgent: false, lastAgentStopAt: null, durationMs: 1_000 });
  assert.equal(t.decide({ vec: MAN, startedAt: 10_000, overAgent: false, lastAgentStopAt: 4_000, durationMs: 1_000 }).accept, false);
  assert.equal(t.decide({ vec: MAN, startedAt: 21_000, overAgent: false, lastAgentStopAt: 20_000, durationMs: 1_000 }).accept, true);
});

test("against lock-in: a foreign voice that keeps talking alone becomes a participant", () => {
  const t = new ParticipantTracker();
  t.decide({ vec: CHILD, startedAt: 1_000, overAgent: false, lastAgentStopAt: null, durationMs: 1_000 }); // first voice
  const late = { overAgent: false, lastAgentStopAt: 2_000, durationMs: 1_000 };
  assert.equal(t.decide({ vec: MAN, startedAt: 9_000, ...late }).accept, false);
  assert.equal(t.decide({ vec: MAN, startedAt: 12_000, ...late }).accept, false);
  assert.equal(t.decide({ vec: MAN, startedAt: 15_000, ...late }).accept, false);
  assert.deepEqual(
    (({ accept, admitted }) => ({ accept, admitted }))(t.decide({ vec: MAN, startedAt: 18_000, ...late })),
    { accept: true, admitted: true },
  );
});

test("accepted speech resets the rejection streak", () => {
  const t = new ParticipantTracker();
  t.decide({ vec: WOMAN, startedAt: 1_000, overAgent: false, lastAgentStopAt: null, durationMs: 1_000 });
  const late = { overAgent: false, lastAgentStopAt: 2_000, durationMs: 1_000 };
  t.decide({ vec: CHILD, startedAt: 9_000, ...late });
  t.decide({ vec: CHILD, startedAt: 10_000, ...late });
  t.decide({ vec: WOMAN, startedAt: 11_000, ...late });
  t.decide({ vec: CHILD, startedAt: 12_000, ...late });
  assert.equal(t.decide({ vec: CHILD, startedAt: 13_000, ...late }).accept, false);
});

test("the first voice during the greeting is not a participant by default; it becomes one by answering", () => {
  const t = new ParticipantTracker();
  assert.equal(t.decide({ vec: CHILD, startedAt: 3_000, overAgent: true, lastAgentStopAt: null, durationMs: 800 }).accept, false);
  assert.equal(t.decide({ vec: WOMAN, startedAt: 9_500, overAgent: false, lastAgentStopAt: 8_000, durationMs: 1_000 }).accept, true);
});

test("the first participant after the agent closes the window: a new voice right after cannot get in", () => {
  const t = new ParticipantTracker();
  // the greeting ended (8 s), the caller said their name
  assert.equal(t.decide({ vec: WOMAN, startedAt: 10_000, overAgent: false, lastAgentStopAt: 8_000, durationMs: 1_000 }).accept, true);
  // the TV speaks in the same window (2.7 s after the agent stopped): cannot get in
  assert.equal(t.decide({ vec: CHILD, startedAt: 10_700, overAgent: false, lastAgentStopAt: 8_000, durationMs: 500 }).accept, false);
  // the caller's voice arriving a bit different (separate cluster) gets in if loosely similar to the same person
  const loose = t.decide({ vec: voice(0, 4), startedAt: 11_000, overAgent: false, lastAgentStopAt: 8_000, durationMs: 800 }); // cosine 0.24
  assert.deepEqual([loose.accept, loose.admitted, loose.voice === 1], [true, true, false]);
});

test("without a voiceprint (no vector) speech always passes", () => {
  const t = new ParticipantTracker();
  assert.equal(t.decide({ vec: null, startedAt: 1_000, overAgent: true, lastAgentStopAt: null, durationMs: 1_000 }).accept, true);
});

test("SpeakerTap: pre-roll + utterance, ignores anything not 16 kHz", () => {
  const tap = new SpeakerTap(300);
  const frame = (n: number, value = 1000) => new Int16Array(n).fill(value);
  tap.push(frame(16_000), 16_000); // audio before the utterance: only the last 300 ms stays
  tap.start();
  tap.push(frame(8_000), 16_000);
  const seg = tap.stop();
  assert.ok(seg);
  assert.equal(seg.length, 4_800 + 8_000);
  assert.ok(Math.abs(seg[0] - 1000 / 32768) < 1e-6);
  tap.start();
  tap.push(frame(480), 48_000);
  assert.equal(tap.stop(), null);
});

test("SpeakerTap: only the last 3 s of a long utterance", () => {
  const tap = new SpeakerTap(0);
  tap.start();
  tap.push(new Int16Array(16_000 * 5).fill(1000), 16_000);
  tap.push(new Int16Array(160).fill(2000), 16_000);
  const seg = tap.stop()!;
  assert.equal(seg.length, 48_000);
  assert.ok(Math.abs(seg[seg.length - 1] - 2000 / 32768) < 1e-6);
});

/*
 * Late registration: the voiceprint model was not ready for the first ~20 s of a call, the first
 * utterance with a vector was the caller interrupting and could not become a participant; the same
 * person's next interruption was swallowed. Keep utterances that end before the model is ready and
 * process them IN ORDER once it is: the first question enters the profile as an answer to the agent,
 * and the interruptions are accepted.
 */
test("late registration: processing queued utterances in order keeps the caller's interruptions", () => {
  const GUEST = voice(0);
  const lateRegistered = new ParticipantTracker();
  // Queued utterance: the agent stopped at 14.02, the caller asked at 15.36 ("Fiyatlarınız nedir?").
  lateRegistered.decide({ vec: GUEST, startedAt: 15_360, overAgent: false, lastAgentStopAt: 14_020, durationMs: 1_180 });
  const first = lateRegistered.decide({ vec: voice(0, 0.3), startedAt: 27_870, overAgent: true, lastAgentStopAt: 14_020, durationMs: 2_020 });
  const second = lateRegistered.decide({ vec: voice(0, 0.4), startedAt: 44_130, overAgent: true, lastAgentStopAt: 14_020, durationMs: 1_660 });
  assert.deepEqual([first.accept, second.accept], [true, true]);

  // Control: if queued utterances are dropped, the first interruption with a vector cannot become a participant and the second is swallowed.
  const dropped = new ParticipantTracker();
  dropped.decide({ vec: voice(0, 0.3), startedAt: 27_870, overAgent: true, lastAgentStopAt: 14_020, durationMs: 2_020 });
  assert.equal(dropped.decide({ vec: voice(0, 0.4), startedAt: 44_130, overAgent: true, lastAgentStopAt: 14_020, durationMs: 1_660 }).accept, false);
});
