import assert from "node:assert/strict";
import { test } from "node:test";
import { boundPrediction, fallbackEndOfTurn, turnThreshold, warmPrediction } from "../src/turn-timeout.ts";

const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

test("a prediction in time is returned unchanged", async () => {
  assert.equal(await boundPrediction(later(5, 0.8), 200, () => {}), 0.8);
});

test("a prediction not in time fails; when it arrives late its duration is reported", async () => {
  let lateMs: number | undefined;
  const lateSeen = new Promise<void>((resolve) => {
    const started = Date.now();
    void boundPrediction(later(80, 0.8), 20, (ms) => {
      lateMs = ms;
      resolve();
    }).then(
      () => assert.fail("no value after the timeout"),
      (error: Error) => {
        assert.match(error.message, /20 ms/);
        assert.ok(Date.now() - started < 70, "the turn must be released before the prediction arrives");
      },
    );
  });
  await lateSeen;
  assert.ok(lateMs !== undefined && lateMs >= 70);
});

test("a prediction error in time is passed through", async () => {
  await assert.rejects(boundPrediction(Promise.reject(new Error("inference failed")), 200, () => {}), /inference failed/);
});

test("a prediction failing after the timeout leaves no unhandled rejection", async () => {
  const failing = new Promise<number>((_, reject) => setTimeout(() => reject(new Error("failed late")), 30));
  await assert.rejects(boundPrediction(failing, 10, () => {}), /10 ms/);
  await later(40, null); // node:test would fail here on an unhandled rejection
});

/* Turkish end-of-turn threshold: in eight test calls unfinished sentences scored at most 0.0064
   ("Hayır da."), finished ones at least 0.032. */
test("in Turkish an unfinished sentence stays below the threshold, a finished one above", () => {
  const tr = turnThreshold("tr", 0.0045);
  assert.ok(tr !== undefined && 0.0064 < tr && tr < 0.032);
  assert.equal(turnThreshold("tr-TR", 0.0045), tr);
});

test("languages without a measurement keep LiveKit's threshold", () => {
  assert.equal(turnThreshold("en", 0.0289), 0.0289);
  assert.equal(turnThreshold(undefined, undefined), undefined);
});

test("warm-up logs its duration", async () => {
  const logs: string[] = [];
  await warmPrediction(() => later(20, 0.5), (message) => logs.push(message));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^turn model warmed up: \d+ ms$/);
});

test("a warm-up error does not break the call; it is logged", async () => {
  const logs: string[] = [];
  await warmPrediction(() => Promise.reject(new Error("no executor")), (message) => logs.push(message));
  assert.deepEqual(logs, ["turn model warm-up failed: no executor"]);
});

test("punctuation end-of-turn rule while the inference process is dead", () => {
  assert.equal(fallbackEndOfTurn("Fiyatlarınız nedir?"), 1);
  assert.equal(fallbackEndOfTurn("Evet, isterim."), 1);
  assert.equal(fallbackEndOfTurn("Ahmet"), 0);
});
