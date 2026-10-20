import { TransformStream, type ReadableStream } from "node:stream/web";
import { VAD, type VADStream } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import type { LevelGate } from "./level-gate.ts";

/**
 * Puts any LiveKit VAD (e.g. Silero) behind the level gate (see level-gate.ts). The session feeds
 * the VAD stream with `updateInputStream`; that audio goes through the gate, and a gated frame is
 * replaced with silence of the same length (the VAD's timeline does not shift). The STT's audio comes
 * from a separate stream and is not touched. `onFrame` sees the raw audio (before the gate), e.g. for
 * the speaker filter's voiceprint (speaker-filter.ts).
 */
export class GatedVAD extends VAD {
  label: string;
  readonly #inner: VAD;
  readonly #gate: LevelGate;
  readonly #onBlocked: (ms: number, peakDb: number, thresholdDb: number) => void;
  readonly #onFrame?: (frame: AudioFrame) => void;

  constructor(
    inner: VAD,
    gate: LevelGate,
    onBlocked: (ms: number, peakDb: number, thresholdDb: number) => void = () => {},
    onFrame?: (frame: AudioFrame) => void,
  ) {
    super(inner.capabilities);
    this.label = `${inner.label}+level-gate`;
    this.#inner = inner;
    this.#gate = gate;
    this.#onBlocked = onBlocked;
    this.#onFrame = onFrame;
  }

  override get minSilenceDuration(): number | null {
    return this.#inner.minSilenceDuration;
  }

  stream(): VADStream {
    const stream = this.#inner.stream();
    const update = stream.updateInputStream.bind(stream);
    stream.updateInputStream = (audio: ReadableStream<AudioFrame>) =>
      update(
        audio.pipeThrough(
          new TransformStream<AudioFrame, AudioFrame>({
            transform: (frame, controller) => {
              this.#onFrame?.(frame);
              const open = this.#gate.push(frame.data, frame.sampleRate, this.#onBlocked);
              controller.enqueue(
                open
                  ? frame
                  : new AudioFrame(new Int16Array(frame.data.length), frame.sampleRate, frame.channels, frame.samplesPerChannel),
              );
            },
          }),
        ),
      );
    return stream;
  }
}
