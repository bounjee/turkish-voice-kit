import { AudioFrame } from "@livekit/rtc-node";

/**
 * Trims the quiet start of TTS audio. Measured on 111 calls (622 agent utterances) with Cartesia
 * Sonic: after the agent switched to "speaking", room-tone audio at −50…−70 dBFS played until the
 * first audible sound (5 ms RMS > −40 dBFS) for p50 130 ms, p90 165 ms; the caller hears it as
 * waiting (an independent measurement on Sonic 3.6 also reports 141 ms). At the start of every
 * utterance (reply, greeting, canned sentence) audio is held until one 5 ms window passes `ONSET_DB`;
 * playback starts `PREROLL_MS` before that window (90% of soft onsets begin at most 25 ms before the
 * threshold), fading in over the first `FADE_IN_MS` (no click). If the threshold is not passed within
 * `MAX_MS`, the held audio plays as is.
 * Threshold from the same data: at −42 the loudest window of the quiet part crosses it in 20 of 622
 * utterances (those are trimmed less; no audio is lost).
 */
export const LEAD_TRIM = {
  ONSET_DB: -42,
  WINDOW_MS: 5,
  PREROLL_MS: 40,
  FADE_IN_MS: 5,
  MAX_MS: 400,
} as const;

/** One per utterance: drops what comes before the first audible sound, passes the rest unchanged. */
export class LeadTrim {
  #held: AudioFrame[] = [];
  #heldSamples = 0;
  #done = false;
  /** Trimmed duration (ms), for logs and measurement. */
  trimmedMs = 0;

  /** Frames to play: none until the threshold is passed, then one trimmed frame, then frames as they come. */
  push(frame: AudioFrame): AudioFrame[] {
    if (this.#done) return [frame];
    const channels = frame.channels || 1;
    const rate = frame.sampleRate;
    const window = Math.max(1, Math.round((rate * LEAD_TRIM.WINDOW_MS) / 1000));
    const onset = firstLoudWindow(frame.data, channels, window, LEAD_TRIM.ONSET_DB);
    this.#held.push(frame);
    if (onset === null) {
      this.#heldSamples += frame.samplesPerChannel;
      if ((this.#heldSamples / rate) * 1000 < LEAD_TRIM.MAX_MS) return [];
      return this.#release();
    }
    const at = this.#heldSamples + onset;
    this.#heldSamples += frame.samplesPerChannel;
    const start = Math.max(0, at - Math.round((rate * LEAD_TRIM.PREROLL_MS) / 1000));
    this.#done = true;
    this.trimmedMs = Math.round((start / rate) * 1000);
    const total = this.#heldSamples;
    const data = new Int16Array((total - start) * channels);
    let offset = 0;
    let skip = start;
    for (const held of this.#held) {
      const n = held.samplesPerChannel;
      if (skip >= n) {
        skip -= n;
        continue;
      }
      const part = held.data.subarray(skip * channels);
      data.set(part, offset);
      offset += part.length;
      skip = 0;
    }
    this.#held = [];
    if (start > 0) fadeIn(data, channels, Math.round((rate * LEAD_TRIM.FADE_IN_MS) / 1000));
    return [new AudioFrame(data, rate, channels, total - start)];
  }

  /** If the utterance ended before the threshold was passed, the held audio plays as is. */
  end(): AudioFrame[] {
    return this.#done ? [] : this.#release();
  }

  #release(): AudioFrame[] {
    this.#done = true;
    const out = this.#held;
    this.#held = [];
    return out;
  }
}

/** Sample (per channel) index of the first window whose RMS exceeds `db`; null if none. */
function firstLoudWindow(data: Int16Array, channels: number, window: number, db: number): number | null {
  const limit = (10 ** (db / 20) * 32768) ** 2;
  const samples = Math.floor(data.length / channels);
  for (let start = 0; start < samples; start += window) {
    const end = Math.min(samples, start + window);
    let sum = 0;
    for (let i = start * channels; i < end * channels; i++) sum += data[i] * data[i];
    if (sum / ((end - start) * channels) > limit) return start;
  }
  return null;
}

function fadeIn(data: Int16Array, channels: number, samples: number): void {
  for (let i = 0; i < samples && i * channels < data.length; i++) {
    const gain = (i + 1) / (samples + 1);
    for (let c = 0; c < channels; c++) data[i * channels + c] = Math.round(data[i * channels + c] * gain);
  }
}
