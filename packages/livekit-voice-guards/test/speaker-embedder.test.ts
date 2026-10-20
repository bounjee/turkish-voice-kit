import assert from "node:assert/strict";
import { test } from "node:test";
import { SpeakerEmbedder } from "../src/speaker-embedder.ts";

/** Becomes ready but returns every voiceprint after `ms` (a loaded CPU at call start). */
function slowWorker(ms: number): URL {
  const code = `import { parentPort } from "node:worker_threads";
parentPort.postMessage({ ready: true });
parentPort.on("message", ({ id }) => setTimeout(() => parentPort.postMessage({ id, vec: new Float32Array([1, 0]), ms: ${ms} }), ${ms}));`;
  return new URL(`data:text/javascript,${encodeURIComponent(code)}`);
}

test("a voiceprint later than 2 s is not dropped (otherwise the first utterance misses the profile)", async () => {
  const embedder = new SpeakerEmbedder([], slowWorker(2_100));
  embedder.start();
  while (embedder.loading) await new Promise((r) => setTimeout(r, 5));
  const r = await embedder.embed(new Float32Array(16_000));
  embedder.close();
  assert.deepEqual(r && Array.from(r.vec), [1, 0]);
});
