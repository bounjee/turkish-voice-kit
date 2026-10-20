/**
 * Level gate in front of the VAD.
 *
 * Silero VAD ignores LOUDNESS: a whisper, speech from the other side of the room and echo residue
 * all count as "speech", and the browser's automatic gain control (AGC) boosts quiet sound further.
 * The gate sits at the VAD's INPUT: while it is closed the VAD receives silence. If your STT only
 * receives audio inside VAD activities (see gemini-stt.ts), gated sound is never transcribed, never
 * opens a turn and never interrupts the speaking agent. The STT gets its own (ungated) audio, so
 * accepted speech is never clipped.
 *
 * Two published methods, combined:
 * - Pipecat `VADParams.min_volume` 0.6: speech is ignored when the level of the last 400 ms window
 *   is below ≈ −50 LUFS (`vad_analyzer.py`, `audio/utils.py`). Here: `FLOOR_DB`.
 * - Vapi `fourierDenoisingPlan`: sound 15 dB below the speaker's own level (85th percentile) is
 *   dropped, with a fixed threshold until that baseline settles. Here: `OFFSET_DB` and `callerDb`.
 * The threshold never exceeds `CAP_DB`, so a caller who shouts the first sentence is not gated on the
 * next, normal one. Keep AGC on (Retell, ElevenLabs, LiveKit and Vapi clients keep it on).
 *
 * Two tiers. In a phone test the caller spoke at −11…−23 dBFS and a person behind them at −30/−32;
 * with the cap at −35 the threshold stuck there and the background voice interrupted the agent. The
 * cap moved to −25, and to interrupt WHILE the agent speaks, sound may be at most
 * `BARGE_IN_OFFSET_DB` below the caller's own level. Callers interrupt at their normal level (−16…−26
 * in test calls); the person behind them and echo are gated.
 */
export const LEVEL_GATE = {
  /** Lower threshold before the caller's level is known, and always (Pipecat ≈ −50 LUFS). */
  FLOOR_DB: -50,
  /**
   * Sound this far below the caller's own speaking level is gated. Vapi `baselineOffsetDb` is −15;
   * −12 here: the person behind the caller was ~13 dB quieter. Replaying three test calls, 59-100% of
   * the caller's utterances pass and 0% of the background person's.
   */
  OFFSET_DB: -12,
  /** While the agent speaks: sound this far below the caller's own level cannot interrupt. */
  BARGE_IN_OFFSET_DB: -10,
  /** Upper bound of the threshold: sound at this level always passes. */
  CAP_DB: -25,
  /** Sliding window for the level (Pipecat 400 ms). */
  WINDOW_MS: 400,
  /** The caller's level is the median of this many recent accepted utterances. */
  HISTORY: 5,
  /** Shortest open time for an utterance to count towards the caller's level. */
  MIN_UTTERANCE_MS: 300,
  /**
   * Only speech this close to the known caller level is learned. Quiet speech that barely passed the
   * threshold pulled the level down and loosened the gate (smoke test: −35 → −48).
   */
  ACCEPT_WITHIN_DB: 10,
  /**
   * Sound judged as background (background-hold.ts) is remembered for the whole call: only sound this
   * much louder reaches the VAD (TV call: caller −15, TV −33 dBFS). When the TV resumes after a short
   * pause it must not hold the reply again or pause the agent.
   */
  OVER_BACKGROUND_DB: 8,
  /** This threshold never rises above the level of the caller's accepted turns minus this: the caller always passes. */
  UNDER_TURN_DB: 6,
} as const;

/** Mean square of a frame (full scale 1). */
function meanSquare(samples: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  return samples.length ? sum / samples.length : 0;
}

function toDb(ms: number): number {
  return ms > 0 ? 10 * Math.log10(ms) : -120;
}

