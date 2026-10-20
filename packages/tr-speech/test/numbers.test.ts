import assert from "node:assert/strict";
import { test } from "node:test";
import { attachSuffix, cardinal, expandAbbreviations, ordinal, verbalizeNumbers, withCase } from "../src/numbers.ts";
import { DEFAULT_ALIASES, toSpoken } from "../src/spoken.ts";

test("cardinal: 'bin' alone, 'milyon' and 'milyar' take 'bir'", () => {
  const cases: Array<[number, string]> = [
    [0, "sıfır"],
    [7, "yedi"],
    [10, "on"],
    [19, "on dokuz"],
    [100, "yüz"],
    [101, "yüz bir"],
    [250, "iki yüz elli"],
    [1000, "bin"],
    [1001, "bin bir"],
    [2026, "iki bin yirmi altı"],
    [11000, "on bir bin"],
    [101000, "yüz bir bin"],
    [1000000, "bir milyon"],
    [1001000, "bir milyon bin"],
    [2500000, "iki milyon beş yüz bin"],
    [1000000000, "bir milyar"],
  ];
  for (const [n, words] of cases) assert.equal(cardinal(n), words, String(n));
});

test("ordinal with vowel harmony, 'dört' softens", () => {
  const cases: Array<[number, string]> = [
    [1, "birinci"],
    [2, "ikinci"],
    [3, "üçüncü"],
    [4, "dördüncü"],
    [5, "beşinci"],
    [6, "altıncı"],
    [9, "dokuzuncu"],
    [10, "onuncu"],
    [40, "kırkıncı"],
    [60, "altmışıncı"],
    [100, "yüzüncü"],
    [1000, "bininci"],
  ];
  for (const [n, words] of cases) assert.equal(ordinal(n), words, String(n));
});

test("suffix follows the reading: consonant assimilation, softening, vowel harmony", () => {
  assert.equal(attachSuffix("beş", "e"), "beşe");
  assert.equal(attachSuffix("dört", "e"), "dörde");
  assert.equal(attachSuffix("dört", "ten"), "dörtten");
  assert.equal(attachSuffix("üç", "de"), "üçte", "miswritten '3'de' is fixed");
  assert.equal(attachSuffix("on", "ta"), "onda", "miswritten '10'ta' is fixed");
  assert.equal(attachSuffix("altı", "ya"), "altıya");
  assert.equal(attachSuffix("beş", "a"), "beşe", "wrong vowel is fixed");
  assert.equal(attachSuffix("lira", "ye"), "liraya", "TL'ye → liraya");
  assert.equal(attachSuffix("iki bin yirmi altı", "daki"), "iki bin yirmi altıdaki", "-ki takes no harmony");
  assert.equal(attachSuffix("üç", "teki"), "üçteki");
});

test("buffer consonant follows the spoken stem", () => {
  const cases: Array<[string, string, string]> = [
    ["iki", "e", "ikiye"],
    ["iki", "in", "ikinin"],
    ["altı", "ı", "altıyı"],
    ["altı", "ıncı", "altıncı"],
    ["on", "ya", "ona"],
    ["üç", "ye", "üçe"],
    ["üç", "nin", "üçün"],
    ["üç", "ncü", "üçüncü"],
    ["beş", "si", "beşi"],
    ["beş", "yle", "beşle"],
    ["iki", "le", "ikiyle"],
    ["seksen", "ler", "seksenler"],
    ["kırk", "sı", "kırkı"],
    ["yirmi", "si", "yirmisi"],
    ["altı", "sında", "altısında"],
  ];
  for (const [stem, suffix, spoken] of cases) assert.equal(attachSuffix(stem, suffix), spoken, `${stem}'${suffix}`);
});

test("dative and ablative for time ranges", () => {
  assert.equal(withCase("dokuz", "abl"), "dokuzdan");
  assert.equal(withCase("on sekiz", "dat"), "on sekize");
  assert.equal(withCase("on dört", "dat"), "on dörde");
  assert.equal(withCase("on üç", "abl"), "on üçten");
  assert.equal(withCase("on iki", "abl"), "on ikiden");
  assert.equal(withCase("yirmi", "dat"), "yirmiye");
});

