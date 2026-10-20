import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { checkInference, createInferenceWatch, inferenceState } from "../src/inference-health.ts";

/* A dead inference process: LiveKit does not restart it, and the health endpoint says 503 "inference
   process not running". The 503 returned while the LiveKit connection is down is something else. */
test("the health endpoint response maps to the inference process state", () => {
  assert.equal(inferenceState(200, "OK"), "ok");
  assert.equal(inferenceState(503, "inference process not running"), "dead");
  assert.equal(inferenceState(503, "not connected to livekit"), "unknown");
});

test("an unreachable health endpoint means unknown (dev mode, random port)", async () => {
  assert.equal(await checkInference("http://127.0.0.1:9/"), "unknown");
});

test("reads a real health endpoint", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(503);
    res.end("inference process not running");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    assert.equal(await checkInference(`http://127.0.0.1:${port}/`), "dead");
  } finally {
    server.close();
  }
});

test("watchdog: with a dead process it restarts when no call runs, otherwise after the call", async () => {
  let t = 0;
  let restarts = 0;
  const warnings: number[] = [];
  const watch = createInferenceWatch({
    check: async () => "dead",
    onRestart: () => restarts++,
    onDeadDuringCall: (n) => warnings.push(n),
    everyMs: 30_000,
    now: () => t,
  });
  let active = 1;
  await watch(() => active);
  assert.deepEqual([restarts, warnings], [0, [1]]);
  t += 10_000;
  active = 0;
  await watch(() => active);
  assert.equal(restarts, 0, "does not check again before the interval");
  t += 30_000;
  await watch(() => active);
  assert.equal(restarts, 1);
});

test("watchdog: does nothing with a healthy process", async () => {
  let restarts = 0;
  const watch = createInferenceWatch({ check: async () => "ok", onRestart: () => restarts++, now: () => 0 });
  await watch(() => 0);
  assert.equal(restarts, 0);
});
