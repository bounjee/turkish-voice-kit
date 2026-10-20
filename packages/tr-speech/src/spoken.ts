import { attachSuffix, expandAbbreviations, NOT_DATE_AFTER, spellDigits, verbalizeNumbers, withCase } from "./numbers.ts";

/**
 * A spelling alias for a word the TTS engine reads wrongly ("WhatsApp" → "Vatsap"). Matches on word
 * boundaries; a hyphenated term also matches when written with a space ("Wi-Fi" / "Wi Fi").
 */
export type SpokenAlias = { from: string; to: string; caseSensitive?: boolean };

/**
 * Default aliases: English words, brands and abbreviations that are written in English but spoken
 * in Turkish. Aliases (spelling changes) work with every TTS model, unlike phoneme tags, and Turkish
 * pronunciation is written in Turkish spelling, not IPA. Pass your own list to `toSpoken` to add
 * brand names; earlier entries run first, so put long forms before short ones.
 */
export const DEFAULT_ALIASES: readonly SpokenAlias[] = [
  // Regulation and institution abbreviations, read letter by letter
  { from: "KVKK", to: "Ka Ve Ka Ka" },
  { from: "GDPR", to: "Ci Di Pi Ar" },
  // Channel names
  { from: "WhatsApp", to: "Vatsap" },
  { from: "Instagram", to: "İnstagram" },
  { from: "Messenger", to: "Mesıncır" },
  // Hospitality terms written in English and spoken in Turkish
  { from: "check-in", to: "çek in" },
  { from: "check-out", to: "çek aut" },
  { from: "Wi-Fi", to: "Vay Fay" },
  { from: "WiFi", to: "Vay Fay" },
  // Technical abbreviations
  { from: "SMS", to: "Se Me Se" },
  { from: "URL", to: "U Er El" },
  { from: "API", to: "Ey Pi Ay" },
  // TTS engines spell uppercase abbreviations letter by letter with English letter names.
  { from: "TL", to: "lira", caseSensitive: true },
  { from: "KDV", to: "Ka De Ve", caseSensitive: true },
];

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A suffix after an apostrophe is refitted to the alias: it may have been chosen for the written
 * form ("KVKK'ye" = "ke-ve-ke-ke") while the spoken form differs ("Ka Ve Ka Ka'ya");
 * "SMS'e" → "Se Me Se'ye". A hyphenated term may arrive without the hyphen ("Wi Fi"); both match.
 */
const aliasSource = (text: string) => escapeRe(text).replace(/-/g, "[- ]");
type CompiledAlias = { pattern: RegExp; alias: string };
const compiled = new WeakMap<readonly SpokenAlias[], CompiledAlias[]>();
function compileAliases(aliases: readonly SpokenAlias[]): CompiledAlias[] {
  let out = compiled.get(aliases);
  if (!out) {
    out = aliases.map((rule) => ({
      pattern: new RegExp(`(?<![\\p{L}\\p{N}])${aliasSource(rule.from)}(?![\\p{L}\\p{N}])(?:['’](\\p{L}+))?`, rule.caseSensitive ? "gu" : "giu"),
      alias: rule.to,
    }));
    compiled.set(aliases, out);
  }
  return out;
}

const withAliasSuffix = (alias: string, suffix?: string) =>
  suffix ? `${alias}'${attachSuffix(alias, suffix).slice(alias.length)}` : alias;
/**
 * Symbols: TTS engines may read "+" in English. Percent ("%20" → "yüzde yirmi") and digit forms
 * like "3+1" are read in numbers.ts; attached forms like "TL+KDV" and "18+" here. Turkish only.
 */
const SYMBOLS: Array<[RegExp, string]> = [
  [/\s\+\s/g, " artı "],
  [/(?<=\p{L})\+(?=\p{L})/gu, " artı "],
  [/(?<=\p{L})\+(?![\p{L}\p{N}])/gu, " artı"],
];

/**
 * Phone numbers are read in groups in Turkish: "0543 207 82 27" → "sıfır beş yüz kırk üç, iki yüz
 * yedi, seksen iki, yirmi yedi". TTS engines read them digit by digit ("iki sıfır yedi"). Other
 * numbers (dates, prices, times) are not touched here.
 */
const ONES = ["sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"];
const TENS = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"];

