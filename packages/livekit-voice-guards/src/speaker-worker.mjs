// Voiceprint worker (speaker-embedder.ts). sherpa-onnx `compute()` is synchronous: on the main thread
// it would stall the audio stream for 50-250 ms. Plain JS: the worker needs no TypeScript loader.
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const require = createRequire(import.meta.url);
const sherpa = require("sherpa-onnx-node");

// Two threads: the final transcript was waiting for the voiceprint (28 of 83 utterances, p50 112 ms,
// p90 249 ms); ERes2NetV2 on a 3 s utterance went from 390 to 256 ms (same vector).
const extractors = workerData.models.map(
  (model) => new sherpa.SpeakerEmbeddingExtractor({ model, numThreads: 2, debug: false }),
);

function unit(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

// Warm-up: the first voiceprint took 1,698 ms cold (later ones 127-524 ms). Before reporting ready,
// each model runs once on 1 s of quiet noise, so the first real utterance meets a warm model.
const warm = Float32Array.from({ length: 16000 }, () => (Math.random() - 0.5) * 0.01);
for (const ex of extractors) {
  const stream = ex.createStream();
  stream.acceptWaveform({ samples: warm, sampleRate: 16000 });
  stream.inputFinished();
  ex.compute(stream, false);
}

parentPort.postMessage({ ready: true });

parentPort.on("message", ({ id, samples }) => {
  try {
    const started = performance.now();
    // Fusion: the models' unit vectors side by side, divided by √n (cosine = mean cosine).
    const parts = extractors.map((ex) => {
      const stream = ex.createStream();
      stream.acceptWaveform({ samples, sampleRate: 16000 });
      stream.inputFinished();
      // false: a copy, not an array backed by native memory (it is posted to the main thread).
      return unit(Float32Array.from(ex.compute(stream, false)));
    });
    const vec = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      for (let i = 0; i < p.length; i++) vec[o + i] = p[i] / Math.sqrt(parts.length);
      o += p.length;
    }
    parentPort.postMessage({ id, vec, ms: Math.round(performance.now() - started) }, [vec.buffer]);
  } catch (err) {
    parentPort.postMessage({ id, error: String(err) });
  }
});
