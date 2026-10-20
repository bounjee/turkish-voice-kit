/**
 * Background sound must not hold a ready reply.
 *
 * In an outbound call the callee said "Olur, anlat." and the LLM produced the reply in 2.3 s, but a TV
 * in the background (−30…−40 dBFS) kept the VAD open for 16 s and the reply never played. LiveKit
 * holds a ready reply for AS LONG AS the user counts as speaking, with NO time limit (agents-js
 * `agent_activity.ts`: authorization waits on `userSilenceEvent.wait()`; the resume timer of a paused
 * speech also starts only when the VAD says "stopped"). No setting bounds it; the Python version
 * behaves the same.
 *
 * Rule: while a reply is ready (or the agent was paused while speaking), once ongoing sound passes
 * `HOLD_MS` its level is checked. If it is `MARGIN_DB` quieter than the caller's accepted turns in
 * this call (`LevelGate.turnDb`) it is background (Vapi `fourierDenoisingPlan`: relative to the
 * speaker's own level, not a fixed threshold). If the caller's level is not known yet it counts as
 * background after `BLIND_MS`, and even sound at the caller's level after `CAP_MS`: a silent agent is
 * worse than an agent that talks over a long monologue. Model-based separation (speaker embeddings)
 * alone was measured and was not enough; see speaker-filter.ts for the complementary filter.
 */
export const BACKGROUND_HOLD = {
  /**
   * Shorter sound holds the reply only briefly anyway; no decision. Lowered from 2.5 to 1.5 s after a
   * TV test call and a replay of 7 real calls with background sound: the TV is learned as background
   * earlier and the gate drops it for the rest of the call; false turns fell from 32 to 17 with no
   * change in lost caller speech.
   */
  HOLD_MS: 1_500,
  /**
   * Sound this much quieter than the caller's own level is background. In test calls callers
   * interrupting were at most 6 dB below their own level; the TV was 18 dB, a person behind 13-15 dB.
   */
  MARGIN_DB: 8,
  /** Without a known caller level (before the first turn), background after this long. */
  BLIND_MS: 5_000,
  /** Even sound at the caller's level stops holding the reply after this long. */
  CAP_MS: 8_000,
} as const;

export type HoldVerdict = "wait" | "background";

export function holdVerdict(input: { activityMs: number; levelDb: number | null; turnDb: number | null }): HoldVerdict {
  const { activityMs, levelDb, turnDb } = input;
  if (activityMs < BACKGROUND_HOLD.HOLD_MS) return "wait";
  if (activityMs >= BACKGROUND_HOLD.CAP_MS) return "background";
  if (turnDb === null || levelDb === null) return activityMs >= BACKGROUND_HOLD.BLIND_MS ? "background" : "wait";
  return levelDb <= turnDb - BACKGROUND_HOLD.MARGIN_DB ? "background" : "wait";
}
