/**
 * Turkish reading of numbers in text. Apply it ONLY to the text sent to TTS; keep digits in the
 * transcript the user sees.
 *
 * Why: TTS engines read Turkish digits unreliably (a time as "bir dört sıfır sıfır", phone numbers
 * digit by digit). Prices, dates and order numbers reach the voice from a CRM export or a knowledge
 * base ("Randevunuz 3 Ekim 14:30'da", "2.450,00 TL ödemeniz"). A suffix after a digit must follow
 * the number's PRONUNCIATION ("5'e" = "beşe", "4'e" = "dörde"); if the suffix does not merge with
 * the spoken stem, the voice says "beş e" as two words.
 *
 * Turkish writing: thousands separator is a dot ("1.250"), decimal separator a comma ("12,5"); the
 * suffix after an apostrophe follows the spoken number (TDK). The rules are domain independent; the
 * unit and abbreviation lists hold only common, unambiguous entries.
 */

const ONES = ["", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"];
const TENS = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"];
const SCALES = ["", "bin", "milyon", "milyar", "trilyon"];
/** Digit runs longer than this (order or account numbers) are not read; they stay as they are. */
const MAX_DIGITS = 12;

const MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

function underThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  return [
    hundreds ? (hundreds === 1 ? "yüz" : `${ONES[hundreds]} yüz`) : "",
    TENS[Math.floor((n % 100) / 10)],
    ONES[n % 10],
  ]
    .filter(Boolean)
    .join(" ");
}

/** Cardinal number: 2026 → "iki bin yirmi altı", 1000 → "bin", 1000000 → "bir milyon". */
export function cardinal(n: number): string {
  if (n === 0) return "sıfır";
  const parts: string[] = [];
  let rest = n;
  for (let scale = 0; rest > 0; scale++) {
    const group = rest % 1000;
    // "bin" is said alone ("bir bin" is wrong); "milyon" and "milyar" take "bir".
    if (group) parts.unshift([scale === 1 && group === 1 ? "" : underThousand(group), SCALES[scale]].filter(Boolean).join(" "));
    rest = Math.floor(rest / 1000);
  }
  return parts.join(" ");
}

/** Digit string: leading zeros are read one by one ("05" → "sıfır beş"). */
function digitsWords(digits: string): string {
  if (digits.length > 1 && digits.startsWith("0")) return `sıfır ${digitsWords(digits.slice(1))}`;
  return cardinal(Number(digits));
}

/**
 * Identifier (order, room or customer number): 6+ digits without separators, digits written after
 * "#", or 4+ digits that start with zero are not amounts. They are read digit by digit in groups of
 * three ("4829175" → "dört sekiz iki, dokuz bir yedi, beş") instead of "bir milyon dört yüz…".
 * A separator-free run that ends in "000" is a round amount ("250000 kişi"); identifiers do not end
 * that way.
 */
export function digitGroups(digits: string): string {
  return (digits.match(/\d{1,3}/g) ?? []).map(spellDigits).join(", ");
}

/** Digit by digit: "0006" → "sıfır sıfır sıfır altı". */
export const spellDigits = (digits: string) => [...digits].map((d) => (d === "0" ? "sıfır" : ONES[Number(d)])).join(" ");

const isIdentifier = (int: string, frac?: string) =>
  !frac &&
  !int.includes(".") &&
  ((int.length >= 6 && !/^[1-9]\d*000$/.test(int)) || (int.length >= 4 && int.startsWith("0")));

const VOWELS = "aeıioöuü";
const isFront = (v: string) => "eiöü".includes(v);
const isRounded = (v: string) => "oöuü".includes(v);

function lastVowel(text: string): string {
  const lower = text.toLocaleLowerCase("tr");
  for (let i = lower.length - 1; i >= 0; i--) if (VOWELS.includes(lower[i])) return lower[i];
  return "e";
}

/** Stems that soften before a vowel-initial suffix (TDK dictionary: "dört, -dü", "buçuk, -ğu"). */
const SOFTENS: Record<string, string> = { dört: "dörd", buçuk: "buçuğ" };

/**
 * Fits a suffix to the spoken stem: consonant assimilation ("3'de" → "üçte", "10'ta" → "onda"),
 * softening of "dört" and "buçuk" ("4'e" → "dörde", "3,5'e" → "üç buçuğa") and vowel harmony
 * ("TL'ye" → "lira" + "ya"). A correctly written suffix stays as it is; "-ki" does not take part in
 * harmony ("2026'daki").
 */
