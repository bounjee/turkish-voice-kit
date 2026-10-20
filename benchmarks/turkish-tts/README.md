# Turkish TTS benchmark

How well do text-to-speech models read what a Turkish voice assistant actually says: prices, phone numbers, dates, e-mail addresses, abbreviations and brand names? Most published Turkish TTS comparisons use everyday sentences without digits, yet these are exactly the sentences that break a voice assistant.

The test is independent of the providers: no partnership and no sponsorship. Every model got the same sentences in the same way. Dolphy uses Cartesia in production.

- **189 sentences in 15 categories** ([`sentences.json`](sentences.json)). The distribution follows 1,157 assistant sentences from 111 real calls, with hard categories over-represented. All names, numbers and addresses are made up.
- **10 models.** API: Cartesia Sonic 3.6, ElevenLabs v4, Gemini 3.8 Flash TTS, OpenAI gpt-4o-mini-tts, Alania-2 and Freya tts-1-hd. Local open models: Antalia-2 Mini, EMA Lightning, Trendyol-TTS and Anka TTS.
- **3 transcription models** (Whisper large-v3, ElevenLabs Scribe v2, Gemini 3.5 Transcribe) listen to every clip. A sentence counts as correct when at least two of them heard all of its critical information. One transcription model's hearing error does not punish the TTS model.
- **Two inputs per sentence** where it matters: the text as an LLM writes it (`1.490 TL`), and the same sentence pre-normalized (`bin dört yüz doksan lira`), as [`tr-speech`](../../packages/tr-speech) does.

Run on 2026-10-13. The overall ranking in the [blog post](https://dolphydesk.com/blog/turkce-text-to-speech-karsilastirmasi) combines this machine score with a blind listening test for naturalness. The listening ratings are not part of this repository; [`listen.ts`](listen.ts) is the page we used, so you can run your own.

## Results: reading correctly

Critical information is the sentence's numbers, names, brands and e-mail addresses. The input is the text as written. The 95% confidence interval comes from bootstrap resampling over sentences. Full data: [`results/scores.json`](results/scores.json); the transcripts behind it are in [`results/transcripts/`](results/transcripts).

| Model | Critical info correct | Sentences | Word error % (Whisper / Scribe / Gemini) | Same sentences: as written → pre-normalized |
|---|---|---|---|---|
| Gemini 3.8 Flash TTS | 99.1% (97.4–100) | 116 | 3.2 / 1.5 / 0.9 | 100% → 100% (81) |
| Cartesia Sonic 3.6 | 98.3% (95.7–100) | 116 | 5.3 / 1.8 / 1.6 | 98.8% → 98.8% (81) |
| ElevenLabs v4 | 96.6% (93.1–99.1) | 116 | 4.1 / 1.1 / 1.3 | 98.8% → 100% (81) |
| Antalia-2 Mini | 94.0% (88.8–97.4) | 116 | 3.3 / 0.7 / 1.0 | 97.5% → 97.5% (81) |
| Alania-2 | 92.2% (87.1–97.4) | 116 | 3.1 / 1.3 / 1.4 | 95.1% → 92.6% (81) |
| EMA Lightning | 89.7% (84.5–94.8) | 116 | 6.3 / 4.5 / 3.5 | 93.8% → 93.8% (81) |
| OpenAI gpt-4o-mini-tts | 87.1% (81.0–93.1) | 116 | 12.1 / 4.7 / 3.8 | 84.0% → 93.8% (81) |
| Freya tts-1-hd ¹ | 82.4% (70.6–92.2) | 51 | 7.9 / 6.8 / 3.1 | 81.3% → 97.9% (48) |
| Trendyol-TTS ² | 69.8% (62.1–78.4) | 116 | 19.3 / 22.3 / 12.2 | 61.7% → 97.5% (81) |
| Anka TTS ¹ | 66.0% (53.2–78.7) | 47 | 8.6 / 6.2 / 2.6 | 65.7% → 100% (35) |

¹ Freya (credit ran out) and Anka TTS synthesized only part of the set. Their scores cover the clips they produced.
² Trendyol-TTS failed on 7 sentences. Those count as misread.

What stands out:

- The top three are within each other's confidence intervals.
- Several Turkish-focused models read the critical information almost as well as the large models.
- Pre-normalizing the text closes most of the gap for the weaker models. Trendyol-TTS goes from 61.7% to 97.5% and Anka TTS from 65.7% to 100%. For these models, most errors came from reading numbers.

## Run it yourself

```bash
cp .env.example .env               # add the keys of the providers you test
npx tsx generate.ts try            # one sentence per model, to check keys
npx tsx generate.ts generate       # PAID: ~14,700 characters per model
.venv-small/bin/python generate_local.py generate ema-lightning   # local models, see the script header
npx tsx generate.ts transcribe whisper    # PAID: ~20 min of audio per model, per STT
npx tsx generate.ts transcribe scribe
npx tsx generate.ts transcribe gemini
npx tsx score.ts                   # free: table + runs/scores.json
npx tsx score.ts errors openai-gpt-4o-mini-tts gemini text   # what was counted as wrong, and why
npx tsx listen.ts                  # blind listening page at http://localhost:4477
```

Every step resumes where it stopped. `ffmpeg` must be installed. Outputs go to `runs/` (git-ignored).

To check our numbers without any API calls, score the published transcripts. `RUNS=results npx tsx score.ts` rewrites `results/scores.json` and produces the same file.

To add a model, add an entry to `MODELS` in `generate.ts` (any function that returns audio for a text) and run the same steps.

## How the score works

- **Comparison form.** Both the expected reading and the heard transcript go through the same converter (`toSpoken` from `tr-speech`), then lowercase, number words to digits and adjacent digits merged. "1.490 TL", "bin dört yüz doksan lira" and "1490 lira" count the same. The score measures what was said, not how it was spelled.
- **Critical information.** Phone numbers are matched as digits (a suffix like "dokuzda" is stripped). Names and brands are matched as whole words, ignoring spacing for long names ("Caferağa" = "Cafer ağa"). E-mail addresses are matched in written form, without Turkish letters.
- **No single correct reading.** Alphanumeric codes and e-mail or web addresses ("TK 2146") are left out of the word error rate and scored only on critical information.
- **Upper bound.** "At least one" (in the JSON) counts a sentence as correct if any transcription model heard it right. A transcription model can repair a wrong reading by itself, so this rate overstates quality.
- **Not measured.** Latency was not measured: requests went from a laptop to each provider, so the timings in `generation.jsonl` are not comparable.

## Limitations

- One run per model, one voice per model (each provider's Turkish female voice), default settings.
- Providers update their models; these results are a snapshot from October 2026.
- Machine scoring checks *what* was said, not *how* it sounded. Use blind listening for naturalness.

## License

Sentence set and results: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Scripts: MIT. Anka TTS weights are CC-BY-NC; we used them for testing only.
