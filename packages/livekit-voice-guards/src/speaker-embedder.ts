import { existsSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

/**
 * Per-utterance voiceprint for the participant filter (speaker-filter.ts), computed with sherpa-onnx
 * in a worker thread. Install the optional dependency `sherpa-onnx-node` and download the models from
 * the sherpa-onnx release page (tag `speaker-recongition-models`) into one folder. The fusion of
 * ERes2NetV2 + TitaNet small was the best in our eval. Without models, or if the worker dies, `embed`
 * returns `null`: the filter lets the speech pass.
 */
export const SPEAKER_MODELS = ["3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx", "nemo_en_titanet_small.onnx"];

/** Model paths in `dir`; `null` if any is missing. */
export function speakerModelPaths(dir: string): string[] | null {
  const paths = SPEAKER_MODELS.map((m) => path.join(dir, m));
  return paths.every((p) => existsSync(p)) ? paths : null;
}

type Embedding = { vec: Float32Array; ms: number };
type Pending = { resolve: (v: Embedding | null) => void; timer: ReturnType<typeof setTimeout> };

export class SpeakerEmbedder {
  #worker: Worker | null = null;
  #ready = false;
  #broken = false;
  #closing = false;
  #next = 1;
  readonly #pending = new Map<number, Pending>();

  constructor(
    private readonly models: string[],
    /** Replaces the slow worker in tests. */
    private readonly script: URL = new URL("./speaker-worker.mjs", import.meta.url),
  ) {}

  /** Starts the worker and loads the models (at call start, in the background). */
  start(): void {
    if (this.#worker || this.#broken) return;
    try {
      const startedAt = Date.now();
      const worker = new Worker(this.script, { workerData: { models: this.models } });
      worker.on("message", (msg: { ready?: boolean; id?: number; vec?: Float32Array; ms?: number; error?: string }) => {
        if (msg.ready) {
          this.#ready = true;
          console.info(`[speaker] voiceprint models ready: ${Date.now() - startedAt} ms (load + warm-up)`);
          return;
        }
        const p = msg.id !== undefined ? this.#pending.get(msg.id) : undefined;
        if (!p) return;
        this.#pending.delete(msg.id!);
        clearTimeout(p.timer);
        if (msg.error) console.warn(`[speaker] voiceprint error: ${msg.error}`);
        p.resolve(msg.vec ? { vec: msg.vec, ms: msg.ms ?? 0 } : null);
      });
      const fail = (why: string) => {
        if (this.#broken || this.#closing) return;
        console.warn(`[speaker] voiceprint worker stopped (${why}): participant filter off for this call`);
        this.#broken = true;
        this.#ready = false;
        for (const p of this.#pending.values()) {
          clearTimeout(p.timer);
          p.resolve(null);
        }
        this.#pending.clear();
      };
      worker.on("error", (err) => fail(err.message));
      worker.on("exit", (code) => code !== 0 && fail(`exit ${code}`));
      worker.unref();
      this.#worker = worker;
    } catch (err) {
      this.#broken = true;
      console.warn("[speaker] could not start the voiceprint worker:", err instanceof Error ? err.message : err);
    }
  }

  /** Models are still loading (warm-up included): `embed` returns `null` now but will be ready soon. */
  get loading(): boolean {
    return this.#worker !== null && !this.#ready && !this.#broken;
  }

  /**
   * 16 kHz utterance → unit vector; `null` if not ready, on error or after `timeoutMs`.
   * The limit is generous: the final transcript waits for the voiceprint at most `SPEAKER.WAIT_MS`
   * anyway; this limit only decides whether the utterance enters the profile. At 2 s the first
   * utterance was dropped under CPU load at call start (12 of 26 calls), and the caller's later
   * interruptions were swallowed as "another voice" because they had no profile.
   */
  embed(samples: Float32Array, timeoutMs = 10_000): Promise<Embedding | null> {
    if (!this.#worker || !this.#ready || this.#broken) return Promise.resolve(null);
    const id = this.#next++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.#pending.set(id, { resolve, timer });
      this.#worker!.postMessage({ id, samples }, [samples.buffer as ArrayBuffer]);
    });
  }

  close(): void {
    this.#closing = true;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.#pending.clear();
    this.#worker?.terminate().catch(() => {});
    this.#worker = null;
  }
}