export function attachSuffix(stem: string, suffix: string): string {
  let base = stem;
  const lastWord = (base.split(" ").at(-1) ?? base).toLocaleLowerCase("tr");
  let s = fixBuffer(suffix.toLocaleLowerCase("tr"), VOWELS.includes(lastWord.at(-1) ?? ""));
  if (/^[dt]/.test(s)) s = (/[çfhkpsşt]$/.test(lastWord) ? "t" : "d") + s.slice(1);
  const soft = SOFTENS[lastWord];
  if (soft && VOWELS.includes(s[0] ?? "")) base = base.slice(0, -lastWord.length) + soft;
  let prev = lastVowel(base);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    // "-ki" (2026'daki, 3'ündeki) does not take part in vowel harmony.
    if (c === "i" && s[i - 1] === "k" && /[dt][ea]k$|n[ıiuü]nk$/.test(out)) {
      out += "i";
      prev = "i";
    } else if (c === "e" || c === "a") {
      out += isFront(prev) ? "e" : "a";
      prev = out.at(-1)!;
    } else if ("ıiuü".includes(c)) {
      out += isFront(prev) ? (isRounded(prev) ? "ü" : "i") : isRounded(prev) ? "u" : "ı";
      prev = out.at(-1)!;
    } else {
      out += c;
      if (c === "o" || c === "ö") prev = c;
    }
  }
  return base + out;
}

/**
 * Fits the buffer consonant to the spoken stem: a vowel-final stem needs y/n/s, a consonant-final
 * stem does not ("2'e" → "ikiye", "2'in" → "ikinin", "10'ya" → "ona", "3'nin" → "üçün",
 * "5'si" → "beşi", "5'yle" → "beşle", "2'inde" → "ikisinde", "5'şer" → "beşer"). Ordinal suffixes
 * too: "6'ıncı" → "altıncı", "3'ncü" → "üçüncü".
 */
function fixBuffer(s: string, vowelFinal: boolean): string {
  if (vowelFinal) {
    if (/^[ıiuü]nc[ıiuü]/.test(s)) return s.slice(1);
    // Possessive + case is not the genitive: "ayın 2'inde" → "ikisinde" (not "ikininde").
    if (/^[ıiuü]n(?:d[ae]n?|d[ae]ki|[aeıiuü]|l[ae])$/.test(s)) return `s${s}`;
    if (/^[ıiuü]n(?![cç])/.test(s)) return `n${s}`;
    // The distributive suffix takes "ş" after a vowel: "2'er" → "ikişer".
    if (/^[ae]r$/.test(s)) return `ş${s}`;
    if (/^[aeıioöuü]/.test(s) || /^l[ae]$/.test(s)) return `y${s}`;
    return s;
  }
  if (/^ş[ae]r$/.test(s)) return s.slice(1);
  if (/^y[aeıioöuü]/.test(s) || /^yl[ae]/.test(s)) return s.slice(1);
  if (/^n[ıiuü]n/.test(s)) return s.slice(1);
  if (/^s[ıiuü](?=$|n)/.test(s)) return s.slice(1);
  if (/^nc[ıiuü]/.test(s)) return `i${s}`;
  return s;
}

/** Ordinal number: 1 → "birinci", 4 → "dördüncü", 6 → "altıncı", 40 → "kırkıncı". */
export function ordinal(n: number): string {
  const words = cardinal(n);
  const v = lastVowel(words);
  const i = isFront(v) ? (isRounded(v) ? "ü" : "i") : isRounded(v) ? "u" : "ı";
  const tail = `nc${i}`;
  if (VOWELS.includes(words.at(-1)!)) return words + tail;
  return attachSuffix(words, `${i}${tail}`);
}

/** Dative and ablative case ("dokuzdan on sekize"), used for time ranges. */
export function withCase(words: string, kind: "dat" | "abl"): string {
  if (kind === "abl") return attachSuffix(words, "den");
  return attachSuffix(words, VOWELS.includes(words.at(-1)!) ? "ye" : "e");
}

type Num = { int: string; frac?: string };

/** "1.250" / "12,5" / "2.450,00" → integer and fraction parts (the thousands dot is dropped). */
function parseNum(int: string, frac?: string): Num | null {
  const digits = int.replace(/\./g, "");
  if (digits.length > MAX_DIGITS) return null;
  return { int: digits, frac };
}

