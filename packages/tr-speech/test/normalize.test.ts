import assert from "node:assert/strict";
import { test } from "node:test";
import { digitsOf, entityHit, normalizeTr, spokenEmail } from "../src/normalize.ts";

/* Providers write numbers sometimes as digits, sometimes as words; unless "beş yüz kırk bir" and
   "541" count as the same, the word error rate misleads. */

test("number words become digits, groups stay separate", () => {
  assert.equal(normalizeTr("Beş yüz kırk bir, yedi yüz seksen bir, doksan dört, altmış altı."), "541 781 94 66");
  assert.equal(normalizeTr("sıfır beş yüz otuz üç"), "0 533");
  assert.equal(normalizeTr("yüz yirmi üç bin dört yüz elli altı"), "123456");
  assert.equal(normalizeTr("iki bin yirmi altı"), "2026");
  // A comma is a group boundary; "doksan beş yüz" without a comma is also two numbers (90 | 500).
  assert.equal(normalizeTr("Artı doksan, beş yüz yirmi iki, dört yüz kırk dört, on bir yirmi iki."), "artı 90 522 444 11 22");
  assert.equal(normalizeTr("artı doksan beş yüz yirmi iki"), "artı 90 522");
});

test("lowercase, no punctuation, Turkish letters kept", () => {
  assert.equal(normalizeTr("Adım Cahit Aybar."), "adım cahit aybar");
  assert.equal(normalizeTr("İLKAY, Işık!"), "ilkay ışık");
});

test("phone: digits only, written together or apart", () => {
  assert.equal(digitsOf("541 781 94 66"), "5417819466");
  assert.equal(digitsOf(normalizeTr("beş yüz kırk bir yedi yüz seksen bir doksan dört altmış altı")), "5417819466");
});

test("a spoken e-mail becomes its written form", () => {
  assert.equal(spokenEmail("cahit nokta aybar et ornek nokta com"), "cahit.aybar@ornek.com");
  assert.equal(spokenEmail("Cahit.Aybar@ornek.com"), "cahit.aybar@ornek.com");
});

test("entity hit: name as whole words, phone as digits, e-mail in written form", () => {
  assert.equal(entityHit({ type: "name", value: "Cahit Aybar" }, "Adım Cahit Aybar."), true);
  assert.equal(entityHit({ type: "name", value: "Cahit" }, "Adım Cahide."), false);
  assert.equal(entityHit({ type: "phone", value: "5417819466" }, "beş yüz kırk bir, yedi yüz seksen bir, doksan dört, altmış altı"), true);
  assert.equal(entityHit({ type: "email", value: "cahit.aybar@ornek.com" }, "cahit nokta aybar et ornek nokta com"), true);
});
