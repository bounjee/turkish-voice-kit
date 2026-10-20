# livekit-voice-guards

Fixes for [LiveKit Agents](https://github.com/livekit/agents-js) (JS, tested with 1.9.0) voice pipelines, taken from a production voice agent that answers web and phone calls in Turkish. Each module is small and has a single job. The comments in each file record the call that caused the fix and what was measured afterwards.

```bash
npm install livekit-voice-guards @livekit/agents @livekit/rtc-node
npm install sherpa-onnx-node   # only for the participant filter
```

A worker that wires the main modules together is in [`examples/agent.ts`](examples/agent.ts). It is typechecked in CI; running it needs your own LiveKit server and API keys.

| Module | Problem | Fix |
|---|---|---|
| [`gemini-stt.ts`](src/gemini-stt.ts) | LiveKit JS has no Gemini Live STT plugin. | `GeminiLiveSTT`, a streaming STT on the Live API. Turn boundaries come from your VAD; audio outside speech is never sent. |
| [`level-gate.ts`](src/level-gate.ts), [`gated-vad.ts`](src/gated-vad.ts) | Silero VAD ignores loudness, so whispers, distant speech and echo residue open turns. | A gate in front of the VAD that learns the caller's own level (Pipecat floor + Vapi offset). |
| [`background-hold.ts`](src/background-hold.ts) | LiveKit holds a ready reply for as long as the user "speaks", so a TV kept a reply waiting for 16 s. | Ongoing sound clearly quieter than the caller is judged as background after 1.5 s. |
| [`echo-guard.ts`](src/echo-guard.ts) | The agent's own voice comes back through the mic (iOS in-app browsers) and gets answered. Single quiet words open turns. | Drop transcripts that repeat recently spoken TTS text. Drop short, quiet fragments when no question is pending. |
| [`speaker-filter.ts`](src/speaker-filter.ts), [`speaker-embedder.ts`](src/speaker-embedder.ts) | A child or a TV as loud as the caller gets through the level gate. | Cluster voiceprints within the call. Only voices that answer the agent become participants. |
| [`lead-trim.ts`](src/lead-trim.ts) | TTS audio starts with 130 ms (p50) of near-silence, which the caller hears as waiting. | Trim up to the first audible 5 ms window, keeping a 40 ms pre-roll and a fade-in. |
| [`turn-timeout.ts`](src/turn-timeout.ts) | The text turn detector's prediction has no time limit; one took 11.7 s and the caller hung up. Its Turkish threshold also cuts people off. | `boundPrediction` (1.5 s limit), `warmPrediction`, a measured Turkish threshold and a punctuation fallback. |
| [`inference-health.ts`](src/inference-health.ts) | When the turn model's inference process dies, LiveKit does not restart it, and every turn then waits for the limit ([livekit/agents-js#2764](https://github.com/livekit/agents-js/issues/2764)). | Detect it from the worker's health endpoint and restart the worker when no call is running. |

## Measured effects (production calls)

- **Gemini Live STT vs ElevenLabs Scribe v2 Realtime** on Turkish calls: full names 94% vs 83%, company names 89% vs 64%, e-mail addresses 80% vs 13%. Latency p50 was 0.33 s vs 0.25 s.
- **Level gate**: replaying three test calls with a person talking behind the caller, 59-100% of the caller's utterances pass and 0% of the background person's.
- **Background hold**: on 7 real calls with background sound, false turns fell from 32 to 17. Lost caller speech did not change.
- **Echo guard**: across 118 final transcripts in 22 recorded calls, it catches only the real echo. The fragment rule drops 3 of 46 short turns and no answer to a question.
- **Participant filter**: in our eval on 101 recorded calls, it lost 1-3% of the caller's speech and dropped most other voices (56-92%, depending on the voice and the rule version; see the comments in the file).
- **Lead trim**: across 622 agent utterances, the quiet start was p50 130 ms. After trimming, the caller hears the first sound ~85 ms earlier.

## Wiring

These modules plug into an `AgentSession` and a custom `voice.Agent`:

```ts
const gate = new LevelGate();
const vad = new GatedVAD(sileroVad, gate);                       // the session's VAD
const recognizer = new GeminiLiveSTT({ apiKey, languages: ["tr"], keyterms: [] });

session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
  gate.agentSpeaking = ev.newState === "speaking";
});
session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
  if (ev.newState === "speaking") {
    gate.startUtterance();
    agent.sttStream?.startActivity();                              // Gemini only hears speech
  } else if (ev.oldState === "speaking") {
    agent.lastUtterance = { levelDb: gate.endUtterance(!overAgent), callerDb: gate.callerDb };
    setTimeout(() => agent.sttStream?.flush(), 50);                // ask for the final transcript
  }
});
session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
  if (ev.item.type === "message" && ev.item.role === "user") gate.acceptTurn();
});
```

In the agent, override `sttNode` to keep the `GeminiLiveStream` and drop final transcripts with `isEchoOf` and `isQuietFragment`. Override `ttsNode` to log spoken text in a `SpokenLog` and pass audio frames through `LeadTrim`. See [`examples/agent.ts`](examples/agent.ts).

The two modules left out of the example:

- **Background hold.** While the user is speaking and a reply is waiting (or the agent was paused), check `holdVerdict({ activityMs, levelDb: gate.utteranceDb, turnDb: gate.turnDb })` every ~250 ms. On `"background"`, call `gate.suppress()` and drop that utterance's final transcript, unless `gate.heardAfterSuppressMs` is at least ~300 ms (the caller spoke over the background).
- **Participant filter.** Pass a `SpeakerTap` to `GatedVAD`'s `onFrame`. Call `tap.start()` and `tap.stop()` with the user state. Embed the utterance with `SpeakerEmbedder`, which needs the optional `sherpa-onnx-node` dependency and the models listed in `SPEAKER_MODELS`. Call `ParticipantTracker.decide(...)` and drop the final transcript when `accept` is false. Wait at most `SPEAKER.WAIT_MS` for the voiceprint, and let the speech pass when unsure.

## Notes

- **Turkish defaults.** The default Turkish turn threshold, the number words ignored by the echo guard and the example's prompt are Turkish. Everything else is language independent.
- **Thresholds are measurements, not guesses.** Each constant's comment says where it came from. Re-measure on your own calls before you change them.
- **Dependencies.** Peer dependencies are `@livekit/agents` ^1.9 and `@livekit/rtc-node`. `sherpa-onnx-node` is needed only for the participant filter.

## License

MIT
