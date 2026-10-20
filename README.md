# Turkish Voice Kit

Open-source pieces of the voice agent behind [Dolphy](https://dolphydesk.com), an AI customer assistant that answers Turkish-speaking customers on the web and on the phone. Every rule here was added after a real call went wrong, and the code comments say what happened and what was measured.

| Folder | What it is |
|---|---|
| [`packages/tr-speech`](packages/tr-speech) | Turkish text normalization for TTS. Prices, dates, times, phone numbers, IBANs, e-mails and abbreviations are written out the way they are spoken, with the correct suffix: `"14:00'e"` → `"on dörde"`, `"1.250 TL'ye"` → `"bin iki yüz elli liraya"`. Also includes STT scoring helpers. No dependencies. |
| [`packages/livekit-voice-guards`](packages/livekit-voice-guards) | Fixes for [LiveKit Agents](https://github.com/livekit/agents-js) (JS) voice pipelines: Gemini Live STT, a level gate in front of the VAD, echo and background-fragment filters, a participant (speaker) filter, TTS lead trim, a time limit on end-of-turn prediction and a watchdog for a dead inference process. |
| [`benchmarks/turkish-tts`](benchmarks/turkish-tts) | Independent Turkish TTS benchmark: 189 sentences a voice assistant actually says, 10 models, 3 transcription models and reproducible scoring. |

```bash
npm install
npm test          # 112 unit tests
npm run typecheck
```

Requires Node 22+. The packages ship as TypeScript source and are not on npm yet. Run them with `tsx`, or copy the file you need: most modules are a single file.

## Why these pieces

Turkish is a hard language for voice AI. Suffixes attach to numbers (`3'te`, `5'e`, `2026'daki`) and must follow how the number is *read*, not how it is written. Most TTS engines still read `14:00` digit by digit. On real phone lines, TVs, children and echo end up in the transcript. We could not find open code for these problems, so we are sharing ours.

## Türkçe özet

[Dolphy](https://dolphydesk.com)'nin canlıda çalışan sesli asistanından açık kaynak parçalar:

- **`tr-speech`**: Seslendirilecek metindeki fiyat, tarih, saat, telefon numarası, IBAN, e-posta ve kısaltmaları Türkçe okunuşa çevirir, ekleri okunuşa uydurur (`"14:00'e"` → `"on dörde"`). Konuşma tanıma ölçümü için normalleştirme de içerir.
- **`livekit-voice-guards`**: LiveKit Agents (JS) için Gemini Live konuşma tanıma eklentisi ve gerçek görüşmelerden çıkan düzeltmeler. Kısık ve uzak sesi eleyen düzey kapısı, yankı ve arka plan sesi süzgeçleri, arkadaki kişiyi ayıran katılımcı süzgeci ve tur modeli için süre sınırı bunların arasında.
- **`turkish-tts`**: Bağımsız Türkçe TTS kıyası. Bir sesli asistanın gün içinde söylediği 189 cümle, 10 model ve tekrar koşulabilen puanlama. Sonuçların yazısı: [Türkçeyi en iyi konuşan ses modelleri](https://dolphydesk.com/blog/turkce-text-to-speech-karsilastirmasi).

Kodun açıklamaları İngilizce; Türkçe kurallar ve örnek cümleler olduğu gibi duruyor.

## License

Code: [MIT](LICENSE). Benchmark sentence set and results (`benchmarks/turkish-tts/sentences.json`, `benchmarks/turkish-tts/results/`): [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