/** Decimal reading: ",5" → "buçuk", ",25" → "virgül yirmi beş", ",05" → "virgül sıfır beş". */
function numberWords(num: Num): string {
  const int = digitsWords(num.int);
  if (!num.frac || /^0+$/.test(num.frac)) return int;
  if (num.frac === "5" && Number(num.int) > 0) return `${int} buçuk`;
  return `${int} virgül ${digitsWords(num.frac)}`;
}

/** Number pattern (Turkish format): 1.250 · 12 · 12,5 · 2.450,00. No letter or digit next to it. */
const NUM = String.raw`(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,3}))?`;
/** No letter, digit or separator before it, and no hyphen attached to a letter ("DW-53", "COVID-19" stay codes). */
const BEFORE = String.raw`(?<![\p{L}\p{N}.,/])(?<!\p{L}-)`;
const AFTER = String.raw`(?![\p{L}\p{N}]|[.,/]\p{N})`;
/** Suffix written after an apostrophe: "2026'da", "TL'ye". */
const SUFFIX = String.raw`(?:['’](\p{L}+))?`;

const CURRENCY: Record<string, { word: string; cents: string }> = {
  tl: { word: "lira", cents: "kuruş" },
  "₺": { word: "lira", cents: "kuruş" },
  lira: { word: "lira", cents: "kuruş" },
  usd: { word: "dolar", cents: "sent" },
  $: { word: "dolar", cents: "sent" },
  dolar: { word: "dolar", cents: "sent" },
  eur: { word: "avro", cents: "sent" },
  "€": { word: "avro", cents: "sent" },
  euro: { word: "avro", cents: "sent" },
  avro: { word: "avro", cents: "sent" },
  gbp: { word: "sterlin", cents: "peni" },
  "£": { word: "sterlin", cents: "peni" },
  sterlin: { word: "sterlin", cents: "peni" },
};

/** Money: "2.450,00 TL" → "iki bin dört yüz elli lira", "12,50 TL" → "on iki lira elli kuruş". */
function money(int: string, frac: string | undefined, key: string, suffix?: string): string | null {
  const cur = CURRENCY[key.toLocaleLowerCase("tr")];
  // A three-digit "fraction" without a Turkish thousands dot is an English thousands comma
  // ("1,250 TL" = one thousand two hundred fifty); "1.250,000 TL" and "0,125 TL" stay decimal
  // (otherwise the price grew a thousandfold).
  const english = frac?.length === 3 && !int.includes(".") && !int.startsWith("0");
  const num = parseNum(english ? int + frac : int, english ? undefined : frac);
  if (!num) return null;
  let cents = num.frac && !/^0+$/.test(num.frac) ? num.frac : undefined;
  // One-digit cents: "0,5 TL" is fifty kuruş; "12,5 TL" stays "on iki buçuk lira".
  if (cents?.length === 1 && !(cents === "5" && Number(num.int) > 0)) cents += "0";
  let words: string;
  if (cents?.length === 2) {
    const centWords = cardinal(Number(cents));
    words = Number(num.int) > 0 ? `${digitsWords(num.int)} ${cur.word} ${centWords} ${cur.cents}` : `${centWords} ${cur.cents}`;
  } else {
    words = `${numberWords({ int: num.int, frac: cents })} ${cur.word}`;
  }
  return suffix ? attachSuffix(words, suffix) : words;
}

const UNITS: Record<string, string> = {
  km: "kilometre",
  "m²": "metrekare",
  m2: "metrekare",
  kg: "kilogram",
  cm: "santimetre",
  mm: "milimetre",
  gr: "gram",
  dk: "dakika",
  sn: "saniye",
  lt: "litre",
  m: "metre",
  "°c": "derece",
  "°": "derece",
};

/**
 * Common abbreviations (addresses and titles). TTS engines cannot read "Cad." or "Dr."; a title is
 * expanded only when a capitalized name follows it ("Av. Mehmet").
 */