test("digits + apostrophe suffix are read as one word", () => {
  const cases: Array<[string, string]> = [
    ["2026'da", "iki bin yirmi altıda"],
    ["5'e kadar", "beşe kadar"],
    ["4'e kadar", "dörde kadar"],
    ["3'te", "üçte"],
    ["6'ya", "altıya"],
    ["10'dan", "ondan"],
    ["1990'lı yıllar", "bin dokuz yüz doksanlı yıllar"],
    ["80'ler", "seksenler"],
    ["2'şer adet", "ikişer adet"],
    ["4'er", "dörder"],
    ["3'üncü kat", "üçüncü kat"],
    ["1'inci", "birinci"],
    ["2026’daki", "iki bin yirmi altıdaki"],
  ];
  for (const [text, spoken] of cases) assert.equal(verbalizeNumbers(text), spoken, text);
});

test("money: thousands dot, decimal comma, cents, suffix", () => {
  const cases: Array<[string, string]> = [
    ["1.250 TL", "bin iki yüz elli lira"],
    ["2.450,00 TL", "iki bin dört yüz elli lira"],
    ["12,50 TL", "on iki lira elli kuruş"],
    ["12,5 TL", "on iki buçuk lira"],
    ["0,99 TL", "doksan dokuz kuruş"],
    ["₺1.250", "bin iki yüz elli lira"],
    ["1250₺", "bin iki yüz elli lira"],
    ["1.250 TL'ye", "bin iki yüz elli liraya"],
    ["500 TL'lik", "beş yüz liralık"],
    ["$100", "yüz dolar"],
    ["100 USD", "yüz dolar"],
    ["50 €", "elli avro"],
    ["2.500.000 TL", "iki milyon beş yüz bin lira"],
    ["1.99 TL", "bir lira doksan dokuz kuruş"],
  ];
  for (const [text, spoken] of cases) assert.equal(verbalizeNumbers(text), spoken, text);
});

test("percent is read before the number", () => {
  assert.equal(verbalizeNumbers("%20 indirim"), "yüzde yirmi indirim");
  assert.equal(verbalizeNumbers("% 15"), "yüzde on beş");
  assert.equal(verbalizeNumbers("%2,5 faiz"), "yüzde iki buçuk faiz");
  assert.equal(verbalizeNumbers("%20'si"), "yüzde yirmisi");
  assert.equal(verbalizeNumbers("%100'e"), "yüzde yüze");
  assert.equal(verbalizeNumbers("20% off"), "yüzde yirmi off");
});

test("date: day, month name, year; the suffix goes to the year", () => {
  assert.equal(verbalizeNumbers("28.09.2026"), "yirmi sekiz Eylül iki bin yirmi altı");
  assert.equal(verbalizeNumbers("3/10/2026"), "üç Ekim iki bin yirmi altı");
  assert.equal(verbalizeNumbers("2026-09-28"), "yirmi sekiz Eylül iki bin yirmi altı");
  assert.equal(verbalizeNumbers("01.01.2027'de"), "bir Ocak iki bin yirmi yedide");
  assert.equal(verbalizeNumbers("28 Eylül 2026"), "yirmi sekiz Eylül iki bin yirmi altı");
  assert.equal(verbalizeNumbers("son gün 30.09"), "son gün otuz Eylül");
  assert.equal(verbalizeNumbers("45.13.2026"), "45.13.2026", "invalid date is not read");
});

test("decimals, ranges, plus, units", () => {
  const cases: Array<[string, string]> = [
    ["3,5 saat", "üç buçuk saat"],
    ["2,75", "iki virgül yetmiş beş"],
    ["0,5", "sıfır virgül beş"],
    ["1,05", "bir virgül sıfır beş"],
    ["2.5 kg", "iki buçuk kilogram"],
    ["1-2 iş günü", "bir ile iki iş günü"],
    ["10–15 dakika", "on ile on beş dakika"],
    ["%10-20 arası indirim", "yüzde on ile yirmi arası indirim"],
    ["1.500-2.000 TL arası", "bin beş yüz ile iki bin lira arası"],
    ["5-10 km", "beş ile on kilometre"],
    ["2020-2024 arası", "iki bin yirmi ile iki bin yirmi dört arası"],
    ["3+1 daire", "üç artı bir daire"],
    ["2+1'lik", "iki artı birlik"],
    ["120 m²", "yüz yirmi metrekare"],
    ["120 m2 bahçe", "yüz yirmi metrekare bahçe"],
    ["5 km'den", "beş kilometreden"],
    ["10 kg'lık", "on kilogramlık"],
    ["30 dk", "otuz dakika"],
    ["25°C", "yirmi beş derece"],
  ];
  for (const [text, spoken] of cases) assert.equal(verbalizeNumbers(text), spoken, text);
});

