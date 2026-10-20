/**
 * Turkish text normalization for speech-recognition scoring: lowercase, no punctuation, number words
 * as digits. Providers write the same speech differently ("beş yüz kırk bir" / "541"); both sides go
 * through this so that a score measures hearing, not spelling.
 */
const ONES: Record<string, number> = {
  sıfır: 0, bir: 1, iki: 2, üç: 3, dört: 4, beş: 5, altı: 6, yedi: 7, sekiz: 8, dokuz: 9,
};
const TENS: Record<string, number> = {
  on: 10, yirmi: 20, otuz: 30, kırk: 40, elli: 50, altmış: 60, yetmiş: 70, seksen: 80, doksan: 90,
};

function isNumberWord(word: string): boolean {
  return word in ONES || word in TENS || word === "yüz" || word === "bin";
}

/** One number from consecutive number words ("yüz yirmi üç bin dört yüz elli altı" → 123456). */
function wordsToNumber(words: string[]): number {
  let total = 0;
  let current = 0;
  for (const word of words) {
    if (word in ONES) current += ONES[word];
    else if (word in TENS) current += TENS[word];
    else if (word === "yüz") current = (current || 1) * 100;
    else if (word === "bin") {
      total += (current || 1) * 1000;
      current = 0;
    }
  }
  return total + current;
}

/** Punctuation is a group boundary: "doksan, beş yüz" is two numbers. */
const SEP = "|";

export function normalizeTr(text: string): string {
  const words = text
    .toLocaleLowerCase("tr")
    .replace(/[.,;:!?]+/g, ` ${SEP} `)
    .replace(/[^\p{L}\p{N}\s|]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  let run: string[] = [];
  /* A spoken digit group must not merge with the start of the next group: "doksan dört altmış altı"
     is two numbers. A tens word after a filled ones place starts a new number. */
  const flush = () => {
    if (run.length) out.push(String(wordsToNumber(run)));
    run = [];
  };
  for (const word of words) {
    if (word === SEP) {
      flush();
      continue;
    }
    if (!isNumberWord(word)) {
      flush();
      out.push(word);
      continue;
    }
    // "doksan beş yüz": "ones + yüz" after a tens word is a new number.
    const sinceThousand = run.slice(run.lastIndexOf("bin") + 1);
    if (word === "yüz" && sinceThousand.length >= 2 && run[run.length - 1] in ONES && sinceThousand.some((w) => w in TENS)) {
      const ones = run.pop()!;
      flush();
      run = [ones, word];
      continue;
    }
    const last = run[run.length - 1];
    const startsNew =
      last !== undefined &&
      ((word in TENS && (last in ONES || last in TENS)) ||
        (word in ONES && (last in ONES || last === "sıfır")) ||
        (word === "yüz" && (last in TENS || last === "yüz")) ||
        last === "sıfır");
    if (startsNew) flush();
    run.push(word);
  }
  flush();
  return out.join(" ");
}

export function digitsOf(text: string): string {
  return text.replace(/\D/g, "");
}

/** "cahit nokta aybar et ornek nokta com" → "cahit.aybar@ornek.com". */
export function spokenEmail(text: string): string {
  return text
    .toLocaleLowerCase("tr")
    .replace(/\s*\b(nokta|dot)\b\s*/g, ".")
    .replace(/\s*\b(et|at)\b\s*/g, "@")
    .replace(/[\s,]/g, "")
    .replace(/\.$/, "");
}

export type Entity = { type: "name" | "phone" | "email"; value: string };

/** Is the expected value in the heard text: a name as whole words, a phone as digits, an e-mail in written form. */
export function entityHit(entity: Entity, heard: string): boolean {
  if (entity.type === "phone") return digitsOf(normalizeTr(heard)).includes(entity.value);
  if (entity.type === "email") return spokenEmail(heard).includes(entity.value);
  const words = new Set(normalizeTr(heard).split(" "));
  return normalizeTr(entity.value).split(" ").every((w) => words.has(w));
}
