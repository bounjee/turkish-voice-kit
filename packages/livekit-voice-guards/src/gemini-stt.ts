import WebSocket from "ws";
import { APIConnectionError, stt, type APIConnectOptions } from "@livekit/agents";

/**
 * Gemini Live speech-to-text as a LiveKit Agents (JS) STT. LiveKit JS has no plugin for it, so this
 * talks to the Live API over a WebSocket and asks only for the input transcription.
 *
 * Why Gemini: on our Turkish phone and web test set it beat ElevenLabs Scribe v2 Realtime clearly on
 * the hard parts of a conversation: full names 94% vs 83%, company names 89% vs 64%, e-mail
 * addresses 80% vs 13%; latency p50 0.33 s vs 0.25 s.
 *
 * Turn detection is OURS, not Gemini's: Gemini's automatic activity detection is disabled. When your
 * local VAD says the user started speaking, call `startActivity()` (sends `activityStart`); when it
 * says they stopped, call `flush()` (sends `activityEnd`); the final transcript arrives ~0.35-0.6 s
 * later. Audio OUTSIDE an activity is not sent: the Live API does not drop it, it prepends it to the
 * next sentence (tested). The last `PREROLL_MS` of audio is prepended to each activity so the first
 * syllable is not clipped. Since silence is never sent, the per-minute cost drops too.
 */

export const GEMINI_LIVE_MODEL = "gemini-3.5-transcribe-live";
const URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
/** VAD reports "speech started" after the speech actually started (Silero + processing delay). */
export const PREROLL_MS = 500;
/** Inside an activity audio is sent in chunks of this size (the docs suggest 100 ms). */
const CHUNK_MS = 50;
const SETUP_TIMEOUT_MS = 10_000;

const REGION: Record<string, string> = {
  tr: "tr-TR", en: "en-US", de: "de-DE", fr: "fr-FR", es: "es-ES", ru: "ru-RU", ar: "ar-SA",
  fa: "fa-IR", ur: "ur-PK", zh: "cmn-Hans-CN", hi: "hi-IN", it: "it-IT", nl: "nl-NL",
};

/** Conversation languages → BCP-47. "*" (any language) means automatic detection: an empty list. */
export function geminiLanguageCodes(languages: string[]): string[] {
  if (languages.includes("*")) return [];
  return languages.filter(Boolean).map((l) => REGION[l] ?? l);
}

/** VERBATIM: as spoken (default). SMART: fillers, self-corrections and formatting are cleaned up. */
export type GeminiMode = "VERBATIM" | "SMART";

export function geminiSetup(opts: { model?: string; languageCodes: string[]; keyterms: string[]; mode?: GeminiMode }): unknown {
  return {
    setup: {
      model: `models/${opts.model ?? GEMINI_LIVE_MODEL}`,
      generationConfig: { responseModalities: ["TEXT"] },
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      inputAudioTranscription: {
        languageCodes: opts.languageCodes,
        ...(opts.keyterms.length ? { customVocabulary: opts.keyterms } : {}),
        ...(opts.mode ? { mode: opts.mode } : {}),
      },
    },
  };
}

export type GeminiEvent =
  | { kind: "setup" }
  | { kind: "interim"; text: string }
  | { kind: "final"; text: string }
  | { kind: "complete" }
  | { kind: "error"; message: string };

/**
 * When the user pauses briefly and speaks again, the second activity starts before the first one's
 * transcript arrives, and Gemini joins both into ONE transcript without a space ("Tabii.5532234875",
 * "yazıyordur.Ortalama"; 6 times in 5 calls). A space is inserted when a sentence-end mark after a
 * letter is directly followed by an uppercase letter or a digit; addresses ("site.com"), decimals
 * ("5.000") and lowercase continuations do not change. A join without punctuation ("banaDostum") is
 * NOT split: the rule would split names like "WhatsApp" and "TikTok".
 */
export function spaceJoinedSentences(text: string): string {
  return text.replace(/(\p{L}[.!?…])(?=[\p{Lu}\p{N}])/gu, "$1 ");
}