/** One digit group: "207" → "iki yüz yedi"; a leading zero is read separately ("07" → "sıfır yedi"). */
function groupWords(digits: string): string {
  if (digits.startsWith("0")) return digits.length > 1 ? `sıfır ${groupWords(digits.slice(1))}` : "sıfır";
  const n = Number(digits);
  const hundreds = Math.floor(n / 100);
  const parts = [
    hundreds ? (hundreds === 1 ? "yüz" : `${ONES[hundreds]} yüz`) : "",
    TENS[Math.floor((n % 100) / 10)],
    n % 10 ? ONES[n % 10] : "",
  ];
  return parts.filter(Boolean).join(" ");
}

/** Area codes start with 2-5 or 8 (landline, mobile, 850); 444 lines are separate. */
const NATIONAL_PHONE =
  /(?<![\p{L}\p{N}+])(?:(\+90)[\s-]?|\(?(0)[\s-]?)?\(?([2-58]\d{2})\)?[\s-]?(\d{3})[\s-]?(\d{2})[\s-]?(\d{2})(?![\p{N}])(?:['’](\p{L}+))?/gu;
/** 444 lines are written two ways: "444 12 34" and "444 1 234". */
const SHORT_PHONE = /(?<![\p{L}\p{N}])(444)(?:[\s-]?(\d{2})[\s-]?(\d{2})|[\s-](\d)[\s-](\d{3}))(?![\p{N}])(?:['’](\p{L}+))?/gu;
/** IBAN: in its written groups of four, digit by digit ("TR12 0006 …" → "Te Re, bir iki, sıfır sıfır sıfır altı, …"). */
const IBAN = /(?<![\p{L}\p{N}])TR\s?(\d{2})((?:\s?\d{4}){5})\s?(\d{2})(?![\p{N}])/gu;

/** A suffix after the number follows the last group ("… 67'yi" → "… altmış yediyi"). */
const withPhoneSuffix = (words: string, suffix?: string) => (suffix ? attachSuffix(words, suffix) : words);

export function speakPhoneNumbers(text: string): string {
  return text
    .replace(IBAN, (_m, check: string, groups: string, last: string) =>
      ["Te Re", check, ...(groups.match(/\d{4}/g) ?? []), last].map((g) => (g === "Te Re" ? g : spellDigits(g))).join(", "),
    )
    .replace(
      NATIONAL_PHONE,
      (_m, country: string | undefined, zero: string | undefined, area: string, g1: string, g2: string, g3: string, suffix?: string) =>
        withPhoneSuffix(
          [...(country ? ["artı doksan"] : []), `${zero ? "sıfır " : ""}${groupWords(area)}`, ...[g1, g2, g3].map(groupWords)].join(", "),
          suffix,
        ),
    )
    .replace(SHORT_PHONE, (_m, g1: string, a: string | undefined, b: string | undefined, c: string | undefined, d: string | undefined, suffix?: string) =>
      withPhoneSuffix([g1, a ?? c!, b ?? d!].map(groupWords).join(", "), suffix),
    );
}

/**
 * Times are read as numbers in Turkish: "14:00" → "on dört", "10:30" → "on otuz". TTS engines read
 * them digit by digit ("bir dört sıfır sıfır"). On the full hour the minutes are not said; the suffix
 * follows the spoken number ("14.00'te" = "on dörtte") and the apostrophe is dropped; the suffix is
 * refitted to the reading ("14:00'e" = "on dörde"). Dates (26.09.2026), thousands (1.500) and invalid
 * times (25:61) do not change.
 */
const TIME = String.raw`([01]?\d|2[0-3]|24(?=[:.]00))[:.]([0-5]\d)`;
/**
 * An English decimal written with money or percent is not a time ("$12.30", "%2.49", "12.30 TL",
 * "1.25 kg"); "12.09 tarihinde" is day.month.
 */
const CLOCK_TIME = new RegExp(
  String.raw`(?<![\p{N}.,:$€£₺%])${TIME}(?!\p{N}|[.,:]\p{N}|${NOT_DATE_AFTER}|\s+tarih)(?:['’](\p{L}+))?`,
  "gu",
);
/**
 * Time range: "09:00-18:00" → "dokuzdan on sekize kadar"; followed by "arası" or "saatleri" it is
 * "dokuz ile on sekiz" ("… arası açığız").
 */
const TIME_RANGE = new RegExp(String.raw`(?<![\p{N}.,:])${TIME}\s?[-–]\s?${TIME}(?!\p{N}|[.,:]\p{N})(?:['’](\p{L}+))?`, "gu");
const BETWEEN = /^\s+(?:saat|aras)\p{L}*/u;

const clockWords = (hour: string, minute: string) =>
  minute === "00" ? groupWords(String(Number(hour))) : `${groupWords(String(Number(hour)))} ${groupWords(minute)}`;

export function speakTimes(text: string): string {
  return text
    .replace(TIME_RANGE, (m: string, h1: string, m1: string, h2: string, m2: string, suffix: string | undefined, offset: number, whole: string) => {
      const from = clockWords(h1, m1);
      const to = clockWords(h2, m2);
      // A written suffix belongs to the second time: "09:00-18:00'e kadar" → "dokuzdan on sekize kadar".
      if (suffix && /^y?[ae]$/i.test(suffix)) return `${withCase(from, "abl")} ${withCase(to, "dat")}`;
      if (suffix) return `${withCase(from, "abl")} ${withCase(to, "dat")} ${attachSuffix("kadar", suffix)}`;
      return BETWEEN.test(whole.slice(offset + m.length))
        ? `${from} ile ${to}`
        : `${withCase(from, "abl")} ${withCase(to, "dat")} kadar`;
    })
    .replace(CLOCK_TIME, (_m, hour: string, minute: string, suffix?: string) =>
      suffix ? attachSuffix(clockWords(hour, minute), suffix) : clockWords(hour, minute),
    );
}

export type ToSpokenOptions = {
  /** Conversation language. Digit, time, phone and abbreviation rules apply only to "tr". Default "tr". */
  language?: string;
  /** Spelling aliases, applied in every language. Default `DEFAULT_ALIASES`. */
  aliases?: readonly SpokenAlias[];
};

/**
 * Text for the TTS engine. Digit, time, phone and abbreviation rules are Turkish readings: ONLY in a
 * Turkish conversation; in other languages the TTS engine reads digits in its own language. Aliases
 * apply in every language.
 */
export function toSpoken(text: string, options: ToSpokenOptions | string = {}): string {
  const { language = "tr", aliases = DEFAULT_ALIASES } = typeof options === "string" ? { language: options } : options;
  const turkish =
    language === "tr" ? verbalizeNumbers(speakTimes(speakPhoneNumbers(expandAbbreviations(speakAddresses(text))))) : text;
  const aliased = compileAliases(aliases).reduce(
    (out, { pattern, alias }) => out.replace(pattern, (_m, suffix?: string) => withAliasSuffix(alias, suffix)),
    turkish,
  );
  const spoken = language === "tr" ? SYMBOLS.reduce((out, [pattern, spoken]) => out.replace(pattern, spoken), aliased) : aliased;
  /* A semicolon is a sentence end in speech: streaming TTS starts at a sentence end and LLMs often
     stretch the first sentence with a semicolon, so the voice waited for the end of the reply.
     A colon followed by a space ("Tutar: 150 TL") was read aloud as "iki nokta"; it becomes a comma
     (short pause). Times ("14:00") and URLs ("https://") have no space after the colon; times were
     already turned into words above. */
  return spoken.replace(/;(?=\s|$)/g, ".").replace(/\s*:(?=\s|$)/g, ",");
}

/**
 * E-mail addresses and domains: "info@example.com" → "info et example nokta kom". Raw, "@" and dots
 * were read wrongly, and an alias could split the domain.
 */
const EMAIL = /(?<![\p{L}\d._%+-])([\p{L}\d._%+-]+)@([\p{L}\d-]+(?:\.[\p{L}\d-]+)+)/gu;
const DOMAIN = /(?<![\p{L}\d@.])([\p{L}\d-]+(?:\.[\p{L}\d-]+)*\.(?:com|net|org|io|ai|app|co)(?:\.tr)?)(?![\p{L}\d])/gu;
const LOCAL_SYMBOLS: Record<string, string> = { ".": " nokta ", _: " alt çizgi ", "-": " tire ", "+": " artı " };
/** In Turkish speech "com" sounds like "cöm" (c = "ce"): "kom". */
const DOMAIN_PARTS: Record<string, string> = { com: "kom", co: "ko" };
const speakDomain = (domain: string) =>
  domain
    .split(".")
    .map((part) => DOMAIN_PARTS[part.toLocaleLowerCase("tr")] ?? part)
    .join(" nokta ");

export function speakAddresses(text: string): string {
  return text
    .replace(EMAIL, (_m, local: string, domain: string) =>
      `${local.replace(/[._+-]/g, (c) => LOCAL_SYMBOLS[c]).replace(/\s+/g, " ").trim()} et ${speakDomain(domain)}`,
    )
    .replace(DOMAIN, (_m, domain: string) => speakDomain(domain));
}
