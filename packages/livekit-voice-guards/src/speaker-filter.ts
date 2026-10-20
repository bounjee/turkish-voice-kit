/**
 * Participant filter: drop speech from voices that are not taking part in the conversation.
 *
 * A child or a TV speaking as loud as the caller gets through the level gate (level-gate.ts). Every
 * utterance gets a voiceprint (speaker-embedder.ts) and voiceprints are clustered into voices within
 * the call. The first voice of the call (while the agent is silent) and a voice that starts speaking
 * within `WINDOW_MS` after the agent FINISHES a sentence are PARTICIPANTS (they answer the agent);
 * speech from a non-participant does not reach the LLM and cannot interrupt the agent. For a voice
 * rejected twice the window is `STRICT_WINDOW_MS`. No window opens after an interrupted sentence, and
 * the first voice heard during the greeting is not a participant by default (in a live test the
 * caller interrupted the agent and the TV and a quiet voice during the greeting became participants;
 * ~90% of calls have a single speaker). Eval: caller speech lost 1% → 2%, other voices dropped
 * 56-70% → 64-80%.
 *
 * A "the first speaker is the caller" single-profile rule was REJECTED: in one call a woman gave her
 * name and a man gave the number; a single profile would have dropped the man's number and his
 * confirmation, and the request could not be taken.
 * Measurement on 101 recorded calls: caller speech lost 1%, other voices dropped 56-66% (70% while
 * the agent speaks).
 *
 * Whenever it is unsure, speech PASSES: no model, the voiceprint was late, the utterance was too
 * short; speech without a voiceprint does not change the state (LiveKit's MultiSpeakerAdapter reset
 * its state on a single unclear segment and made the background voice the primary speaker,
 * livekit/agents#6460).
 */

export const SPEAKER = {
  /** Cosine similarity to a voice's mean at or above this means the same voice. */
  SAME: 0.3,
  /** A voice that starts within this long after the agent stops counts as answering the agent. */
  WINDOW_MS: 3_500,
  /** ...but for a voice rejected `STRICT_AFTER` times the window is this long (a child may speak right then). */
  STRICT_WINDOW_MS: 1_500,
  STRICT_AFTER: 2,
  /**
   * Against lock-in: if the same voice is rejected this many times in a row while the agent listens,
   * with no accepted speech in between, it becomes a participant with its next utterance (Retell: the
   * filter "locks onto the first voice it hears"; the call must not die if someone else picks up the
   * phone first). No effect in the eval; a safety net.
   */
  RECOVER_AFTER: 3,
  /**
   * The first participant to speak after the agent's reply closes the window: a new voice speaking
   * after them is not an "answer" (in a web test the caller said their name, then the TV said
   * "güzel görünüyor" and became a participant). A new voice at least this similar to the voice that
   * closed the window is the same person and gets in (the caller's voice may fall into a separate
   * cluster on their second utterance). Eval: loss 2% → 3%, child dropped 70% → 92%.
   */
  LOOSE_SAME: 0.15,
  /** Shortest utterance for a voiceprint; shorter ones always pass. */
  MIN_MS: 300,
  /**
   * The voiceprint is taken from at most the last this-many ms of an utterance, and an utterance
   * enters a voice's mean with at most this weight (in a live test a 7.6 s utterance mixed with TV
   * took 1.4 s to embed and the final transcript waited 250 ms; its weight also pulled the caller's
   * voice towards the TV). No change in caller loss in the eval.
   */
  MAX_MS: 3_000,
  /** Pre-roll for the voiceprint (the VAD reports "speaking" after the speech started). */
  PREROLL_MS: 300,
  /** When the final transcript arrives, wait at most this long for the voiceprint; otherwise the speech passes. */
  WAIT_MS: 250,
} as const;

type Voice = {
  id: number;
  sum: Float32Array | null;
  participant: boolean;
  rejections: number;
  /** Also heard while the agent was silent: a real profile. A voice heard only over the agent has a weak print. */
  alone: boolean;
};

export type SpeakerVerdict = {
  accept: boolean;
  /** Voice number within the call (from 1); 0 without a vector. */
  voice: number;
  /** Similarity to the closest voice; `null` for a new voice or without a vector. */
  sim: number | null;
  participant: boolean;
  /** Became a participant with this utterance (answered the agent). */
  admitted: boolean;
};

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function unit(v: Float32Array): Float32Array {
  const n = Math.sqrt(dot(v, v)) || 1;
  return v.map((x) => x / n);
}

export class ParticipantTracker {
  readonly voices: Voice[] = [];
  /** Voice rejected in a row while the agent listened, and the count; any accepted speech resets it. */
  #streak: { voice: Voice | null; count: number } = { voice: null, count: 0 };
  /** The participant that closed the answer window, and when that window opened (when the agent finished). */
  #window: { at: number; by: Voice } | null = null;

