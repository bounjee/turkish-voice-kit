"""Turkish TTS benchmark: the open models that run locally. API models are in `generate.ts`.

Each model runs in its own Python environment:

    uv venv --python 3.12 .venv-small && uv pip install --python .venv-small ema-lightning antalia-mini soundfile
    uv venv --python 3.12 .venv-anka && uv pip install --python .venv-anka "anka-tts[tts]" soundfile
    uv venv --python 3.12 .venv-trendyol && uv pip install --python .venv-trendyol voxcpm soundfile

    .venv-small/bin/python generate_local.py try ema-lightning
    .venv-small/bin/python generate_local.py generate antalia-2-mini   # the whole set → runs/audio/<model>/<id>__<text|spoken>.wav

`generate` resumes where it stopped (existing files are skipped); timings go to `runs/generation.jsonl`.
Free. Timings are this machine's (we used an Apple M4; Anka and Trendyol-TTS run on MPS) and are not
comparable with the API models. Anka TTS weights are CC-BY-NC: test use only.
"""

import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "runs"


def ema_lightning():
    from ema_lightning import EMA

    tts = EMA()
    return lambda text, path: tts.say(text, path=str(path))


def antalia_2_mini():
    from antalia_mini import Antalia

    tts = Antalia()
    return lambda text, path: tts.say(text, path=str(path), seed=0)


def anka_tts():
    from anka import AnkaTTS

    tts = AnkaTTS.from_pretrained("anka-tts/v0.1", device="mps")
    return lambda text, path: tts.save_wav(tts.synthesize(text, voice="female"), str(path))


def trendyol_tts():
    import soundfile as sf
    from voxcpm.core import VoxCPM

    # Settings from the model card; optimize (torch.compile) is off on MPS.
    model = VoxCPM.from_pretrained(hf_model_id="Trendyol/Trendyol-TTS", load_denoiser=False, optimize=False)

    def speak(text, path):
        audio = model.generate(text=text, cfg_value=2.0, inference_timesteps=16, max_len=4096, normalize=True, denoise=False)
        sf.write(str(path), audio, model.tts_model.sample_rate)

    return speak


MODELS = {"ema-lightning": ema_lightning, "antalia-2-mini": antalia_2_mini, "anka-tts": anka_tts, "trendyol-tts": trendyol_tts}


def clips():
    """Every sentence as written; if it has a separate spoken form, that too (bypasses the model's own number reading)."""
    items = json.loads((HERE / "sentences.json").read_text(encoding="utf-8"))["items"]
    for item in items:
        yield item["id"], "text", item["text"]
    for item in items:
        if item.get("spoken"):
            yield item["id"], "spoken", item["spoken"]


if __name__ == "__main__":
    mode, name = (sys.argv[1:3] + ["", ""])[:2]
    if mode not in ("try", "generate") or name not in MODELS:
        sys.exit(f"usage: python generate_local.py <try|generate> <{'|'.join(MODELS)}>")
    speak = MODELS[name]()
    if mode == "try":
        out = OUT / "try"
        out.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        speak("Başlangıç paketi aylık 1.490 TL, KDV dahil.", out / f"{name}.wav")
        print(f"{name}: {time.time() - t0:.1f} s")
    else:
        out = OUT / "audio" / name
        out.mkdir(parents=True, exist_ok=True)
        done = 0
        with (OUT / "generation.jsonl").open("a", encoding="utf-8") as log:
            for item_id, track, text in clips():
                path = out / f"{item_id}__{track}.wav"
                if path.exists():
                    continue
                row = {"model": name, "id": item_id, "track": track, "chars": len(text)}
                try:
                    t0 = time.time()
                    speak(text, path)
                    row["total"] = round((time.time() - t0) * 1000)
                    done += 1
                except Exception as err:  # if one sentence fails the run continues and the error is logged
                    row["error"] = repr(err)[:240]
                log.write(json.dumps(row, ensure_ascii=False) + "\n")
                log.flush()
        print(f"{name}: {done} new clips, {len(list(out.glob('*.wav')))} in folder")