export function parseGeminiMessage(raw: string): GeminiEvent[] {
  let msg: {
    setupComplete?: unknown;
    error?: { message?: string };
    serverContent?: {
      interimInputTranscription?: { text?: string };
      inputTranscription?: { text?: string };
      generationComplete?: boolean;
    };
  };
  try {
    msg = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: GeminiEvent[] = [];
  if (msg.setupComplete) out.push({ kind: "setup" });
  if (msg.error) out.push({ kind: "error", message: msg.error.message ?? "unknown error" });
  const content = msg.serverContent;
  const interim = content?.interimInputTranscription?.text?.trim();
  if (interim) out.push({ kind: "interim", text: interim });
  const final = content?.inputTranscription?.text?.trim();
  if (final) out.push({ kind: "final", text: spaceJoinedSentences(final) });
  if (content?.generationComplete) out.push({ kind: "complete" });
  return out;
}

/** The last `ms` of audio outside an activity (so the first syllable is not clipped). */
export class PreRoll {
  private frames: Int16Array[] = [];
  private samples = 0;
  private readonly max: number;
  constructor(sampleRate: number, ms: number) {
    this.max = Math.round((sampleRate * ms) / 1000);
  }
  push(frame: Int16Array): void {
    this.frames.push(frame);
    this.samples += frame.length;
    while (this.frames.length > 1 && this.samples - this.frames[0].length >= this.max) {
      this.samples -= this.frames.shift()!.length;
    }
  }
  drain(): Int16Array[] {
    const out = this.frames;
    this.frames = [];
    this.samples = 0;
    return out;
  }
}

export type GeminiSttOptions = {
  apiKey: string;
  /** Conversation languages (`tr`, `en`, or `*` for automatic detection). */
  languages: string[];
  /** Domain vocabulary (`customVocabulary`, up to 1,000 terms). */
  keyterms: string[];
  mode?: GeminiMode;
  sampleRate?: number;
  /** Live API model. Default `GEMINI_LIVE_MODEL`. */
  model?: string;
};

export class GeminiLiveSTT extends stt.STT {
  label = "gemini.LiveSTT";
  readonly opts: Required<GeminiSttOptions>;
  constructor(opts: GeminiSttOptions) {
    super({ streaming: true, interimResults: true });
    this.opts = { sampleRate: 16_000, mode: "VERBATIM", model: GEMINI_LIVE_MODEL, ...opts };
  }
  get model(): string {
    return this.opts.model;
  }
  get provider(): string {
    return "google";
  }
  /**
   * The conversation language changed. The new language applies from the next connection; call
   * `requestReconnect()` on the open stream to reconnect while the user is not speaking.
   */
  setLanguages(languages: string[]): void {
    this.opts.languages = languages;
  }
  protected async _recognize(): Promise<stt.SpeechEvent> {
    throw new Error("Gemini Live works only as a stream");
  }
  stream(options?: { connOptions?: APIConnectOptions }): GeminiLiveStream {
    return new GeminiLiveStream(this, this.opts, options?.connOptions);
  }
}

export class GeminiLiveStream extends stt.SpeechStream {
  label = "gemini.LiveStream";
  #opts: Required<GeminiSttOptions>;
  #ws: WebSocket | null = null;
  #ready = false;
  #active = false;
  #pendingStart = false;
  #preroll: PreRoll;
  #chunk: Int16Array[] = [];
  #chunkSamples = 0;
  #speaking = false;
  #lastInterim = "";
  #reconnect = false;

  constructor(sttInstance: GeminiLiveSTT, opts: Required<GeminiSttOptions>, connOptions?: APIConnectOptions) {
    super(sttInstance, opts.sampleRate, connOptions);
    this.#opts = opts;
    this.#preroll = new PreRoll(opts.sampleRate, PREROLL_MS);
  }

  /** Settings changed: the connection is renewed while the user is not speaking (an activity is never cut). */
  requestReconnect(): void {
    this.#reconnect = true;
  }

  /** Your local VAD said "the user started speaking". Calling it again has no effect. */
  startActivity(): void {
    if (this.#active) return;
    if (!this.#ready) {
      this.#pendingStart = true;
      return;
    }
    this.#active = true;
    this.#send({ realtimeInput: { activityStart: {} } });
    for (const frame of this.#preroll.drain()) this.#queueAudio(frame);
  }

  #endActivity(): void {
    this.#pendingStart = false;
    if (!this.#active) return;
    this.#sendChunk();
    this.#send({ realtimeInput: { activityEnd: {} } });
    this.#active = false;
  }

  #send(message: unknown): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(message));
  }

  #queueAudio(frame: Int16Array): void {
    this.#chunk.push(frame);
    this.#chunkSamples += frame.length;
    if (this.#chunkSamples >= (this.#opts.sampleRate * CHUNK_MS) / 1000) this.#sendChunk();
  }

  #sendChunk(): void {
    if (!this.#chunkSamples) return;
    const pcm = new Int16Array(this.#chunkSamples);
    let offset = 0;
    for (const frame of this.#chunk) {
      pcm.set(frame, offset);
      offset += frame.length;
    }
    this.#chunk = [];
    this.#chunkSamples = 0;
    const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
    this.#send({ realtimeInput: { audio: { data, mimeType: `audio/pcm;rate=${this.#opts.sampleRate}` } } });
  }

  #emit(event: stt.SpeechEvent): void {
    if (this.closed || this.queue.closed) return;
    this.queue.put(event);
  }

  #speech(text: string): stt.SpeechData {
    const language = (geminiLanguageCodes(this.#opts.languages)[0] ?? "tr").slice(0, 2);
    return { language: language as stt.SpeechData["language"], text, startTime: 0, endTime: 0, confidence: 0 };
  }

  #handle(event: GeminiEvent): void {
    if (event.kind === "interim" && event.text !== this.#lastInterim) {
      this.#lastInterim = event.text;
      if (!this.#speaking) {
        this.#speaking = true;
        this.#emit({ type: stt.SpeechEventType.START_OF_SPEECH });
      }
      this.#emit({ type: stt.SpeechEventType.INTERIM_TRANSCRIPT, alternatives: [this.#speech(event.text)] });
    } else if (event.kind === "final") {
      this.#lastInterim = "";
      if (!this.#speaking) {
        this.#speaking = true;
        this.#emit({ type: stt.SpeechEventType.START_OF_SPEECH });
      }
      this.#emit({ type: stt.SpeechEventType.FINAL_TRANSCRIPT, alternatives: [this.#speech(event.text)] });
    } else if (event.kind === "complete" && this.#speaking) {
      this.#speaking = false;
      this.#emit({ type: stt.SpeechEventType.END_OF_SPEECH });
    }
  }

  async #connect(): Promise<WebSocket> {
    const ws = new WebSocket(`${URL}?key=${encodeURIComponent(this.#opts.apiKey)}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new APIConnectionError({ message: "Gemini Live setup timed out" })), SETUP_TIMEOUT_MS);
      ws.once("open", () =>
        ws.send(
          JSON.stringify(
            geminiSetup({
              model: this.#opts.model,
              languageCodes: geminiLanguageCodes(this.#opts.languages),
              keyterms: this.#opts.keyterms,
              mode: this.#opts.mode,
            }),
          ),
        ),
      );
      ws.on("message", (data) => {
        for (const event of parseGeminiMessage(data.toString())) {
          if (event.kind === "setup") {
            clearTimeout(timer);
            resolve();
          } else if (event.kind === "error") {
            clearTimeout(timer);
            reject(new APIConnectionError({ message: `Gemini Live: ${event.message}` }));
          } else {
            this.#handle(event);
          }
        }
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(new APIConnectionError({ message: `Gemini Live connection error: ${err.message}` }));
      });
    });
    return ws;
  }

  protected async run(): Promise<void> {
    // The connection is renewed when the language changes; the input queue is shared across connections.
    while (!this.closed) {
      const ws = await this.#connect();
      this.#ws = ws;
      this.#ready = true;
      this.#active = false;
      this.#reconnect = false;
      let dropped: Error | null = null;
      ws.once("close", (code, reason) => {
        if (!this.closed) dropped = new APIConnectionError({ message: `Gemini Live closed ${code} ${reason.toString()}`.trim() });
      });
      if (this.#pendingStart) {
        this.#pendingStart = false;
        this.startActivity();
      }
      try {
        for (;;) {
          if (this.#reconnect && !this.#active) break;
          const next = await this.input.next();
          if (next.done) return;
          if (dropped) throw dropped;
          const item = next.value;
          if (item === GeminiLiveStream.FLUSH_SENTINEL) {
            this.#endActivity();
            continue;
          }
          const frame = new Int16Array(item.data);
          if (this.#active) this.#queueAudio(frame);
          else this.#preroll.push(frame);
        }
      } finally {
        this.#ready = false;
        this.#active = false;
        ws.close();
        this.#ws = null;
      }
    }
  }
}