test("ordinal: dot + lowercase word", () => {
  assert.equal(verbalizeNumbers("Binamızın 3. katındayız."), "Binamızın üçüncü katındayız.");
  assert.equal(verbalizeNumbers("2. el ve 4. gün"), "ikinci el ve dördüncü gün");
  assert.equal(verbalizeNumbers("Toplam 3. Başka bir sorunuz var mı?"), "Toplam üç. Başka bir sorunuz var mı?");
  assert.equal(verbalizeNumbers("Paketler 5."), "Paketler beş.");
});

test("identifiers are read digit by digit in groups of three", () => {
  assert.equal(verbalizeNumbers("Sipariş no 4829175"), "Sipariş no dört sekiz iki, dokuz bir yedi, beş");
  assert.equal(verbalizeNumbers("Siparişiniz #48291"), "Siparişiniz dört sekiz iki, dokuz bir");
  assert.equal(verbalizeNumbers("Müşteri kodu 01234"), "Müşteri kodu sıfır bir iki, üç dört");
  // Large numbers with separators and money are amounts.
  assert.equal(verbalizeNumbers("250.000 kişi"), "iki yüz elli bin kişi");
  assert.equal(verbalizeNumbers("125000 TL"), "yüz yirmi beş bin lira");
  // A round large number without separators is an amount too; identifiers do not end in "000".
  assert.equal(verbalizeNumbers("Nüfusumuz 250000 kişi"), "Nüfusumuz iki yüz elli bin kişi");
  assert.equal(verbalizeNumbers("1500000 ziyaretçi"), "bir milyon beş yüz bin ziyaretçi");
  assert.equal(verbalizeNumbers("Kod 012000"), "Kod sıfır bir iki, sıfır sıfır sıfır");
});

test("slash numbers: 7/24 and address numbers", () => {
  assert.equal(verbalizeNumbers("7/24 destek"), "yedi yirmi dört destek");
  assert.equal(verbalizeNumbers("No 12/3"), "No on iki bölü üç");
  assert.equal(verbalizeNumbers("3/10/2026"), "üç Ekim iki bin yirmi altı", "dates are read first");
});

test("minus and English number formats", () => {
  assert.equal(verbalizeNumbers("-5 derece"), "eksi beş derece");
  assert.equal(verbalizeNumbers("Sıcaklık −3"), "Sıcaklık eksi üç");
  assert.equal(verbalizeNumbers("1,250 TL"), "bin iki yüz elli lira", "a three-digit fraction in money is thousands");
  assert.equal(verbalizeNumbers("$1,250.50"), "bin iki yüz elli dolar elli sent");
  assert.equal(verbalizeNumbers("1,250,000 kişi"), "bir milyon iki yüz elli bin kişi");
  assert.equal(verbalizeNumbers("12,5 kg"), "on iki buçuk kilogram", "Turkish decimal comma is kept");
});

test("codes, model names and long account numbers stay as they are", () => {
  for (const text of ["DW-53AUGY", "5G", "A4 kağıt", "COVID-19", "1234567890123", "iPhone15"]) {
    assert.equal(verbalizeNumbers(text), text, text);
  }
  assert.equal(verbalizeNumbers("iPhone 15"), "iPhone on beş");
  assert.equal(verbalizeNumbers("5, 6 ve 7"), "beş, altı ve yedi");
});

test("a TL suffix without digits follows 'lira'", () => {
  assert.equal(verbalizeNumbers("Fiyatlar TL'dir"), "Fiyatlar liradır");
  assert.equal(verbalizeNumbers("TL'den"), "liradan");
  assert.equal(verbalizeNumbers("Rakam yok"), "Rakam yok");
});

