import assert from "node:assert/strict";
import { test } from "node:test";
import { speakPhoneNumbers, speakTimes, toSpoken } from "../src/spoken.ts";

test("mobile number is read in 3-3-2-2 groups", () => {
  const spoken = "sıfır beş yüz kırk üç, iki yüz yedi, seksen iki, yirmi yedi";
  assert.equal(speakPhoneNumbers("0543 207 82 27"), spoken);
  assert.equal(speakPhoneNumbers("0 543 207 82 27"), spoken);
  assert.equal(speakPhoneNumbers("05432078227"), spoken);
  assert.equal(speakPhoneNumbers("0543-207-82-27"), spoken);
  assert.equal(speakPhoneNumbers("0 543 107 82 27"), "sıfır beş yüz kırk üç, yüz yedi, seksen iki, yirmi yedi");
});

test("a suffix after the number follows the last group", () => {
  assert.equal(speakPhoneNumbers("0532 123 45 67'yi aradık"), "sıfır beş yüz otuz iki, yüz yirmi üç, kırk beş, altmış yediyi aradık");
  assert.equal(speakPhoneNumbers("444 12 34'ten"), "dört yüz kırk dört, on iki, otuz dörtten");
});

test("country code, zero groups and 444 lines", () => {
  assert.equal(speakPhoneNumbers("+90 553 111 42 41"), "artı doksan, beş yüz elli üç, yüz on bir, kırk iki, kırk bir");
  assert.equal(speakPhoneNumbers("0850 305 00 07"), "sıfır sekiz yüz elli, üç yüz beş, sıfır sıfır, sıfır yedi");
  assert.equal(speakPhoneNumbers("444 12 34"), "dört yüz kırk dört, on iki, otuz dört");
});

test("only the number changes inside a sentence; other numbers are untouched", () => {
  assert.equal(
    speakPhoneNumbers("Telefonumuz 0543 207 82 27, hafta içi dokuzdan on sekize açığız."),
    "Telefonumuz sıfır beş yüz kırk üç, iki yüz yedi, seksen iki, yirmi yedi, hafta içi dokuzdan on sekize açığız.",
  );
  for (const text of ["23 Ekim 2026", "1.500 lira", "saat 14:30", "DW-53AUGY", "%20 indirim"]) {
    assert.equal(speakPhoneNumbers(text), text);
  }
});

test("times are read as numbers; minutes are not said on the full hour", () => {
  assert.equal(speakTimes("saat 14:00"), "saat on dört");
  assert.equal(speakTimes("saat 14.00"), "saat on dört");
  assert.equal(speakTimes("10:30"), "on otuz");
  assert.equal(speakTimes("09:00"), "dokuz");
  assert.equal(speakTimes("09:05"), "dokuz sıfır beş");
  assert.equal(speakTimes("23:45"), "yirmi üç kırk beş");
});

test("the apostrophe after a time is dropped: the suffix was written for the reading", () => {
  assert.equal(speakTimes("10:30’daki randevunuz"), "on otuzdaki randevunuz");
  assert.equal(speakTimes("saat 14.00'te"), "saat on dörtte");
});

test("dates, prices and thousands are not times", () => {
  for (const text of ["26.09.2026", "1.500 lira", "19.90 TL", "2.5 kilo", "25:61", "Ekim 2026"]) {
    assert.equal(speakTimes(text), text);
  }
});

test("time and phone are fixed together", () => {
  assert.equal(
    toSpoken("28 Eylül saat 14:00 randevunuz için 0543 207 82 27 numarasını arayın."),
    "yirmi sekiz Eylül saat on dört randevunuz için sıfır beş yüz kırk üç, iki yüz yedi, seksen iki, yirmi yedi numarasını arayın.",
  );
});

/*
 * A semicolon is a sentence end in speech. In 638 voice replies, 66% stretched the first sentence
 * with a semicolon (median 12.5 words, ~83% of the reply). Streaming TTS starts at a sentence end, so
 * the voice waited for the end of the reply; up to the semicolon the first part was a median 7 words.
 */
test("a semicolon becomes a full stop", () => {
  assert.equal(
    toSpoken("Evet, numaranızı bağlayarak çalışır; mesajları yanıtlar ve ekibe devreder."),
    "Evet, numaranızı bağlayarak çalışır. mesajları yanıtlar ve ekibe devreder.",
  );
  assert.equal(toSpoken("It works; it replies.", "en"), "It works. it replies.");
});

test("a colon is not read: it becomes a pause; times and URLs are kept", () => {
  assert.equal(toSpoken("Tutar: 150 TL, teslimat ücretsiz."), "Tutar, yüz elli lira, teslimat ücretsiz.");
  assert.equal(toSpoken("Adresiniz şu: Yıldız Sokak"), "Adresiniz şu, Yıldız Sokak");
  assert.equal(toSpoken("Sipariş özeti:"), "Sipariş özeti,");
  assert.ok(!toSpoken("Saat 14:30'da açığız: gelin.").includes(":"));
  assert.ok(toSpoken("Bkz https://example.com").includes("https://"));
});
