/**
 * Turkish TTS benchmark: every model gets the same sentences (`sentences.json`) in the same way.
 * API models are here; local open models (EMA, Antalia, Anka, Trendyol) are in `generate_local.py`.
 * Output goes to `runs/` (not committed).
 *
 *   npx tsx generate.ts try [model...]                         # one sentence per model → runs/try/<model>.<ext>
 *   npx tsx generate.ts generate [model...]                    # the whole set → runs/audio/<model>/<id>__<text|spoken>.<ext>
 *   npx tsx generate.ts transcribe <whisper|scribe|gemini> [model...]   # transcribe → runs/transcripts/<stt>.jsonl
 *
 * Three transcription models: Whisper large-v3 (via OpenRouter; on a CPU it takes 7-40 s per clip),
 * ElevenLabs Scribe v2 and Gemini 3.5 Transcribe (via OpenRouter).
 *
 * `generate` and `transcribe` resume where they stopped. PAID: `generate` sends ~14,700 characters per
 * model (273 clips), `transcribe` ~20 minutes of audio per model. Keys come from the environment or a
 * `.env` file next to this script. Timings are from this machine to the provider: time to first byte
 * and total time of a non-streaming HTTP request.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const dir = new URL(".", import.meta.url).pathname;
if (existsSync(`${dir}.env`)) process.loadEnvFile(`${dir}.env`);
const key = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

type Clip = { audio: Buffer; ext: string; ttfb: number; total: number };
/** `parallel`: how many requests at once (default 1). */
type Model = { id: string; label: string; voice: string; parallel?: number; speak: (text: string) => Promise<Clip> };

/** Sends the request and reads the body in chunks: time to first byte and total time. */
async function post(url: string, headers: Record<string, string>, body: unknown, ext: string): Promise<Clip> {
  const t0 = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000), // OpenAI keeps some sentences with digits waiting for minutes
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 240)}`);
  const reader = res.body!.getReader();
  const parts: Uint8Array[] = [];
  let first: number | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    first ??= performance.now() - t0;
    parts.push(value);
  }
  return { audio: Buffer.concat(parts), ext, ttfb: Math.round(first ?? 0), total: Math.round(performance.now() - t0) };
}

/** Wraps headerless 16-bit mono PCM in a WAV header (Gemini TTS returns only pcm, 24 kHz). */
function wrapPcm(clip: Clip, rate: number): Clip {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + clip.audio.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(clip.audio.length, 40);
  return { ...clip, audio: Buffer.concat([header, clip.audio]), ext: "wav" };
}

const CARTESIA_API_VERSION = "2026-08-14";
/** Cartesia "Leyla" (Turkish, female, conversational). */
const CARTESIA_VOICE = "fa7bfcdc-603c-4bf1-a600-a371400d2f8c";

const cartesia = (model: string, voice: string) => (text: string) =>
  post(
    "https://api.cartesia.ai/tts/bytes",
    { Authorization: `Bearer ${key("CARTESIA_API_KEY")}`, "Cartesia-Version": CARTESIA_API_VERSION },
    { model_id: model, transcript: text, voice: { mode: "id", id: voice }, language: "tr", output_format: { container: "wav", encoding: "pcm_s16le", sample_rate: 44100 } },
    "wav",
  );

const elevenlabs = (model: string) => (text: string) =>
  post(
    `https://api.elevenlabs.io/v1/text-to-speech/${key("ELEVENLABS_VOICE_ID")}/stream?output_format=mp3_44100_128`,
    { "xi-api-key": key("ELEVENLABS_API_KEY") },
    { text, model_id: model, language_code: "tr" },
    "mp3",
  );

const openai = (model: string, voice: string) => (text: string) =>
  post("https://api.openai.com/v1/audio/speech", { Authorization: `Bearer ${key("OPENAI_API_KEY")}` }, { model, voice, input: text, response_format: "wav" }, "wav");

