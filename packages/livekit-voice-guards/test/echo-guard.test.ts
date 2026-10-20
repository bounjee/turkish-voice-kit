import assert from "node:assert/strict";
import { test } from "node:test";
import { isEchoOf, isQuietFragment, SpokenLog } from "../src/echo-guard.ts";

/*
 * Echo (iOS Instagram in-app browser): the agent's filler "Fiyat bilgisine bakıyorum." came back into
 * the microphone ~560 ms later, the STT wrote "Fiyat bilgisi" and it counted as the caller's speech;
 * the ready price answer was thrown away. Across 118 final transcripts in 22 recorded calls this rule
 * catches only that echo.
 */
test("a consecutive run of what the agent just said is echo", () => {
  assert.equal(isEchoOf("Fiyat bilgisi", "Fiyat bilgisine bakıyorum."), true);
  assert.equal(isEchoOf("bakıyorum", "Fiyat bilgisine bakıyorum."), false, "one word is not enough");
  assert.equal(isEchoOf("Fiyatınız nedir?", "Fiyat bilgisine bakıyorum."), false);
  assert.equal(isEchoOf("Kurumsal paket işletmeye", "[warm] Kurumsal paket işletmeye özel belirlenir."), true);
  assert.equal(isEchoOf("paket fiyatı", "Başlangıç üç bin beş yüz lira."), false);
  assert.equal(isEchoOf("", "Merhaba"), false);
});

/* The STT may write the number in an echo with digits ("3.500 lira") while the log holds the spoken
   form ("üç bin beş yüz") or the LLM's raw text ("₺3.500"): numbers and currency are left out. */
test("numbers and currency are left out of the echo comparison", () => {
  const spoken = "[warm] Başlangıç üç bin beş yüz lira, Profesyonel yedi bin beş yüz lira aylık.";
  assert.equal(isEchoOf("Başlangıç 3.500 lira, Profesyonel", spoken), true);
  assert.equal(isEchoOf("Başlangıç ₺3.500, Profesyonel ₺7.500", spoken), true);
  assert.equal(isEchoOf("3.500 lira", spoken), false, "numbers and units alone are not enough");
  assert.equal(isEchoOf("Profesyonel paket", spoken), false);
});

test("spoken text is kept for a short time", () => {
  const log = new SpokenLog(10_000);
  log.add("Fiyat bilgisine ", 1_000);
  log.add("bakıyorum. ", 1_200);
  assert.equal(log.recent(5_000), "Fiyat bilgisine  bakıyorum. ");
  assert.equal(isEchoOf("Fiyat bilgisi", log.recent(5_000)), true);
  assert.equal(log.recent(12_000), "", "forgotten after 10 s");
});

/*
 * Background fragment: while the agent was silent, "göz" and "dakikası" ~20 dB below the caller
 * opened turns and the agent asked a 6-7 s clarifying question. Across 46 short turns in 22 calls the
 * rule drops exactly 3 (these two and a quiet "Evet" counted as confirming an unheard question); it
 * drops no answer to a question.
 */
test("a quiet, short utterance is a fragment unless a question is pending", () => {
  const caller = -20;
  assert.equal(isQuietFragment({ text: "göz", levelDb: null, callerDb: caller, lastAssistant: "Bunu ekibe aktarıyorum." }), true);
  assert.equal(isQuietFragment({ text: "dakikası.", levelDb: -36, callerDb: caller, lastAssistant: "Görüşmeyi burada bırakıyorum." }), true);
  // A short answer to a question always passes.
  assert.equal(isQuietFragment({ text: "Evet.", levelDb: null, callerDb: caller, lastAssistant: "Demo talebi oluşturalım mı?" }), false);
  assert.equal(isQuietFragment({ text: "Cahit.", levelDb: null, callerDb: caller, lastAssistant: "İsminizi öğrenebilir miyim?" }), false);
  // A short utterance at the caller's own level passes.
  assert.equal(isQuietFragment({ text: "Tamam.", levelDb: -22, callerDb: caller, lastAssistant: "Fiyatlar bu kadar." }), false);
  // Three words or more pass.
  assert.equal(isQuietFragment({ text: "fiyatı ne kadar", levelDb: null, callerDb: caller, lastAssistant: "Buyurun." }), false);
  // Without a known caller level only speech that barely passed the gate (no level) is a fragment.
  assert.equal(isQuietFragment({ text: "göz", levelDb: -40, callerDb: null, lastAssistant: "" }), false);
  assert.equal(isQuietFragment({ text: "göz", levelDb: null, callerDb: null, lastAssistant: "" }), true);
});

/*
 * A person behind the caller while the agent speaks: the caller said "Onaylıyorum.", the agent started
 * its reply, a shout behind them (−30 dBFS, caller −18…−22) leaked through the gate for 350 ms and
 * "yemeyeceğim ben." interrupted the agent and reached the LLM. The agent's question had been
 * answered; for speech that starts over the agent there is no question exception. Across 77
 * interruptions in 61 recordings the rule drops 3 (this shout, a "kapas" fragment, a level-less
 * "Dostum."); it drops no interruption with a measured level.
 */
test("a quiet, short utterance over the agent is a fragment whatever the previous question", () => {
  const caller = -20;
  const lastAssistant = "Ahmet Bey adına D tipi daire talebinizi iletiyorum; onaylıyor musunuz?";
  assert.equal(isQuietFragment({ text: "yemeyeceğim ben.", levelDb: null, callerDb: caller, lastAssistant, overAgent: true }), true);
  assert.equal(isQuietFragment({ text: "yemeyeceğim ben.", levelDb: null, callerDb: caller, lastAssistant }), false, "while the agent is silent the question exception holds");
  // The caller interrupting in their own voice passes.
  assert.equal(isQuietFragment({ text: "Dur.", levelDb: -18, callerDb: caller, lastAssistant, overAgent: true }), false);
  assert.equal(isQuietFragment({ text: "hayır bir dakika bekle", levelDb: null, callerDb: caller, lastAssistant, overAgent: true }), false);
});
