import assert from "node:assert/strict";
import { test } from "node:test";
import { LEVEL_GATE, LevelGate, frameDb } from "../src/level-gate.ts";

/* Quiet or distant sound does not reach the VAD; the caller's own normal voice always passes. */
const RATE = 16_000;
const FRAME = 320; // 20 ms

/** A 20 ms sine frame at the given RMS level (dBFS). */
function tone(db: number): Int16Array {
  const amplitude = Math.SQRT2 * 10 ** (db / 20) * 32767;
  return Int16Array.from({ length: FRAME }, (_, i) => Math.round(amplitude * Math.sin((2 * Math.PI * 200 * i) / RATE)));
}

/** Pushes the same level for `ms`; returns the decision for the last frame. */
function feed(gate: LevelGate, db: number, ms: number): boolean {
  let open = false;
  for (let t = 0; t < ms; t += 20) open = gate.push(tone(db), RATE);
  return open;
}

/** One accepted utterance: silence → VAD start → sound → VAD end. */
function utterance(gate: LevelGate, db: number, ms = 1_000): void {
  feed(gate, -90, 500);
  gate.startUtterance();
  feed(gate, db, ms);
  gate.endUtterance();
}

test("frame level is measured in dBFS", () => {
  assert.ok(Math.abs(frameDb(tone(-24)) - -24) < 0.5);
  assert.equal(frameDb(new Int16Array(FRAME)), -120);
});

test("before the caller is known only very quiet sound is gated (Pipecat floor)", () => {
  const gate = new LevelGate();
  assert.equal(gate.thresholdDb, LEVEL_GATE.FLOOR_DB);
  assert.equal(feed(gate, -55, 600), false);
  assert.equal(feed(new LevelGate(), -40, 600), true);
});

test("speech 12 dB below the caller's normal voice is gated, slightly quieter speech passes", () => {
  const gate = new LevelGate();
  utterance(gate, -24);
  utterance(gate, -26);
  assert.ok(Math.abs(gate.thresholdDb - -38) < 1.5);
  assert.equal(feed(gate, -45, 600), false, "whisper");
  assert.equal(feed(gate, -33, 600), true, "the caller's slightly quieter sentence");
});

test("the threshold never exceeds the cap: a caller who shouted first still passes at normal level", () => {
  const gate = new LevelGate();
  utterance(gate, -8);
  assert.equal(gate.thresholdDb, LEVEL_GATE.CAP_DB);
  assert.equal(feed(gate, -22, 600), true);
});

/* Phone test call: caller at −11…−23 dBFS, a person talking behind them at −30/−32. With the cap at
   −35 the background voice interrupted the agent and was answered. */
test("to interrupt the agent, sound must be close to the caller's own level", () => {
  const gate = new LevelGate();
  for (const db of [-19, -14, -23, -17]) utterance(gate, db);
  gate.agentSpeaking = true;
  assert.equal(feed(gate, -31, 600), false, "person in the background");
  assert.equal(feed(gate, -22, 600), true, "the caller interrupting");
  gate.agentSpeaking = false;
  assert.equal(feed(gate, -29, 600), true, "while the agent listens, sound within the 12 dB margin passes");
  assert.equal(feed(gate, -38, 600), false);
});

test("a short dip between words does not split the sentence", () => {
  const gate = new LevelGate();
  utterance(gate, -24);
  feed(gate, -24, 600);
  // 100 ms of near silence: the window still carries the speech.
  assert.equal(feed(gate, -70, 100), true);
});

test("a short sound (cough, click) does not change the caller level", () => {
  const gate = new LevelGate();
  utterance(gate, -24);
  gate.startUtterance();
  feed(gate, -6, 100);
  gate.endUtterance();
  assert.ok(Math.abs((gate.callerDb ?? 0) - -24) < 1);
});

/* In a smoke test with real Silero, quiet speech that barely passed pulled the caller level down: the
   threshold fell from −35 to −48 and the gate loosened itself. */
test("quiet speech that barely passes does not lower the caller level", () => {
  const gate = new LevelGate();
  utterance(gate, -20);
  const before = gate.thresholdDb;
  utterance(gate, -34);
  utterance(gate, -34);
  assert.equal(gate.thresholdDb, before);
});

test("when gated quiet sound ends, its duration and level are reported", () => {
  const gate = new LevelGate();
  utterance(gate, -24);
  const blocked: number[] = [];
  const report = (ms: number) => blocked.push(ms);
  for (let t = 0; t < 600; t += 20) gate.push(tone(-46), RATE, report);
  for (let t = 0; t < 600; t += 20) gate.push(new Int16Array(FRAME), RATE, report);
  assert.equal(blocked.length, 1);
  assert.ok(blocked[0] >= 500);
});

test("in off mode everything passes", () => {
  const gate = new LevelGate("off");
  assert.equal(feed(gate, -70, 400), true);
});

/*
 * Learning from echo: during the greeting the agent's echo counted as "speech" twice (−39/−41 dBFS),
 * the caller level was learned from it and the threshold sat at the floor (−50) for the first 20 s.
 * Speech that starts while the agent speaks is not learned as the caller's level.
 */
test("an utterance with learning off is not learned but its level is returned", () => {
  const gate = new LevelGate("adaptive");
  feed(gate, -90, 500);
  gate.startUtterance();
  feed(gate, -40, 1_000);
  assert.ok(Math.abs((gate.endUtterance(false) ?? 0) + 40) < 1);
  assert.equal(gate.callerDb, null);
  utterance(gate, -20);
  assert.ok(Math.abs((gate.callerDb ?? 0) + 20) < 1);
  assert.ok(gate.thresholdDb > -35);
});