const openrouter = (model: string, voice: string, format: "mp3" | "pcm") => async (text: string) => {
  const clip = await post(
    "https://openrouter.ai/api/v1/audio/speech",
    { Authorization: `Bearer ${key("OPENROUTER_API_KEY")}`, "X-Title": "turkish-tts-benchmark" },
    { model, input: text, voice, response_format: format },
    format,
  );
  return format === "pcm" ? wrapPcm(clip, 24000) : clip;
};

const alania = (voice: string) => (text: string) =>
  post("https://voice.patientdesk.ai/v1/audio/speech", { Authorization: `Bearer ${key("PATIENTDESK_API_KEY")}` }, { model: "alania-v2", voice, input: text, response_format: "wav" }, "wav");

const freya = (model: string, voice: string) => (text: string) =>
  post("https://tts.freyavoice.ai/v1/audio/speech", { Authorization: `Bearer ${key("FREYA_API_KEY")}` }, { model, voice, input: text, response_format: "wav" }, "wav");

/** The six API models (the four local ones are in `generate_local.py`). Each uses the provider's
 *  Turkish female voice; for ElevenLabs set `ELEVENLABS_VOICE_ID` (we used "Gözde" from the voice
 *  library); for Alania the default voice. */
export const MODELS: Model[] = [
  { id: "cartesia-sonic-3.6", label: "Cartesia Sonic 3.6", voice: "Leyla", speak: cartesia("sonic-3.6-2026-08-27", CARTESIA_VOICE) },
  { id: "elevenlabs-v4", label: "ElevenLabs v4", voice: "Gözde", speak: elevenlabs("eleven_v4") },
  { id: "gemini-3.8-flash-tts", label: "Gemini 3.8 Flash TTS", voice: "Kore", speak: openrouter("google/gemini-3.8-flash-tts", "Kore", "pcm") },
  // OpenAI keeps some requests waiting 35-70 s on the server (`openai-processing-ms`); one at a time, 273 clips take hours.
  { id: "openai-gpt-4o-mini-tts", label: "OpenAI gpt-4o-mini-tts", voice: "coral", parallel: 8, speak: openai("gpt-4o-mini-tts", "coral") },
  { id: "alania-2", label: "Alania-2", voice: "alania2-f1", speak: alania("alania2-f1") },
  { id: "freya-tts-1-hd", label: "Freya tts-1-hd", voice: "leyla", speak: freya("tts-1-hd", "leyla") },
];

const OUT = `${dir}runs`;
const [mode, ...args] = process.argv.slice(2);
const pick = (names: string[]) => MODELS.filter((m) => !names.length || names.includes(m.id));

/** Every sentence as written; if it has a separate spoken form, that too (bypasses the model's own number reading). */
function clips(): { id: string; track: "text" | "spoken"; text: string }[] {
  const items = (JSON.parse(readFileSync(`${dir}sentences.json`, "utf8")) as { items: { id: string; text: string; spoken?: string }[] }).items;
  return [
    ...items.map((i) => ({ id: i.id, track: "text" as const, text: i.text })),
    ...items.filter((i) => i.spoken).map((i) => ({ id: i.id, track: "spoken" as const, text: i.spoken! })),
  ];
}

/** At most `limit` jobs at once. */
async function pool<T>(jobs: T[], limit: number, run: (job: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (next < jobs.length) await run(jobs[next++]); }));
}

