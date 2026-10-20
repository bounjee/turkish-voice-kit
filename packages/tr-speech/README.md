# tr-speech

Turkish text normalization for text-to-speech. Your LLM writes `"Randevunuz 3 Ekim 14:30'da, ücreti 1.250 TL."`; your TTS engine should hear `"Randevunuz üç Ekim on dört otuzda, ücreti bin iki yüz elli lira."`.

```ts
import { toSpoken } from "tr-speech";

toSpoken("Kargo 89,90 TL, 750 TL üzeri siparişlerde ücretsiz.");
// "Kargo seksen dokuz lira doksan kuruş, yedi yüz elli lira üzeri siparişlerde ücretsiz."
```

Apply it only to the text you send to TTS. Keep the digits in the transcript your users see.

## Why

TTS engines read Turkish numbers unreliably: a time comes out as "bir dört sıfır sıfır", a phone number digit by digit. Turkish adds a harder problem. The suffix after a number is written for the number's *reading* (`5'e` = "beşe", `4'e` = "dörde", `3'te` = "üçte"). If the suffix does not merge with the spoken stem, the voice says "beş e" as two words.

In our [Turkish TTS benchmark](../../benchmarks/turkish-tts), we gave every model the same 81 sentences twice: once as written, once pre-normalized like this package does. Critical information (prices, phone digits, dates) was read correctly in:

| Model | As written | Pre-normalized |
|---|---|---|
| Gemini 3.8 Flash TTS | 100% | 100% |
| Cartesia Sonic 3.6 | 98.8% | 98.8% |
| ElevenLabs v4 | 98.8% | 100% |
| Antalia-2 Mini | 97.5% | 97.5% |
| Alania-2 | 95.1% | 92.6% |
| EMA Lightning | 93.8% | 93.8% |
| OpenAI gpt-4o-mini-tts | 84.0% | 93.8% |
| Freya tts-1-hd ¹ | 81.3% | 97.9% |
| Trendyol-TTS | 61.7% | 97.5% |
| Anka TTS ¹ | 65.7% | 100% |

¹ Freya: 48 sentences, Anka: 35 (they did not synthesize the whole set).

Normalization fixes most errors of the weaker models. The strongest models already read these sentences well, and one model (Alania-2) did slightly worse with pre-normalized input. Measure with your own TTS before you rely on either.

## What it handles

| Input | Spoken |
|---|---|
| `Randevunuz 24 Ekim Cumartesi, saat 14.30'da.` | `Randevunuz yirmi dört Ekim Cumartesi, saat on dört otuzda.` |
| `Numaranızı 0532 412 33 08 olarak aldım.` | `Numaranızı sıfır beş yüz otuz iki, dört yüz on iki, otuz üç, sıfır sekiz olarak aldım.` |
| `Hafta içi 09:00-18:00 arası açığız.` | `Hafta içi dokuz ile on sekiz arası açığız.` |
| `Sipariş numaranız #48291, 3-5 iş günü içinde kargoda.` | `Sipariş numaranız dört sekiz iki, dokuz bir, üç ile beş iş günü içinde kargoda.` |
| `Adresimiz Atatürk Cad. No:12 D:3, Kat: 2.` | `Adresimiz Atatürk Caddesi numara on iki daire üç, kat iki.` |
| `KVKK'ye uygun şekilde SMS'le bilgi veriyoruz.` | `Ka Ve Ka Ka'ya uygun şekilde Se Me Se'yle bilgi veriyoruz.` |
| `IBAN: TR12 0006 1005 1978 6457 8413 26` | `IBAN, Te Re, bir iki, sıfır sıfır sıfır altı, …` |
| `Bize info@ornek.com.tr adresinden yazabilirsiniz.` | `Bize info et ornek nokta kom nokta tr adresinden yazabilirsiniz.` |

It also handles:

- **Numbers**: cardinals, ordinals (`3. kat` → `üçüncü kat`), decimals (`3,5` → `üç buçuk`), ranges, `3+1`, `7/24` and negatives.
- **Money and percent**: TL, ₺, $, €, £ with kuruş or cent, and percentages. English formats are detected (`1,250.50`, `$12.30`).
- **Dates**: `28.09.2026`, `2026-09-28`, `30.09` and `28.09.26`. Invalid dates are left as they are.
- **Times and ranges**: `14:00'e` → `on dörde`, `09:00-18:00'e kadar` → `dokuzdan on sekize kadar`.
- **Phones**: mobile, landline, `+90`, `0850` and `444` numbers, read in groups.
- **Identifiers**: order numbers and codes are read digit by digit in groups of three. Codes attached to letters (`DW-53AUGY`, `5G`) and runs longer than 12 digits are left alone.
- **Abbreviations**: units (`km`, `m²`, `°C`) and addresses and titles (`Cad.`, `Mah.`, `Dr.`, `Prof.`, `A.Ş.`).
- **Suffixes**: consonant assimilation, vowel harmony, buffer letters and `dört`/`buçuk` softening. Number words matched CLDR exactly (103,803 values) and suffixes were checked with the Zemberek morphological analyzer.
- **Punctuation**: a semicolon becomes a full stop, because streaming TTS starts at a sentence end. A colon followed by a space becomes a comma, because it was read aloud as "iki nokta".

## API

```ts
toSpoken(text, { language = "tr", aliases = DEFAULT_ALIASES })
```

Runs the whole chain. Turkish reading rules apply only when `language` is `"tr"`. In other languages the TTS engine reads digits itself. Aliases apply in every language. `toSpoken(text, "en")` is a shorthand.

Add your brand names to the aliases. Earlier entries run first:

```ts
import { DEFAULT_ALIASES, toSpoken } from "tr-speech";

const aliases = [...DEFAULT_ALIASES, { from: "Dolphy", to: "Dolfi" }];
toSpoken("Dolphy'ye sorun", { aliases }); // "Dolfi'ye sorun" (the suffix follows the new reading)
```

The pieces are exported too: `verbalizeNumbers`, `speakTimes`, `speakPhoneNumbers`, `speakAddresses`, `expandAbbreviations`, `cardinal`, `ordinal`, `attachSuffix` and `withCase`.

### Scoring STT and TTS output

Providers write the same speech differently: "beş yüz kırk bir" or "541". These helpers make a score measure hearing, not spelling:

```ts
import { entityHit, normalizeTr } from "tr-speech";

normalizeTr("Sıfır beş yüz otuz iki, dört yüz on iki."); // "0 532 412"
entityHit({ type: "phone", value: "05324123308" }, "sıfır beş yüz otuz iki, dört yüz on iki, otuz üç, sıfır sekiz"); // true
```

## Streaming

If your LLM streams, a number can be split across chunks (`"1.250 "` + `"TL"`). Run `toSpoken` on whole sentences. [`livekit-voice-guards/examples/agent.ts`](../livekit-voice-guards/examples/agent.ts) shows a small sentence buffer.

## License

MIT