test("address and title abbreviations are expanded", () => {
  assert.equal(
    expandAbbreviations("Atatürk Cad. No:12 D:3 Kadıköy"),
    "Atatürk Caddesi numara 12 daire 3 Kadıköy",
  );
  assert.equal(expandAbbreviations("Gül Sok. Bahar Mah."), "Gül Sokak Bahar Mahallesi");
  assert.equal(expandAbbreviations("Op. Dr. Ayşe Kaya"), "Operatör Doktor Ayşe Kaya");
  assert.equal(expandAbbreviations("Dt. Mehmet Bey"), "Diş hekimi Mehmet Bey");
  assert.equal(expandAbbreviations("kalem, defter vb. ürünler"), "kalem, defter ve benzeri ürünler");
  assert.equal(expandAbbreviations("Örnek Gıda A.Ş. adına"), "Örnek Gıda a şe adına");
  // A title only before a name; the word "av." at a sentence end is not touched.
  assert.equal(expandAbbreviations("Bu bir av. Sonra"), "Bu bir av. Sonra");
  assert.equal(expandAbbreviations("Tel: 0212 555 44 33"), "telefon 0212 555 44 33");
  assert.equal(expandAbbreviations("Tel. örgü"), "Tel. örgü");
});

const BRAND = [...DEFAULT_ALIASES, { from: "Dolphydesk", to: "Dolfi desk" }, { from: "Dolphy", to: "Dolfi" }];

test("toSpoken: the whole chain in Turkish, digits untouched in other languages", () => {
  assert.equal(
    toSpoken("Randevunuz 3 Ekim 14:30'da, ücreti 1.250 TL."),
    "Randevunuz üç Ekim on dört otuzda, ücreti bin iki yüz elli lira.",
  );
  assert.equal(toSpoken("Hafta içi 09:00-18:00 açığız."), "Hafta içi dokuzdan on sekize kadar açığız.");
  assert.equal(toSpoken("09:00-18:00 arası açığız."), "dokuz ile on sekiz arası açığız.");
  assert.equal(toSpoken("Randevunuz 14:00'e alındı."), "Randevunuz on dörde alındı.");
  // In English the TTS engine reads digits itself; aliases still apply.
  assert.equal(toSpoken("We are open 09:00-18:00, call 0543 207 82 27.", "en"), "We are open 09:00-18:00, call 0543 207 82 27.");
  assert.equal(toSpoken("Dolphy costs 1.250 TL.", { language: "en", aliases: BRAND }), "Dolfi costs 1.250 lira.");
});

test("suffix harmony after an alias, e-mail and domain", () => {
  assert.equal(toSpoken("KVKK'ye uygun"), "Ka Ve Ka Ka'ya uygun");
  assert.equal(toSpoken("SMS'e yazın"), "Se Me Se'ye yazın");
  assert.equal(toSpoken("Dolphy'a sorun", { aliases: BRAND }), "Dolfi'ye sorun");
  assert.equal(toSpoken("Dolphy'ye sorun", { aliases: BRAND }), "Dolfi'ye sorun");
  assert.equal(toSpoken("WhatsApp'dan yazın"), "Vatsap'tan yazın");
  assert.equal(toSpoken("Wi-Fi'ye bağlanın"), "Vay Fay'a bağlanın");
  assert.equal(toSpoken("Adresimiz info@dolphydesk.com", { aliases: BRAND }), "Adresimiz info et Dolfi desk nokta kom");
  assert.equal(toSpoken("Adresimiz info@ornek.com"), "Adresimiz info et ornek nokta kom");
  assert.equal(toSpoken("ali.veli_2@ornek.com.tr"), "ali nokta veli alt çizgi iki et ornek nokta kom nokta tr");
  assert.equal(toSpoken("Sitemiz ornek.com adresinde"), "Sitemiz ornek nokta kom adresinde");
});

/*
 * Independent check: number words matched CLDR exactly (103,803 values) and suffixes were checked
 * with the Zemberek morphological analyzer; the cases below are the defects that check found.
 */
test("check: minus sign in money, units and percent", () => {
  assert.equal(toSpoken("Sıcaklık -5°C"), "Sıcaklık eksi beş derece");
  assert.equal(toSpoken("Bakiye -150 TL"), "Bakiye eksi yüz elli lira");
  assert.equal(toSpoken("−%10 indirim"), "eksi yüzde on indirim");
});