/** RMS level of a frame, dBFS. */
export function frameDb(samples: Int16Array): number {
  return toDb(meanSquare(samples));
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** Window for the tail of an utterance (`recentDb`). */
const RECENT_MS = 1_000;

export type GateMode = "adaptive" | "floor" | "off";

export class LevelGate {
  readonly #mode: GateMode;
  #window: { energy: number; ms: number }[] = [];
  #windowMs = 0;
  #utterance: number[] = [];
  #utteranceMs = 0;
  #history: number[] = [];
  /** Level of the last finished utterance and whether it was learned; applied if it becomes a turn (`acceptTurn`). */
  #last: { db: number; learned: boolean } | null = null;
  /** Levels of the caller's utterances that reached the LLM (background decision, background-hold.ts). */
  #turns: number[] = [];
  /** Level of sound judged as background (TV, next room), 85th percentile; kept for the whole call. */
  #backgroundDb: number | null = null;
  #utteranceSuppressed = false;
  /** Sound that passed the open gate in the last `RECENT_MS` (tail of the utterance, `recentDb`). */
  #recent: { db: number; ms: number }[] = [];
  #recentMs = 0;
  /** Sound the gate still passed in an utterance judged as background (the caller spoke over it). */
  #afterSuppressMs = 0;
  /** Continuous sound gated below the threshold: for logging. */
  #blockedMs = 0;
  #blockedPeakDb = -120;
  /** Is the agent speaking (set it from `AgentStateChanged`): the barge-in threshold applies. */
  agentSpeaking = false;

  constructor(mode: GateMode = "adaptive") {
    this.#mode = mode;
  }

  /** Median level of the caller's accepted utterances (the lower one for an even count); `null` if none. */
  get callerDb(): number | null {
    if (!this.#history.length) return null;
    const sorted = [...this.#history].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)];
  }

  /** Level of the ongoing utterance (85th percentile, same measure as `endUtterance`); `null` if short. */
  get utteranceDb(): number | null {
    return this.#utteranceMs >= LEVEL_GATE.MIN_UTTERANCE_MS ? percentile(this.#utterance, 0.85) : null;
  }

  get thresholdDb(): number {
    if (this.#mode === "off") return -Infinity;
    const caller = this.#mode === "adaptive" ? this.callerDb : null;
    const offset = this.agentSpeaking ? LEVEL_GATE.BARGE_IN_OFFSET_DB : LEVEL_GATE.OFFSET_DB;
    const own = caller === null ? LEVEL_GATE.FLOOR_DB : Math.min(Math.max(caller + offset, LEVEL_GATE.FLOOR_DB), LEVEL_GATE.CAP_DB);
    if (this.#backgroundDb === null) return own;
    const turn = this.turnDb;
    const background = this.#backgroundDb + LEVEL_GATE.OVER_BACKGROUND_DB;
    /* Without an accepted caller turn the background threshold does not exceed `CAP_DB` either: in a
       web test the caller's own −25 dB speech during the greeting was judged as background, the
       threshold rose to −17, the caller's −20 never passed again, and with no turn it never fell. */
    return Math.max(own, turn === null ? Math.min(background, LEVEL_GATE.CAP_DB) : Math.min(background, turn - LEVEL_GATE.UNDER_TURN_DB));
  }

  /**
   * Measures one frame: `true` → send it to the VAD as is, `false` → send silence instead. When gated
   * quiet sound ends, `onBlocked` reports its duration and peak level.
   */
  push(samples: Int16Array, sampleRate: number, onBlocked?: (ms: number, peakDb: number, thresholdDb: number) => void): boolean {
    const ms = (samples.length / sampleRate) * 1000;
    this.#window.push({ energy: meanSquare(samples), ms });
    this.#windowMs += ms;
    while (this.#window.length > 1 && this.#windowMs - this.#window[0].ms >= LEVEL_GATE.WINDOW_MS) {
      this.#windowMs -= this.#window.shift()!.ms;
    }
    const level = toDb(this.#window.reduce((sum, f) => sum + f.energy * f.ms, 0) / this.#windowMs);
    const threshold = this.thresholdDb;
    const open = level >= threshold;
    if (open && this.#utteranceSuppressed) this.#afterSuppressMs += ms;
    if (open) {
      this.#utterance.push(level);
      this.#utteranceMs += ms;
      this.#recent.push({ db: level, ms });
      this.#recentMs += ms;
      while (this.#recent.length > 1 && this.#recentMs - this.#recent[0].ms >= RECENT_MS) this.#recentMs -= this.#recent.shift()!.ms;
    }
    // Gated sound within 15 dB of the threshold is "quiet speech"; anything lower is room silence.
    if (!open && level >= threshold - 15) {
      this.#blockedMs += ms;
      this.#blockedPeakDb = Math.max(this.#blockedPeakDb, level);
    } else if (this.#blockedMs > 0) {
      onBlocked?.(Math.round(this.#blockedMs), this.#blockedPeakDb, threshold);
      this.#blockedMs = 0;
      this.#blockedPeakDb = -120;
    }
    return open;
  }

  /** The VAD said speech started: level measurement starts here. */
  startUtterance(): void {
    this.#utterance = [];
    this.#utteranceMs = 0;
    this.#recent = [];
    this.#recentMs = 0;
    this.#afterSuppressMs = 0;
    this.#utteranceSuppressed = false;
  }

  /**
   * The ongoing utterance was judged as background (background-hold.ts): its level is remembered and
   * from now on only clearly louder sound (the caller) reaches the VAD. It is not learned as the
   * caller's level.
   */
  suppress(levelDb?: number): void {
    const db = levelDb ?? (this.#utterance.length ? percentile(this.#utterance, 0.85) : null);
    if (db !== null) this.#backgroundDb = Math.max(this.#backgroundDb ?? -Infinity, db);
    this.#utteranceSuppressed = true;
  }

  /**
   * Sound that passed the gate in this utterance after the background decision (ms). Since then the
   * gate passes only sound clearly above the background: that was the caller (do not drop the
   * transcript).
   */
  get heardAfterSuppressMs(): number {
    return this.#afterSuppressMs;
  }

  /** Level of the sound judged as background in this call; `null` if none. */
  get backgroundDb(): number | null {
    return this.#backgroundDb;
  }

  /** Level of the last `RECENT_MS` of the ongoing utterance (85th percentile); `null` if shorter. */
  get recentDb(): number | null {
    return this.#recentMs >= RECENT_MS - 50 ? percentile(this.#recent.map((r) => r.db), 0.85) : null;
  }

  /**
   * The last utterance reached the LLM as the caller's turn (call it when a user message is added).
   * If it started while the agent spoke and was not learned, it is learned now; its level joins the
   * turn levels. Utterances dropped during the greeting or swallowed (echo, backchannel, background)
   * never get here.
   */
  acceptTurn(): void {
    const last = this.#last;
    this.#last = null;
    if (!last) return;
    if (!last.learned) this.#learn(last.db);
    this.#turns.push(last.db);
    if (this.#turns.length > LEVEL_GATE.HISTORY) this.#turns.shift();
  }

  /**
   * Median level of the caller's turns; `null` if none. Unlike `callerDb`, only utterances that
   * reached the LLM count. In a TV call a quiet "İyi günler diliyorum" (−41, most likely the TV)
   * before the greeting had pulled the caller level down; it never reached the LLM, so it is not here.
   */
  get turnDb(): number | null {
    if (!this.#turns.length) return null;
    const sorted = [...this.#turns].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  #learn(level: number): void {
    const caller = this.callerDb;
    if (caller !== null && level < caller - LEVEL_GATE.ACCEPT_WITHIN_DB) return;
    this.#history.push(level);
    if (this.#history.length > LEVEL_GATE.HISTORY) this.#history.shift();
  }

  /**
   * The VAD ended the utterance: returns its level if long enough and, with `learn`, adds it to the
   * caller's history. An utterance that started while the agent spoke may be echo and is not learned
   * (the greeting's echo was once learned as the caller's level and pinned the threshold to the
   * floor); if it reaches the LLM, `acceptTurn` learns it. Background utterances are never learned.
   */
  endUtterance(learn = true): number | null {
    const long = this.#utteranceMs >= LEVEL_GATE.MIN_UTTERANCE_MS;
    const level = long ? percentile(this.#utterance, 0.85) : null;
    this.#last = level !== null && !this.#utteranceSuppressed ? { db: level, learned: learn } : null;
    if (this.#last && learn) this.#learn(level!);
    this.#utterance = [];
    this.#utteranceMs = 0;
    return level;
  }
}
