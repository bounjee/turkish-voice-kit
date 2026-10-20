/**
 * Echo and background-fragment filters.
 *
 * ECHO: in the iOS in-app browser the agent's voice came back into the microphone ~560 ms later, the
 * STT transcribed it ("Fiyat bilgisi") and it counted as the user's speech. Pipecat, LiveKit, Vapi
 * and Retell leave echo to the client's AEC; Deepgram's barge-in guide suggests comparing the
 * transcript with the TTS text just spoken and dropping a match. That is the rule here: the final
 * transcript of speech that STARTED while the agent was speaking is echo if it is a run of
 * consecutive words from the text spoken in the last 10 s. It does not depend on the delay; it does
 * not replace server-side AEC.
 *
 * BACKGROUND FRAGMENT: while the agent was silent, single words ~20 dB below the caller ("göz",
 * "dakikası") opened turns. LiveKit's `minWords`/`minDuration` apply only to interruptions, not to
 * opening a new turn. Short + quiet + no question pending = fragment.
 */

/** Short history of the text sent to TTS (every pushed piece, fillers included). */
export class SpokenLog {
  #items: { text: string; at: number }[] = [];

  constructor(private readonly windowMs = 10_000) {}

  add(text: string, at = Date.now()): void {
    if (text.trim()) this.#items.push({ text, at });
    this.#prune(at);
  }

  recent(now = Date.now()): string {
    this.#prune(now);
    return this.#items.map((item) => item.text).join(" ");
  }

  #prune(now: number): void {
    while (this.#items.length && now - this.#items[0].at > this.windowMs) this.#items.shift();
  }
}

/**
 * Numbers and currency words are left out of the comparison: the STT may write a number in the echo
 * with digits ("3.500 lira") while the log holds its spoken form ("üç bin beş yüz") or the LLM's raw
 * text ("₺3.500"). Digits are always ignored; these are the Turkish number and currency words.
 */
export const ECHO_IGNORED_WORDS: ReadonlySet<string> = new Set([
  "sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz", "on", "yirmi", "otuz",
  "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan", "yüz", "bin", "milyon", "milyar", "buçuk",
  "yüzde", "lira", "tl", "kuruş", "dolar", "euro", "avro",
]);

/** Expression tags some TTS models take inline (`[warm]`, `[slow]`); they are never heard. */
const VOICE_TAG = /\[[a-z][a-z _-]{1,24}\]\s*/gi;

function words(text: string, ignored: ReadonlySet<string>): string[] {
  return (text.replace(VOICE_TAG, "").toLocaleLowerCase("tr").match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (word) => !/^\p{N}/u.test(word) && !ignored.has(word),
  );
}

/** Same word, or one is the start of the other ("bilgisi" / "bilgisine"): the echo may lose a suffix. */
function sameWord(a: string, b: string): boolean {
  return a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)));
}

/** Is the final transcript a consecutive run (at least two words) of the text the agent just spoke? */
export function isEchoOf(heard: string, spoken: string, ignored: ReadonlySet<string> = ECHO_IGNORED_WORDS): boolean {
  const h = words(heard, ignored);
  const s = words(spoken, ignored);
  if (h.length < 2 || s.length < h.length) return false;
  for (let i = 0; i + h.length <= s.length; i++) {
    if (h.every((word, j) => sameWord(word, s[i + j]))) return true;
  }
  return false;
}

/** "Quiet" means this far below the caller's own level (the level gate's `ACCEPT_WITHIN_DB`). */
const QUIET_BELOW_CALLER_DB = 10;

/**
 * Is a short utterance a background fragment? All three: at most two words; quiet (the gate was open
 * for less than 300 ms so no level was measured, or 10 dB below the caller's level); the agent's last
 * heard sentence was not a question (a "yes", a name or a number answering a question always
 * passes). For speech that started while the agent was speaking there is no question exception: the
 * agent has moved on to a new reply, its earlier question was answered (shouting in the background
 * interrupted the agent).
 */
export function isQuietFragment(input: {
  text: string;
  /** Utterance level (`LevelGate.endUtterance`); `null` = the gate was open for less than 300 ms. */
  levelDb: number | null;
  /** The caller's known speaking level; `null` if not known yet. */
  callerDb: number | null;
  /** The agent's last heard reply (the heard part, if it was interrupted). */
  lastAssistant: string;
  /** The utterance started while the agent was speaking. */
  overAgent?: boolean;
}): boolean {
  if (words(input.text, ECHO_IGNORED_WORDS).length > 2) return false;
  if (!input.overAgent && input.lastAssistant.trim().endsWith("?")) return false;
  if (input.levelDb === null) return true;
  return input.callerDb !== null && input.levelDb < input.callerDb - QUIET_BELOW_CALLER_DB;
}