const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/(?<![\p{L}])Cad\.(?=\s|$)/gu, "Caddesi"],
  [/(?<![\p{L}])Sok\.(?=\s|$)/gu, "Sokak"],
  [/(?<![\p{L}])Mah\.(?=\s|$)/gu, "Mahallesi"],
  [/(?<![\p{L}])(?:Blv|Bulv)\.(?=\s|$)/gu, "Bulvarı"],
  [/(?<![\p{L}])Apt\.(?=\s|$)/gu, "Apartmanı"],
  [/(?<![\p{L}])No\s?[:.]\s?(?=\d)/gu, "numara "],
  [/(?<=\d)\s?\/?\s?D\s?:\s?(?=\d)/gu, " daire "],
  [/(?<![\p{L}])Kat\s?:\s?(?=\d)/gu, "kat "],
  [/(?<![\p{L}])Tel\s?[:.]\s?(?=[\d+(])/gu, "telefon "],
  [/(?<![\p{L}])vb\.(?=\s|$|[,;])/gu, "ve benzeri"],
  [/(?<![\p{L}])vs\.(?=\s|$|[,;])/gu, "vesaire"],
  [/(?<![\p{L}])örn\.(?=\s|$)/gu, "örneğin"],
  [/(?<![\p{L}])A\.Ş\.(?=\s|$|[,;.])/gu, "a şe"],
  [/(?<![\p{L}])Ltd\.\s?Şti\.(?=\s|$|[,;.])/gu, "limited şirketi"],
  [/(?<![\p{L}])Prof\.\s(?=\p{Lu})/gu, "Profesör "],
  [/(?<![\p{L}])Doç\.\s(?=\p{Lu})/gu, "Doçent "],
  [/(?<![\p{L}])Uzm\.\s(?=\p{Lu})/gu, "Uzman "],
  [/(?<![\p{L}])Op\.\s(?=\p{Lu})/gu, "Operatör "],
  [/(?<![\p{L}])Dr\.\s(?=\p{Lu})/gu, "Doktor "],
  [/(?<![\p{L}])Dt\.\s(?=\p{Lu})/gu, "Diş hekimi "],
  [/(?<![\p{L}])Av\.\s(?=\p{Lu})/gu, "Avukat "],
];

export function expandAbbreviations(text: string): string {
  return ABBREVIATIONS.reduce((out, [pattern, spoken]) => out.replace(pattern, spoken), text);
}

const re = (source: string) => new RegExp(source, "gu");

const DATE_DMY = re(String.raw`${BEFORE}(\d{1,2})([./-])(\d{1,2})\2(\d{4})${SUFFIX}(?![\p{L}\p{N}])`);
/** Two-digit year only with zero-padded day and month ("28.09.26"); "1.9.26" may be a version. */
const DATE_DMY_SHORT = re(String.raw`${BEFORE}(\d{2})\.(\d{2})\.(\d{2})${SUFFIX}(?![\p{L}\p{N}]|[.,]\p{N})`);
const DATE_ISO = re(String.raw`${BEFORE}(\d{4})-(\d{2})-(\d{2})${SUFFIX}(?![\p{L}\p{N}])`);
/** "24.10" followed by money or a unit is not a date or time but an English decimal ("24.10 TL", "1.25 kg"). */
export const NOT_DATE_AFTER = String.raw`\s?(?:TL|₺|USD|EUR|GBP|lira|dolar|euro|avro|sterlin|km|kg|cm|mm|gr|dk|sn|lt|m²|m2|%|°)(?![\p{L}\p{N}])`;
/**
 * Day.month without a year ("30.09"). Times (`speakTimes` in spoken.ts) run first; only values that
 * cannot be a time (day ≥ 24) are left here: "12.09" is read as a time there.
 */
const DATE_DM = re(String.raw`(?<![$€£₺%])${BEFORE}(\d{1,2})\.(0[1-9]|1[0-2])${SUFFIX}(?![\p{L}\p{N}]|[.,]\p{N}|${NOT_DATE_AFTER})`);
/** "3+1", "2+2": at most six digits on each side (an unbounded run made `cardinal` hang). */
const PLUS = re(String.raw`${BEFORE}(\d{1,6})\s?\+\s?(\d{1,6})${SUFFIX}${AFTER}`);
/** "%10-20" → "yüzde on ile yirmi". */
const PERCENT_RANGE = re(String.raw`%\s?${NUM}\s?[-–]\s?%?\s?${NUM}${SUFFIX}${AFTER}`);
/**
 * Range ("1-2 iş günü", "1.500-2.000 TL", "5-10 km"): the first number is read here; the second
 * stays in digits so the following currency, unit or suffix is read together with it in a later step.
 */