test("check: a three-digit money fraction is thousands only without a Turkish thousands dot", () => {
  assert.equal(toSpoken("1.250,000 TL"), "bin iki yüz elli lira", "used to grow a thousandfold");
  assert.equal(toSpoken("0,125 TL"), "sıfır virgül yüz yirmi beş lira");
  assert.equal(toSpoken("1,250 TL"), "bin iki yüz elli lira");
  assert.equal(toSpoken("0,5 TL"), "elli kuruş");
  assert.equal(toSpoken("12,5 TL"), "on iki buçuk lira");
  assert.equal(toSpoken("£9.99"), "dokuz sterlin doksan dokuz peni");
});

test("check: decimals with money or percent are not times or dates", () => {
  assert.equal(toSpoken("Fiyat 24.10 TL."), "Fiyat yirmi dört lira on kuruş.");
  assert.equal(toSpoken("$12.30"), "on iki dolar otuz sent");
  assert.equal(toSpoken("Faiz %2.49."), "Faiz yüzde iki virgül kırk dokuz.");
  assert.equal(toSpoken("1.25 kg"), "bir virgül yirmi beş kilogram");
  assert.equal(toSpoken("12.09 tarihinde"), "on iki Eylül tarihinde");
  assert.equal(toSpoken("24:00'e kadar"), "yirmi dörde kadar");
});

test("check: suffix fixes for 'buçuk', distributive and possessive", () => {
  assert.equal(toSpoken("%12,5'e varan"), "yüzde on iki buçuğa varan");
  assert.equal(toSpoken("3,5'i"), "üç buçuğu");
  assert.equal(toSpoken("2'er"), "ikişer");
  assert.equal(toSpoken("5'şer"), "beşer");
  assert.equal(toSpoken("ayın 2'inde"), "ayın ikisinde");
  assert.equal(toSpoken("20'ine"), "yirmisine");
  assert.equal(toSpoken("2'in"), "ikinin", "genitive stays 'nin'");
  assert.equal(toSpoken("#1234'ü"), "bir iki üç, dördü");
});

test("check: address ordinals, date formats, phone and IBAN", () => {
  assert.equal(toSpoken("2. Blok, 1. Cadde"), "ikinci Blok, birinci Cadde");
  assert.equal(toSpoken("Toplam 3. Başka"), "Toplam üç. Başka", "another capital is a sentence end");
  assert.equal(toSpoken("28-09-2026"), "yirmi sekiz Eylül iki bin yirmi altı");
  assert.equal(toSpoken("28.09.26"), "yirmi sekiz Eylül yirmi altı");
  assert.equal(toSpoken("09:00-18:00'e kadar"), "dokuzdan on sekize kadar");
  assert.equal(toSpoken("444 1 234"), "dört yüz kırk dört, bir, iki yüz otuz dört");
  assert.equal(toSpoken("(0212) 555 12 34"), "sıfır iki yüz on iki, beş yüz elli beş, on iki, otuz dört");
  assert.equal(
    toSpoken("TR12 0006 1005 1978 6457 8413 26"),
    "Te Re, bir iki, sıfır sıfır sıfır altı, bir sıfır sıfır beş, bir dokuz yedi sekiz, altı dört beş yedi, sekiz dört bir üç, iki altı",
  );
  assert.equal(toSpoken("25 m"), "yirmi beş metre");
});

test("check: attached plus, hyphenated alias and English conversation", () => {
  assert.equal(toSpoken("TL+KDV"), "lira artı Ka De Ve");
  assert.equal(toSpoken("18+"), "on sekiz artı");
  assert.equal(toSpoken("Wi Fi şifresi"), "Vay Fay şifresi", "LLMs sometimes drop the hyphen");
  assert.equal(toSpoken("2 + 2 and 18+", "en"), "2 + 2 and 18+");
});

test("check: a long digit run does not hang", () => {
  const start = performance.now();
  toSpoken(`1${"0".repeat(400)}+1`);
  assert.ok(performance.now() - start < 1000);
  assert.equal(cardinal(2500000000000), "iki trilyon beş yüz milyar");
});