if (mode === "try") {
  mkdirSync(`${OUT}/try`, { recursive: true });
  const text = "Başlangıç paketi aylık 1.490 TL, KDV dahil.";
  await Promise.all(
    pick(args).map(async (m) => {
      try {
        const clip = await m.speak(text);
        writeFileSync(`${OUT}/try/${m.id}.${clip.ext}`, clip.audio);
        console.info(`${m.id}: ${clip.audio.length} bytes, first byte ${clip.ttfb} ms, total ${clip.total} ms`);
      } catch (err) {
        console.info(`${m.id}: ERROR ${String(err).slice(0, 260)}`);
      }
    }),
  );
} else if (mode === "generate") {
  // Models side by side, sentences in order within a model (one request at a time per provider, or `parallel`).
  await Promise.all(
    pick(args).map(async (m) => {
      mkdirSync(`${OUT}/audio/${m.id}`, { recursive: true });
      const have = new Set(readdirSync(`${OUT}/audio/${m.id}`).map((f) => f.replace(/\.\w+$/, "")));
      let done = 0;
      await pool(clips().filter((c) => !have.has(`${c.id}__${c.track}`)), m.parallel ?? 1, async (c) => {
        const row: Record<string, unknown> = { model: m.id, id: c.id, track: c.track, chars: c.text.length };
        try {
          const clip = await m.speak(c.text);
          writeFileSync(`${OUT}/audio/${m.id}/${c.id}__${c.track}.${clip.ext}`, clip.audio);
          Object.assign(row, { ttfb: clip.ttfb, total: clip.total, bytes: clip.audio.length });
          done++;
        } catch (err) {
          row.error = String(err).slice(0, 240);
        }
        appendFileSync(`${OUT}/generation.jsonl`, JSON.stringify(row) + "\n");
      });
      console.info(`${m.id}: ${done} new clips, ${readdirSync(`${OUT}/audio/${m.id}`).length} in folder`);
    }),
  );
} else if (mode === "transcribe" && ["whisper", "scribe", "gemini"].includes(args[0])) {
  const stt = args[0];
  // Gemini's direct API allows 10 requests per minute on Tier 1; the same model is called via OpenRouter.
  const viaOpenRouter = async (model: string, wav: Buffer) => {
    const res = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key("OPENROUTER_API_KEY")}`, "Content-Type": "application/json", "X-Title": "turkish-tts-benchmark" },
      body: JSON.stringify({ model, language: "tr", input_audio: { data: wav.toString("base64"), format: "wav" } }),
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => ({}))) as { text?: string; error?: unknown };
    if (!res.ok || typeof json.text !== "string") throw new Error(`${res.status} ${JSON.stringify(json.error ?? json).slice(0, 200)}`);
    return json.text;
  };
  const scribe = async (wav: Buffer) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "clip.wav");
    form.append("model_id", "scribe_v2");
    form.append("language_code", "tur");
    const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key("ELEVENLABS_API_KEY") }, body: form });
    if (!res.ok) throw new Error(`scribe ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return ((await res.json()) as { text?: string }).text ?? "";
  };
  const transcribe = (wav: Buffer) =>
    stt === "scribe" ? scribe(wav) : viaOpenRouter(stt === "whisper" ? "openai/whisper-large-v3" : "google/gemini-3.5-transcribe", wav);
  mkdirSync(`${OUT}/transcripts`, { recursive: true });
  const file = `${OUT}/transcripts/${stt}.jsonl`;
  const seen = new Set(existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return r.error ? "" : `${r.model}|${r.id}|${r.track}`; }) : []);
  const models = args.slice(1).length ? args.slice(1) : readdirSync(`${OUT}/audio`);
  const jobs = models.flatMap((model) => readdirSync(`${OUT}/audio/${model}`).map((f) => ({ model, f })));
  let done = 0;
  await pool(jobs, 4, async ({ model, f }) => {
    const [id, track] = f.replace(/\.\w+$/, "").split("__");
    if (seen.has(`${model}|${id}|${track}`)) return;
    const row: Record<string, unknown> = { model, id, track };
    try {
      const wav = execFileSync("ffmpeg", ["-v", "error", "-i", `${OUT}/audio/${model}/${f}`, "-ac", "1", "-ar", "16000", "-f", "wav", "-"], { maxBuffer: 1 << 27 });
      row.text = (await transcribe(wav)).trim();
      done++;
    } catch (err) {
      row.error = String(err).slice(0, 240);
    }
    appendFileSync(file, JSON.stringify(row) + "\n");
  });
  console.info(`${stt}: ${done} new transcripts`);
  process.exit(0);
} else {
  console.info("usage: npx tsx generate.ts <try|generate> [model...] | transcribe <whisper|scribe|gemini> [model...]");
}
