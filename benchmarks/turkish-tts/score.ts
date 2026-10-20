/**
 * Turkish TTS benchmark: machine score. Scores the output of `generate.ts transcribe`
 * (`runs/transcripts/<stt>.jsonl`). No model calls, free.
 *
 *   npx tsx score.ts                                   # table + runs/scores.json
 *   npx tsx score.ts errors <model> <stt> <text|spoken>   # clips counted as errors: expected and heard
 *   RUNS=/path/to/runs npx tsx score.ts                # score another runs folder
 *
 * Two measures, per transcription model and combined:
 * - Word error rate: between the expected reading (`spoken`, else `text`; the closest of `alt`) and the
 *   heard transcript. Both sides go through the same reading converter (`toSpoken` from tr-speech): a
 *   transcription model writing "1.490 TL" or "bin dört yüz doksan lira" counts the same; the score
 *   measures what was said, not how it was spelled.
 * - Critical information: were all `entities` of the sentence (number, name, brand, e-mail) heard
 *   correctly? A sentence counts as correct when at least two of the three transcription models say
 *   "yes" (one model's hearing error must not punish the TTS model). The "at least one" rate is an
 *   upper bound: a transcription model can repair a wrong reading by itself ("bir bin" → "1000"), so on
 *   its own it is not reliable; blind listening settles the difference.
 * A sentence the model could not synthesize (error or timeout) counts as misread: all words wrong,
 * critical information missed. Clips that could not be generated because the provider's credit ran
 * out (402) are not counted.
 * Confidence intervals come from bootstrap resampling over sentences (1,000 times, fixed seed).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { digitsOf, normalizeTr, spokenEmail, toSpoken, type Entity } from "tr-speech";

const dir = new URL(".", import.meta.url).pathname;
const OUT = process.env.RUNS?.trim() || `${dir}runs`;
const STTS = ["whisper", "scribe", "gemini"] as const;
type Item = { id: string; category: string; text: string; spoken?: string; alt?: string[]; entities?: Entity[] };
const items = (JSON.parse(readFileSync(`${dir}sentences.json`, "utf8")) as { items: Item[] }).items;

/** Spelling variants of the same speech: not counted as errors. */
const PHRASES: [RegExp, string][] = [
  [/türk lirası/g, "lira"],
  [/katma değer vergisi|k[ae]dev[ei]/g, "ka de ve"],
];
const ALIASES: Record<string, string> = { tl: "lira", avro: "euro", kilogram: "kilo", santimetre: "santim", ila: "ile", kom: "com", professional: "profesyonel" };
/** The reading converter puts "saat" before a time; whether it is said is not a reading error. */
const DROPPED = new Set(["saat"]);

/**
 * Comparison form. In order: the reading converter (digits, times, phones, abbreviations → words),
 * circumflex-free letters ("zekâ" = "zeka"), number words to digits and adjacent digits merged into one
 * number ("kırk sekiz, yirmi yedi" = "dört sekiz iki yedi" = 4827: grouping is a matter of spelling),
 * digits attached to letters split off ("TR4827" = "TR 4827").
 */
