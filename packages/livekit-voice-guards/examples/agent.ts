/**
 * Minimal LiveKit Agents worker that wires the main guards together:
 * level gate in front of Silero VAD, Gemini Live STT driven by that VAD, echo and background-fragment
 * filters on final transcripts, Turkish TTS normalization (tr-speech), TTS lead trim and a bounded
 * end-of-turn prediction.
 *
 *   GOOGLE_GENERATIVE_AI_API_KEY=… CARTESIA_API_KEY=… LIVEKIT_URL=… LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… \
 *     npx tsx examples/agent.ts dev
 *
 * The LLM is LiveKit Inference here; replace it with any LiveKit LLM plugin. The background hold and
 * the participant filter are left out to keep the example short; see the package README.
 */
import { ReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { type JobContext, type JobProcess, ServerOptions, cli, defineAgent, inference, llm, stt, tts, voice } from "@livekit/agents";
import * as cartesia from "@livekit/agents-plugin-cartesia";
import * as livekit from "@livekit/agents-plugin-livekit";
import * as silero from "@livekit/agents-plugin-silero";
import type { AudioFrame } from "@livekit/rtc-node";
import { toSpoken } from "tr-speech";
import {
  EOT_TIMEOUT_MS,
  GatedVAD,
  GeminiLiveSTT,
  type GeminiLiveStream,
  LeadTrim,
  LevelGate,
  SpokenLog,
  boundPrediction,
  isEchoOf,
  isQuietFragment,
  turnThreshold,
} from "livekit-voice-guards";

/** Wait this long after the VAD says "stopped" before asking Gemini for the final transcript. */
const COMMIT_DELAY_MS = 50;

/** Turkish end-of-turn threshold and a time limit on the turn model's prediction (turn-timeout.ts). */
class BoundedTurnDetector extends livekit.turnDetector.MultilingualModel {
  override async unlikelyThreshold(language?: string): Promise<number | undefined> {
    return turnThreshold(language, await super.unlikelyThreshold(language));
  }
  override predictEndOfTurn(chatCtx: llm.ChatContext, timeoutMs?: number): Promise<number> {
    return boundPrediction(super.predictEndOfTurn(chatCtx, timeoutMs), EOT_TIMEOUT_MS, (ms) =>
      console.warn(`late end-of-turn prediction: ${ms} ms (limit ${EOT_TIMEOUT_MS} ms)`),
    );
  }
}

/**
 * LLM output arrives in pieces ("1.250 " + "TL"); numbers are read only on whole sentences. A sentence
 * ends at . ! ? … followed by whitespace and an uppercase letter, so "3. kat" stays together.
 */
async function* sentences(text: ReadableStream<string> | AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = "";
  for await (const piece of text) {
    buffer += piece;
    let match: RegExpExecArray | null;
    while ((match = /[.!?…]\s+(?=[\p{Lu}"'(])/u.exec(buffer))) {
      const end = match.index + match[0].length;
      yield buffer.slice(0, end);
      buffer = buffer.slice(end);
    }
  }
  if (buffer.trim()) yield buffer;
}

class GuardedAgent extends voice.Agent {
  readonly spokenLog = new SpokenLog();
  sttStream: GeminiLiveStream | null = null;
  /** The last utterance started while the agent was speaking. */
  overAgent = false;
  lastUtterance: { levelDb: number | null; callerDb: number | null } | null = null;
  lastHeardAssistant = "";

  constructor(
    private readonly recognizer: GeminiLiveSTT,
    private readonly speech: cartesia.TTS,
  ) {
    super({ instructions: "Sen kısa ve net konuşan, yardımsever bir Türkçe sesli asistansın." });
  }

  override async sttNode(audio: ReadableStream<AudioFrame> | AsyncIterable<AudioFrame>): Promise<ReadableStream<stt.SpeechEvent>> {
    const input = audio instanceof ReadableStream ? audio : ReadableStream.from(audio);
    const stream = this.recognizer.stream();
    this.sttStream = stream;
    stream.updateInputStream(input);
    const agent = this;
    const close = () => {
      if (agent.sttStream === stream) agent.sttStream = null;
      stream.detachInputStream();
      stream.close();
    };
    return new ReadableStream<stt.SpeechEvent>({
      async start(controller) {
        try {
          for await (const event of stream) {
            if (event.type === stt.SpeechEventType.FINAL_TRANSCRIPT) {
              const heard = event.alternatives?.[0]?.text ?? "";
              const utterance = agent.lastUtterance;
              const echo = agent.overAgent && isEchoOf(heard, agent.spokenLog.recent());
              const fragment =
                utterance !== null &&
                isQuietFragment({ text: heard, ...utterance, lastAssistant: agent.lastHeardAssistant, overAgent: agent.overAgent });
              // Swallowed: never reaches the LLM. With `resumeFalseInterruption` the agent continues.
              if (echo || fragment) continue;
            }
            controller.enqueue(event);
          }
          controller.close();
        } finally {
          close();
        }
      },
      cancel: close,
    });
  }

  override async ttsNode(text: ReadableStream<string> | AsyncIterable<string>): Promise<ReadableStream<AudioFrame>> {
    const stream = this.speech.stream();
    const feed = async () => {
      for await (const sentence of sentences(text)) {
        // The raw text is logged too: an echo may resemble the spelling, not the reading.
        this.spokenLog.add(sentence);
        const spoken = toSpoken(sentence);
        this.spokenLog.add(spoken);
        stream.pushText(spoken);
        stream.flush();
      }
      stream.endInput();
    };
    feed().catch(() => stream.endInput());
    return new ReadableStream<AudioFrame>({
      async start(controller) {
        const trim = new LeadTrim();
        try {
          for await (const chunk of stream) {
            if (chunk === tts.SynthesizeStream.END_OF_STREAM) break;
            for (const frame of trim.push(chunk.frame)) controller.enqueue(frame);
          }
          for (const frame of trim.end()) controller.enqueue(frame);
          controller.close();
        } finally {
          stream.close();
        }
      },
      cancel() {
        stream.close();
      },
    });
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load({ activationThreshold: 0.6, minSpeechDuration: 100, minSilenceDuration: 250 });
  },
  entry: async (ctx: JobContext) => {
    const gate = new LevelGate();
    const vad = new GatedVAD(ctx.proc.userData.vad as silero.VAD, gate, (ms, peakDb, thresholdDb) =>
      console.info(`level gate: ${ms} ms of quiet sound dropped (peak ${peakDb.toFixed(1)} dBFS, threshold ${thresholdDb.toFixed(1)})`),
    );
    const recognizer = new GeminiLiveSTT({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY!, languages: ["tr"], keyterms: [] });
    const speech = new cartesia.TTS({ model: "sonic-3", language: "tr", sampleRate: 24_000 });
    const agent = new GuardedAgent(recognizer, speech);

    const session = new voice.AgentSession({
      vad,
      stt: recognizer,
      llm: new inference.LLM({ model: "openai/gpt-4.1-mini" }),
      tts: speech,
      // Transcripts come from the LLM text, not from TTS word timings (our ttsNode does not carry them).
      useTtsAlignedTranscript: false,
      turnHandling: {
        turnDetection: new BoundedTurnDetector(),
        endpointing: { minDelay: 300, maxDelay: 2_000 },
        interruption: { minWords: 1, minDuration: 400, resumeFalseInterruption: true },
      },
    });

    let commitTimer: ReturnType<typeof setTimeout> | null = null;
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      gate.agentSpeaking = ev.newState === "speaking";
    });
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === "speaking") {
        if (commitTimer) clearTimeout(commitTimer);
        agent.overAgent = session.agentState === "speaking";
        gate.startUtterance();
        // Gemini receives audio only inside an activity opened by our (gated) VAD.
        agent.sttStream?.startActivity();
      } else if (ev.oldState === "speaking") {
        // Speech that started over the agent may be echo: it is learned only if it becomes a turn.
        const callerDb = gate.callerDb;
        agent.lastUtterance = { levelDb: gate.endUtterance(!agent.overAgent), callerDb };
        commitTimer = setTimeout(() => agent.sttStream?.flush(), COMMIT_DELAY_MS);
      }
    });
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      if (ev.item.type !== "message") return;
      if (ev.item.role === "user") gate.acceptTurn();
      if (ev.item.role === "assistant") agent.lastHeardAssistant = ev.item.textContent ?? "";
    });

    await session.start({ agent, room: ctx.room, inputOptions: { audioSampleRate: 16_000 } });
    session.say("Merhaba, size nasıl yardımcı olabilirim?");
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