const RANGE = re(String.raw`${BEFORE}${NUM}\s?[-–]\s?(?=\d)`);
/** "7/24" and an address "No: 12/3" (dates were read before): "yedi yirmi dört", "on iki bölü üç". */
const SLASH = re(String.raw`${BEFORE}(\d{1,4})\/(\d{1,4})${SUFFIX}${AFTER}`);
/** "#48291": an identifier, read digit by digit (`digitGroups`); the suffix follows the last digit ("#1234'ü" → "… dördü"). */
const HASH = /#(\d+)(?:['’](\p{L}+))?(?![\p{L}\p{N}])/gu;
/**
 * Minus sign ("-5 derece", "−3", "-150 TL", "−%10"); ranges and codes were split off before. It is
 * read BEFORE money, percent and units; read afterwards, the sign was lost ("-beş derece").
 */
const MINUS = /(?<![\p{L}\p{N}.,])[-−](?=\d|[%₺$€£]\s?\d)/gu;
/**
 * English formats with a single meaning: "1,250.50" (comma thousands + dot decimal) and
 * "1,250,000" (two or more comma groups) are converted to the Turkish format.
 */
const EN_DECIMAL = re(String.raw`(?<![\p{L}\p{N}.,])(\d{1,3}(?:,\d{3})+)\.(\d{1,2})(?![\p{N}]|[.,]\p{N})`);
const EN_THOUSANDS = re(String.raw`(?<![\p{L}\p{N}.,])\d{1,3}(?:,\d{3}){2,}(?![\p{N}]|[.,]\p{N})`);
const MONEY_PREFIX = re(String.raw`(₺|\$|€|£)\s?${NUM}${SUFFIX}${AFTER}`);
const MONEY_SUFFIX = re(String.raw`${BEFORE}${NUM}\s?(TL|₺|USD|\$|EUR|€|GBP|£|lira|dolar|euro|avro|sterlin)(?![\p{L}\p{N}])${SUFFIX}`);
const PERCENT_PREFIX = re(String.raw`%\s?${NUM}${SUFFIX}${AFTER}`);
const PERCENT_SUFFIX = re(String.raw`${BEFORE}${NUM}\s?%${SUFFIX}`);
const UNIT = re(String.raw`${BEFORE}${NUM}\s?(km|m²|m2|kg|cm|mm|gr|dk|sn|lt|°C|°|m)(?![\p{L}\p{N}])${SUFFIX}`);
/**
 * Ordinal: a dot followed by a lowercase word ("3. kat"). A capitalized word counts only for address
 * and period names ("2. Blok", "1. Cadde", "4. Levent"); any other capital is a sentence end
 * ("Toplam 3. Başka…").
 */