function canon(text: string): string[] {
  let spoken = text;
  try {
    spoken = toSpoken(text);
  } catch {
    /* text that cannot be converted is scored as it is */
  }
  // Apostrophes and abbreviation dots do not split a word: "WhatsApp'tan", "T.C." are one word.
  let s = spoken
    .toLocaleLowerCase("tr")
    .replace(/[âîû]/g, (c) => ({ â: "a", î: "i", û: "u" })[c]!)
    .replace(/['’]/g, "")
    .replace(/(?<![\p{L}\p{N}])(\p{L})\.(?=\p{L}(?:\.|(?![\p{L}\p{N}])))/gu, "$1");
  for (const [from, to] of PHRASES) s = s.replace(from, to);
  s = mergeLarge(normalizeTr(s)).replace(/(\p{L})(?=\d)|(\d)(?=\p{L})/gu, "$1$2 ");
  const out: string[] = [];
  for (const raw of s.split(" ").filter(Boolean)) {
    // Dotless ı becomes i last (after number words like "altı", "kırk" are converted): uppercase "IBAN"
    // lowercases to "ıban" in Turkish, while transcription models write "iban".
    const word = (ALIASES[raw] ?? raw).replace(/ı/g, "i");
    if (DROPPED.has(word)) continue;
    if (/^\d+$/.test(word) && /^\d+$/.test(out.at(-1) ?? "")) out[out.length - 1] += word;
    else out.push(word);
  }
  return out;
}

function editDistance(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/* A number word with a suffix ("dokuzda", "yediden", "dörde"): the suffix is dropped for the digit
   comparison. Non-number look-alikes (yüzde, altında, ona) are not touched. */
const STEMS = ["sıfır", "seksen", "doksan", "altmış", "yetmiş", "yirmi", "dokuz", "sekiz", "dört", "dörd", "altı", "yedi", "otuz", "kırk", "elli", "bir", "iki", "beş", "bin", "üç", "on"];
const SUFFIX = /^(?:y?[aeıiuü]|[dt][ae]n?|[dt][ae]ki|[ıiuü]n[dc]?[aeıiuü]?|n?[ıiuü]n|l[ıiuü]k|ş?[ae]r|y?l[ae])$/;
const NOT_NUMBER = new Set(["yüzde", "altında", "altına", "altını", "ona", "onu", "onun", "ondan", "onlar", "biri", "birine", "birini", "bine", "bini", "binde", "ikili", "üçer"]);
function stripNumberSuffix(word: string): string {
  if (NOT_NUMBER.has(word)) return word;
  const stem = STEMS.find((s) => word.startsWith(s) && word.length > s.length && SUFFIX.test(word.slice(s.length)));
  return stem ? (stem === "dörd" ? "dört" : stem) : word;
}

/** Large numbers mixing digits and words: "4 milyon 250 bin" → 4250000. */
function mergeLarge(text: string): string {
  return text
    .replace(/(\d+)\s+bin(?:\s+(\d{1,3}))?(?![\p{L}\p{N}])/gu, (_m, a: string, b?: string) => String(Number(a) * 1000 + Number(b ?? 0)))
    .replace(/(\d+)\s+milyon(?:\s+(\d{1,6}))?(?![\p{L}\p{N}])/gu, (_m, a: string, b?: string) => String(Number(a) * 1_000_000 + Number(b ?? 0)));
}
const digits = (text: string) => digitsOf(mergeLarge(normalizeTr(mergeLarge(text.replace(/(\d)\.(?=\d{3}(?!\d))/g, "$1")))));
/** E-mail addresses and domains are written without Turkish letters; a transcript writing "örnek" is not an error. */
const fold = (text: string) => text.toLocaleLowerCase("tr").replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" })[c]!);

function entityHit(entity: Entity, heard: string): boolean {
  if (entity.type === "email") return fold(spokenEmail(heard)).includes(fold(entity.value));
  if (entity.type === "phone") {
    const words = heard.toLocaleLowerCase("tr").replace(/['’]/g, " ").split(/\s+/).map((w) => stripNumberSuffix(w.replace(/[^\p{L}\p{N}.,]/gu, "")));
    return digits(heard).includes(entity.value) || digits(words.join(" ")).includes(entity.value);
  }
  // Names and brands: whole words; for long names spacing does not count ("Caferağa" = "Cafer ağa", "Hepsiburada'dan").
  const heardWords = canon(heard);
  const words = new Set(heardWords);
  const joined = heardWords.join("");
  const wanted = canon(entity.value);
  return wanted.every((w) => words.has(w)) || (wanted.join("").length >= 5 && joined.includes(wanted.join("")));
}

/** Mixed letter-digit codes and e-mail/web addresses have no single correct reading ("TK yirmi bir kırk altı" /
 *  "iki bin yüz kırk altı"); these categories are left out of the word error rate and scored only on critical information. */
const NO_WER = new Set(["alphanumeric", "email-web"]);

type Score = { errors: number; words: number; entities: number; hits: number; pass: boolean | null };
function score(item: Item, heard: string): Score {
  const refs = [item.spoken ?? item.text, ...(item.alt ?? [])].map(canon);
  const hyp = canon(heard);
  const best = NO_WER.has(item.category)
    ? { errors: 0, words: 0 }
    : refs.map((ref) => ({ errors: editDistance(ref, hyp), words: ref.length })).sort((a, b) => a.errors / a.words - b.errors / b.words)[0];
  const entities = item.entities ?? [];
  const hits = entities.filter((e) => entityHit(e, heard)).length;
  return { ...best, entities: entities.length, hits, pass: entities.length ? hits === entities.length : null };
}

// Audit: the clips of one model counted as errors by one transcription model, in comparison form.
if (process.argv[2] === "errors") {
  const [model, stt, track] = process.argv.slice(3);
  const rows = readFileSync(`${OUT}/transcripts/${stt}.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { model: string; id: string; track: string; text?: string });
  for (const row of rows) {
    const item = items.find((i) => i.id === row.id);
    if (!item || row.model !== model || row.track !== track || row.text === undefined) continue;
    const s = score(item, row.text);
    if (!s.errors && s.pass !== false) continue;
    console.info(`${row.id}: ${s.errors} word errors${s.pass === false ? ", critical information missed" : ""}\n  expected: ${canon(item.spoken ?? item.text).join(" ")}\n  heard   : ${canon(row.text).join(" ")}`);
  }
  process.exit(0);
}

/** model → track → sentence → stt → score */
const table = new Map<string, Map<string, Map<string, Partial<Record<(typeof STTS)[number], Score>>>>>();
const byId = new Map(items.map((i) => [i.id, i]));
for (const stt of STTS) {
  const file = `${OUT}/transcripts/${stt}.jsonl`;
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as { model: string; id: string; track: string; text?: string };
    const item = byId.get(row.id);
    if (!item || row.text === undefined) continue;
    const tracks = table.get(row.model) ?? table.set(row.model, new Map()).get(row.model)!;
    const clips = tracks.get(row.track) ?? tracks.set(row.track, new Map()).get(row.track)!;
    (clips.get(row.id) ?? clips.set(row.id, {}).get(row.id)!)[stt] = score(item, row.text);
  }
}

// Clips that could not be generated: the last generation log line is an error (except running out of credit) and
// there is no audio file (or, without the audio folder, no transcript).
const failed = new Map<string, number>();
if (existsSync(`${OUT}/generation.jsonl`)) {
  const last = new Map<string, string | undefined>();
  for (const line of readFileSync(`${OUT}/generation.jsonl`, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as { model: string; id: string; track: string; error?: string };
    last.set(`${row.model}|${row.track}|${row.id}`, row.error);
  }
  for (const [key, error] of last) {
    const [model, track, id] = key.split("|");
    const item = byId.get(id);
    if (error === undefined || /\b402\b/.test(error) || !item || !table.has(model)) continue;
    const audio = `${OUT}/audio/${model}`;
    if (existsSync(audio) ? readdirSync(audio).some((f) => f.startsWith(`${id}__${track}.`)) : table.get(model)!.get(track)?.has(id)) continue;
    const words = NO_WER.has(item.category) ? 0 : canon(item.spoken ?? item.text).length;
    const entities = item.entities?.length ?? 0;
    const miss: Score = { errors: words, words, entities, hits: 0, pass: entities ? false : null };
    const tracks = table.get(model) ?? table.set(model, new Map()).get(model)!;
    const clips = tracks.get(track) ?? tracks.set(track, new Map()).get(track)!;
    clips.set(id, Object.fromEntries(STTS.map((stt) => [stt, miss])));
    failed.set(`${model}|${track}`, (failed.get(`${model}|${track}`) ?? 0) + 1);
  }
}

function mulberry(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Bootstrap over sentences: 95% interval. */
function interval<T>(rows: T[], stat: (rows: T[]) => number): [number, number] {
  const random = mulberry(20261013);
  const values = Array.from({ length: 1000 }, () => stat(rows.map(() => rows[Math.floor(random() * rows.length)]))).sort((a, b) => a - b);
  return [values[25], values[974]];
}
const pct = (n: number) => Math.round(n * 1000) / 10;

type Row = { id: string; s: Partial<Record<(typeof STTS)[number], Score>> };
// Critical information: correct when at least two transcription models heard all critical information of the sentence.
const passed = (r: Row) => STTS.filter((stt) => r.s[stt]?.pass).length >= 2;
const critical = (rows: Row[]) => rows.filter((r) => STTS.some((stt) => r.s[stt]?.pass != null));
const rate = (list: Row[]) => list.filter(passed).length / Math.max(1, list.length);

const result: Record<string, unknown>[] = [];
for (const [model, tracks] of [...table].sort()) {
  for (const [track, clips] of [...tracks].sort()) {
    const rows: Row[] = [...clips.entries()].map(([id, s]) => ({ id, s }));
    const out: Record<string, unknown> = { model, track, clips: rows.length, failed: failed.get(`${model}|${track}`) ?? 0 };
    for (const stt of STTS) {
      const have = rows.filter((r) => r.s[stt]);
      if (!have.length) continue;
      const wer = (list: typeof have) => list.reduce((n, r) => n + r.s[stt]!.errors, 0) / Math.max(1, list.reduce((n, r) => n + r.s[stt]!.words, 0));
      out[`wer_${stt}`] = pct(wer(have));
      out[`wer_${stt}_ci`] = interval(have, wer).map(pct);
    }
    const crit = critical(rows);
    out.critical_sentences = crit.length;
    out.critical_correct = pct(rate(crit));
    out.critical_ci = interval(crit, rate).map(pct);
    out.critical_at_least_one = pct(crit.filter((r) => STTS.some((stt) => r.s[stt]?.pass)).length / Math.max(1, crit.length));
    // The spoken track covers only sentences with a separate reading: the text track on the same sentences, for a fair comparison.
    if (track === "spoken" && tracks.has("text")) {
      const ids = new Set(crit.map((r) => r.id));
      const same = critical([...tracks.get("text")!.entries()].map(([id, s]) => ({ id, s }))).filter((r) => ids.has(r.id));
      out.text_track_same_sentences = { critical_sentences: same.length, critical_correct: pct(rate(same)) };
    }
    out.missed = crit.filter((r) => !passed(r)).map((r) => r.id);
    const cats: Record<string, string> = {};
    for (const cat of new Set(items.map((i) => i.category))) {
      const list = crit.filter((r) => byId.get(r.id)!.category === cat);
      if (list.length) cats[cat] = `${list.filter(passed).length}/${list.length}`;
    }
    out.by_category = cats;
    result.push(out);
  }
}
writeFileSync(`${OUT}/scores.json`, JSON.stringify(result, null, 1));
console.info("model".padEnd(30) + "track   clips (failed)  word error % (whisper / scribe / gemini)   critical info correct %: majority [CI] · at least one");
for (const r of result) {
  const w = STTS.map((stt) => (r[`wer_${stt}`] === undefined ? "-" : String(r[`wer_${stt}`])).padStart(5)).join(" / ");
  console.info(`${String(r.model).padEnd(30)}${String(r.track).padEnd(8)}${String(r.clips).padStart(4)} (${r.failed})  ${w}              ${String(r.critical_correct).padStart(5)}  [${(r.critical_ci as number[]).join("–")}] · ${r.critical_at_least_one}  (${r.critical_sentences} sentences)`);
}