  decide(input: {
    /** Unit voiceprint of the utterance; `null` if none (the speech passes). */
    vec: Float32Array | null;
    /** When the VAD reported "speaking". */
    startedAt: number;
    /** The utterance started while the agent was speaking. */
    overAgent: boolean;
    /** When the agent last finished a sentence without being interrupted; `null` if never. */
    lastAgentStopAt: number | null;
    durationMs: number;
  }): SpeakerVerdict {
    const { vec, startedAt, overAgent, lastAgentStopAt, durationMs } = input;
    if (!vec) return { accept: true, voice: 0, sim: null, participant: true, admitted: false };
    let best: Voice | null = null;
    let bestSim = -1;
    for (const v of this.voices) {
      if (!v.sum) continue;
      const sim = dot(vec, unit(v.sum));
      if (sim > bestSim) [best, bestSim] = [v, sim];
    }
    /* An interruption that falls into a cluster heard only while the agent spoke, and is also at least
       `SAME` similar to a participant, belongs to the participant (in a live test the caller could not
       interrupt the agent). Such a cluster is the print of a single interruption; voices spoken over
       the agent resemble each other regardless of who speaks (echo residue, raised voice): across two
       calls interruptions were ~0.4 similar to each other and ~0.3 to the caller's own voice. Eval:
       other-voice dropping unchanged (child 95% → 95%, FLEURS over the agent 81% → 80%), caller loss
       unchanged. */
    if (overAgent && best && bestSim >= SPEAKER.SAME && !best.participant && !best.alone) {
      let own: Voice | null = null;
      let ownSim: number = SPEAKER.SAME;
      for (const v of this.voices) {
        if (!v.participant || !v.alone || !v.sum) continue;
        const sim = dot(vec, unit(v.sum));
        if (sim >= ownSim) [own, ownSim] = [v, sim];
      }
      if (own) [best, bestSim] = [own, ownSim];
    }
    const isNew = !best || bestSim < SPEAKER.SAME;
    const voice: Voice = isNew
      ? { id: this.voices.length + 1, sum: null, participant: this.voices.length === 0 && !overAgent, rejections: 0, alone: false }
      : best!;
    if (isNew) this.voices.push(voice);
    let admitted = false;
    if (!voice.participant && !overAgent && lastAgentStopAt !== null && startedAt >= lastAgentStopAt) {
      const window = voice.rejections >= SPEAKER.STRICT_AFTER ? SPEAKER.STRICT_WINDOW_MS : SPEAKER.WINDOW_MS;
      const taken = this.#window?.at === lastAgentStopAt ? this.#window.by : null;
      const sameAsTaker = taken?.sum ? dot(vec, unit(taken.sum)) >= SPEAKER.LOOSE_SAME : false;
      if (startedAt - lastAgentStopAt <= window && (!taken || sameAsTaker)) voice.participant = admitted = true;
    }
    if (!voice.participant && !overAgent && this.#streak.voice === voice && this.#streak.count >= SPEAKER.RECOVER_AFTER) {
      voice.participant = admitted = true;
    }
    const accept = voice.participant;
    if (accept && !overAgent && lastAgentStopAt !== null && startedAt >= lastAgentStopAt && this.#window?.at !== lastAgentStopAt) {
      this.#window = { at: lastAgentStopAt, by: voice };
    }
    if (accept) this.#streak = { voice: null, count: 0 };
    else {
      voice.rejections += 1;
      if (!overAgent) this.#streak = { voice, count: this.#streak.voice === voice ? this.#streak.count + 1 : 1 };
    }
    // Speech that started while the agent spoke may be echo: it is not added to the voice's profile, it only leaves a trace.
    if (!overAgent) {
      const w = Math.min(durationMs, SPEAKER.MAX_MS) / 1000;
      voice.sum = voice.sum ? voice.sum.map((x, i) => x + vec[i] * w) : vec.map((x) => x * w);
      voice.alone = true;
    } else if (!voice.sum) {
      voice.sum = vec.map((x) => x * 0.01);
    }
    return { accept, voice: voice.id, sim: isNew ? null : bestSim, participant: voice.participant, admitted };
  }
}

/** Collects the raw audio going to the VAD (before the gate) during an utterance; 16 kHz only. */
export class SpeakerTap {
  #ring: Float32Array[] = [];
  #ringSamples = 0;
  #capture: Float32Array[] | null = null;
  #ok = true;

  constructor(private readonly prerollMs: number = SPEAKER.PREROLL_MS) {}

  push(samples: Int16Array, sampleRate: number): void {
    if (sampleRate !== 16_000) {
      this.#ok = false;
      return;
    }
    const f = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) f[i] = samples[i] / 32768;
    if (this.#capture) {
      this.#capture.push(f);
      return;
    }
    this.#ring.push(f);
    this.#ringSamples += f.length;
    const keep = (this.prerollMs / 1000) * 16_000;
    while (this.#ring.length > 1 && this.#ringSamples - this.#ring[0].length >= keep) this.#ringSamples -= this.#ring.shift()!.length;
  }

  start(): void {
    const keep = Math.round((this.prerollMs / 1000) * 16_000);
    const pre = concat(this.#ring);
    this.#capture = [pre.subarray(Math.max(0, pre.length - keep))];
    this.#ring = [];
    this.#ringSamples = 0;
    this.#ok = true;
  }

  /** The utterance's audio (16 kHz, [-1, 1], at most the last `SPEAKER.MAX_MS`); `null` if not started or the sample rate differs. */
  stop(): Float32Array | null {
    const parts = this.#capture;
    this.#capture = null;
    if (!parts || !this.#ok) return null;
    const all = concat(parts);
    const max = (SPEAKER.MAX_MS / 1000) * 16_000;
    return all.length > max ? all.slice(all.length - max) : all;
  }
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
