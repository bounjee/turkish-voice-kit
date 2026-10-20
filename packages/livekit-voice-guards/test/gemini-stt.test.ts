import assert from "node:assert/strict";
import { test } from "node:test";
import { geminiLanguageCodes, geminiSetup, parseGeminiMessage, PreRoll } from "../src/gemini-stt.ts";

test("language codes become BCP-47; '*' is automatic detection (empty list)", () => {
  assert.deepEqual(geminiLanguageCodes(["tr"]), ["tr-TR"]);
  assert.deepEqual(geminiLanguageCodes(["tr", "en"]), ["tr-TR", "en-US"]);
  assert.deepEqual(geminiLanguageCodes(["tr", "*"]), []);
  assert.deepEqual(geminiLanguageCodes(["xx"]), ["xx"]);
});

test("setup: manual activity (our VAD), Turkish, domain vocabulary", () => {
  const setup = geminiSetup({ languageCodes: ["tr-TR"], keyterms: ["Kapadokya", "iyzico"] }) as {
    setup: { model: string; realtimeInputConfig: unknown; inputAudioTranscription: Record<string, unknown> };
  };
  assert.equal(setup.setup.model, "models/gemini-3.5-transcribe-live");
  assert.deepEqual(setup.setup.realtimeInputConfig, { automaticActivityDetection: { disabled: true } });
  assert.deepEqual(setup.setup.inputAudioTranscription, { languageCodes: ["tr-TR"], customVocabulary: ["Kapadokya", "iyzico"] });
  const bare = geminiSetup({ languageCodes: [], keyterms: [] }) as { setup: { inputAudioTranscription: Record<string, unknown> } };
  assert.deepEqual(bare.setup.inputAudioTranscription, { languageCodes: [] });
  const custom = geminiSetup({ model: "another-live-model", languageCodes: [], keyterms: [] }) as { setup: { model: string } };
  assert.equal(custom.setup.model, "models/another-live-model");
});

test("server messages: setup, interim, final, complete, error", () => {
  assert.deepEqual(parseGeminiMessage('{"setupComplete":{}}'), [{ kind: "setup" }]);
  assert.deepEqual(parseGeminiMessage('{"serverContent":{"interimInputTranscription":{"text":"Adım"}}}'), [{ kind: "interim", text: "Adım" }]);
  assert.deepEqual(parseGeminiMessage('{"serverContent":{"inputTranscription":{"text":"Adım Cahit."}}}'), [{ kind: "final", text: "Adım Cahit." }]);
  assert.deepEqual(parseGeminiMessage('{"serverContent":{"generationComplete":true}}'), [{ kind: "complete" }]);
  assert.deepEqual(parseGeminiMessage('{"serverContent":{},"voiceActivity":{"type":"ACTIVITY_END"}}'), []);
  assert.deepEqual(parseGeminiMessage('{"error":{"message":"quota"}}'), [{ kind: "error", message: "quota" }]);
  assert.deepEqual(parseGeminiMessage("broken"), []);
});

test("pre-roll keeps the last N ms and resets when drained", () => {
  const roll = new PreRoll(16_000, 300); // 300 ms = 4800 samples
  for (let i = 0; i < 5; i++) roll.push(new Int16Array(1_600).fill(i)); // 5 × 100 ms
  const drained = roll.drain();
  assert.equal(drained.length, 3);
  assert.equal(drained[0][0], 2);
  assert.equal(roll.drain().length, 0);
});

test("two activities joined without a space are split", () => {
  const final = (text: string) => parseGeminiMessage(JSON.stringify({ serverContent: { inputTranscription: { text } } }));
  assert.deepEqual(final("Tabii.5532234875"), [{ kind: "final", text: "Tabii. 5532234875" }]);
  assert.deepEqual(final("bir şey yazıyordur.Ortalama beş kişi"), [{ kind: "final", text: "bir şey yazıyordur. Ortalama beş kişi" }]);
  assert.deepEqual(final("Geliyor mu?Evet"), [{ kind: "final", text: "Geliyor mu? Evet" }]);
  // domains, e-mails, decimals and thousands separators are kept
  assert.deepEqual(final("example.com adresine 5.000 ve 3.5"), [{ kind: "final", text: "example.com adresine 5.000 ve 3.5" }]);
  assert.deepEqual(final("ali@firma.com.tr"), [{ kind: "final", text: "ali@firma.com.tr" }]);
});