const ORDINAL_NOUN = String.raw`(?:Blok|Bloğu|Cadde|Caddesi|Sokak|Sokağı|Kat|Katı|Daire|Etap|Kısım|Bölge|Levent|Organize|Sınıf|Yüzyıl|Dönem)(?!\p{L})`;
const ORDINAL = re(String.raw`${BEFORE}(\d{1,4})\.(?=\s+(?:\p{Ll}|${ORDINAL_NOUN}))`);
const PLAIN = re(String.raw`${BEFORE}${NUM}${SUFFIX}${AFTER}`);
/** "TL" + suffix without digits: "TL'ye" → "liraya" (the suffix was written for the "te-le" reading). */
const TL_SUFFIX = /(?<![\p{L}\p{N}])TL['’](\p{L}+)/gu;
const HAS_TL_SUFFIX = /(?<![\p{L}\p{N}])TL['’]\p{L}/u;
/**
 * English decimal ("2.5 kg", "1.99 TL"): a dot + 1-2 digits left after times and dates is converted
 * to the Turkish format (comma); a thousands dot has three digits, so the two do not mix.
 */
const DOT_DECIMAL = re(String.raw`${BEFORE}(\d+)\.(\d{1,2})(?![\p{L}\p{N}]|[.,]\p{N})`);

function withSuffix(words: string, suffix?: string): string {
  return suffix ? attachSuffix(words, suffix) : words;
}

function dateWords(day: string, month: string, year: string, suffix?: string): string | null {
  const d = Number(day);
  const m = Number(month);
  if (d < 1 || d > 31 || m < 1 || m > 12) return null;
  return `${cardinal(d)} ${MONTHS[m - 1]} ${withSuffix(cardinal(Number(year)), suffix)}`;
}

/**
 * Converts the digits in a text to their Turkish reading. Phone numbers and times must already be
 * words (`speakPhoneNumbers` and `speakTimes` in spoken.ts; `toSpoken` runs the whole chain). Digits
 * attached to letters (codes, model names: "DW-53AUGY", "5G") and runs longer than 12 digits stay as
 * they are; identifiers are read digit by digit (`digitGroups`).
 */
export function verbalizeNumbers(text: string): string {
  if (!/\d/.test(text) && !HAS_TL_SUFFIX.test(text)) return text;
  return text
    .replace(DATE_DMY, (m, d: string, _sep: string, mo: string, y: string, suffix?: string) => dateWords(d, mo, y, suffix) ?? m)
    .replace(DATE_DMY_SHORT, (m, d: string, mo: string, y: string, suffix?: string) => dateWords(d, mo, y, suffix) ?? m)
    .replace(DATE_ISO, (m, y: string, mo: string, d: string, suffix?: string) => dateWords(d, mo, y, suffix) ?? m)
    .replace(DATE_DM, (m, d: string, mo: string, suffix?: string) =>
      Number(d) >= 1 && Number(d) <= 31 ? `${cardinal(Number(d))} ${withSuffix(MONTHS[Number(mo) - 1], suffix)}` : m,
    )
    .replace(EN_DECIMAL, (_m, int: string, frac: string) => `${int.replace(/,/g, ".")},${frac}`)
    .replace(EN_THOUSANDS, (m) => m.replace(/,/g, "."))
    .replace(DOT_DECIMAL, "$1,$2")
    .replace(SLASH, (_m, a: string, b: string, suffix?: string) =>
      a === "7" && b === "24" ? withSuffix("yedi yirmi dört", suffix) : `${digitsWords(a)} bölü ${withSuffix(digitsWords(b), suffix)}`,
    )
    .replace(HASH, (_m, digits: string, suffix?: string) => withSuffix(digitGroups(digits), suffix))
    .replace(PLUS, (_m, a: string, b: string, suffix?: string) => `${cardinal(Number(a))} artı ${withSuffix(cardinal(Number(b)), suffix)}`)
    .replace(PERCENT_RANGE, (m, a: string, af: string | undefined, b: string, bf: string | undefined, suffix?: string) => {
      const from = parseNum(a, af);
      const to = parseNum(b, bf);
      return from && to ? `yüzde ${numberWords(from)} ile ${withSuffix(numberWords(to), suffix)}` : m;
    })
    .replace(RANGE, (m, a: string, af?: string) => {
      const from = parseNum(a, af);
      return from ? `${numberWords(from)} ile ` : m;
    })
    .replace(MINUS, "eksi ")
    .replace(MONEY_PREFIX, (m, symbol: string, int: string, frac?: string, suffix?: string) => money(int, frac, symbol, suffix) ?? m)
    .replace(MONEY_SUFFIX, (m, int: string, frac: string | undefined, currency: string, suffix?: string) =>
      money(int, frac, currency, suffix) ?? m,
    )
    .replace(PERCENT_PREFIX, (m, int: string, frac?: string, suffix?: string) => {
      const num = parseNum(int, frac);
      return num ? `yüzde ${withSuffix(numberWords(num), suffix)}` : m;
    })
    .replace(PERCENT_SUFFIX, (m, int: string, frac?: string, suffix?: string) => {
      const num = parseNum(int, frac);
      return num ? `yüzde ${withSuffix(numberWords(num), suffix)}` : m;
    })
    .replace(UNIT, (m, int: string, frac: string | undefined, unit: string, suffix?: string) => {
      const num = parseNum(int, frac);
      return num ? withSuffix(`${numberWords(num)} ${UNITS[unit.toLocaleLowerCase("tr")]}`, suffix) : m;
    })
    .replace(ORDINAL, (_m, n: string) => ordinal(Number(n)))
    .replace(PLAIN, (m, int: string, frac?: string, suffix?: string) => {
      if (isIdentifier(int, frac)) return int.length > MAX_DIGITS ? m : withSuffix(digitGroups(int), suffix);
      const num = parseNum(int, frac);
      return num ? withSuffix(numberWords(num), suffix) : m;
    })
    .replace(TL_SUFFIX, (_m, suffix: string) => attachSuffix("lira", suffix));
}