/*
 * Outbound call with a TV: the callee's "Olur, anlat." (−18 dBFS) started while the opening sentence
 * played and was not learned (it might be echo). The threshold stayed at the floor (−50) and the TV
 * (−30…−40) kept the VAD open for 16 s. Speech that started while the agent spoke is learned once its
 * transcript is accepted as a real turn (echo and backchannels are swallowed, so they are not).
 */
test("speech that started over the agent is learned once it reaches the LLM", () => {
  const gate = new LevelGate();
  feed(gate, -90, 500);
  gate.startUtterance();
  feed(gate, -18, 1_000);
  gate.endUtterance(false);
  assert.equal(gate.callerDb, null);
  gate.acceptTurn();
  assert.ok(Math.abs((gate.callerDb ?? 0) + 18) < 1);
  assert.ok(Math.abs(gate.thresholdDb + 30) < 1);
  assert.ok(Math.abs((gate.turnDb ?? 0) + 18) < 1);
});

test("only the last utterance is accepted, once", () => {
  const gate = new LevelGate();
  utterance(gate, -18);
  feed(gate, -90, 500);
  gate.startUtterance();
  feed(gate, -40, 1_000);
  gate.endUtterance(false); // echo: transcript swallowed, no turn
  feed(gate, -90, 500);
  gate.startUtterance();
  feed(gate, -20, 1_000);
  gate.endUtterance(false);
  gate.acceptTurn();
  gate.acceptTurn();
  assert.ok(Math.abs((gate.callerDb ?? 0) + 20) < 1, "the accepted −20 is learned, not the echo's −40");
  assert.ok(Math.abs((gate.turnDb ?? 0) + 20) < 1);
});

/* Same call: a quiet utterance before the greeting (−41) never reached the LLM; the caller's sentence was −15. */
test("the turn level counts only utterances that reached the LLM", () => {
  const gate = new LevelGate();
  utterance(gate, -41);
  assert.equal(gate.turnDb, null);
  feed(gate, -90, 500);
  gate.startUtterance();
  feed(gate, -15, 1_500);
  gate.endUtterance(false);
  gate.acceptTurn();
  assert.ok(Math.abs((gate.turnDb ?? 0) + 15) < 1);
});

/* Same call: the TV never stopped, so the VAD never said "stopped". Sound judged as background
   (background-hold.ts) no longer reaches the VAD and its level is remembered for the whole call; the
   caller's own voice always passes. */
test("the ongoing utterance's level can be read", () => {
  const gate = new LevelGate();
  utterance(gate, -18);
  feed(gate, -90, 500);
  gate.startUtterance();
  feed(gate, -28, 2_500);
  assert.ok(Math.abs((gate.utteranceDb ?? 0) + 28) < 1);
});

test("background sound stops reaching the VAD while it lasts; the caller's voice passes", () => {
  const gate = new LevelGate();
  utterance(gate, -18);
  gate.acceptTurn();
  feed(gate, -90, 500);
  gate.startUtterance();
  assert.equal(feed(gate, -28, 2_500), true, "the TV passes the threshold");
  gate.suppress();
  assert.equal(feed(gate, -28, 3_000), false, "the TV is suppressed");
  assert.equal(feed(gate, -18, 400), true, "the caller speaks and passes");
  assert.equal(feed(gate, -28, 600), false, "the TV is suppressed again when the caller stops");
});

test("background stays gated after a pause; suppressed sound is not learned", () => {
  const gate = new LevelGate();
  utterance(gate, -18);
  gate.acceptTurn();
  feed(gate, -90, 500);
  gate.startUtterance();
  feed(gate, -28, 2_500);
  gate.suppress();
  feed(gate, -28, 1_000);
  gate.endUtterance();
  assert.ok(Math.abs((gate.callerDb ?? 0) + 18) < 1);
  feed(gate, -90, 2_000);
  assert.equal(feed(gate, -28, 600), false, "the TV started again");
  assert.equal(feed(gate, -22, 600), true, "the caller's slightly quieter voice still passes");
});

test("the background threshold stays below the caller's turn level", () => {
  const gate = new LevelGate();
  utterance(gate, -26);
  gate.acceptTurn();
  feed(gate, -90, 500);
  gate.startUtterance();
  feed(gate, -29, 2_500); // loud TV, close to the caller
  gate.suppress();
  gate.endUtterance();
  assert.ok(gate.thresholdDb <= -26 - LEVEL_GATE.UNDER_TURN_DB + 0.5);
  assert.equal(feed(gate, -26, 600), true, "the caller passes at their own level");
});

test("without a caller turn the background threshold stays under the cap (the line must not die if the caller is judged as background during the greeting)", () => {
  const gate = new LevelGate();
  feed(gate, -90, 500);
  gate.startUtterance();
  feed(gate, -25, 5_000); // the caller (−25) was judged as background during the greeting
  gate.suppress();
  gate.endUtterance();
  assert.ok(gate.thresholdDb <= LEVEL_GATE.CAP_DB + 0.01);
  assert.equal(feed(gate, -20, 600), true, "the caller's normal voice passes");
});

test("after the background decision the caller's voice is counted (do not drop the transcript), the TV is not", () => {
  const gate = new LevelGate();
  utterance(gate, -18);
  gate.acceptTurn();
  feed(gate, -90, 500);
  gate.startUtterance();
  feed(gate, -28, 1_600); // TV while a reply waits
  gate.suppress();
  feed(gate, -28, 1_000);
  assert.equal(gate.heardAfterSuppressMs, 0, "the TV does not count");
  feed(gate, -18, 600); // the caller speaks
  assert.ok(gate.heardAfterSuppressMs >= 300);
  gate.startUtterance();
  assert.equal(gate.heardAfterSuppressMs, 0, "reset on a new utterance");
});
