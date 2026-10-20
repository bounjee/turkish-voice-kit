import assert from "node:assert/strict";
import { test } from "node:test";
import { AudioFrame } from "@livekit/rtc-node";
import { LEAD_TRIM, LeadTrim } from "../src/lead-trim.ts";

const RATE = 24_000;
const ms = (n: number) => Math.round((RATE * n) / 1000);
/** Room tone around −60 dBFS, then speech level (−12 dBFS). */
const QUIET = 33;
const LOUD = 8_000;

function frame(samples: number[]): AudioFrame {
  return new AudioFrame(Int16Array.from(samples), RATE, 1, samples.length);
}
/** `quietMs` quiet, then `loudMs` loud; 100 ms frames (the plugin default). */
function speech(quietMs: number, loudMs: number, frameMs = 100): AudioFrame[] {
  const all = [...Array(ms(quietMs)).fill(QUIET), ...Array(ms(loudMs)).fill(LOUD)];
  const out: AudioFrame[] = [];
  for (let i = 0; i < all.length; i += ms(frameMs)) out.push(frame(all.slice(i, i + ms(frameMs))));
  return out;
}
function run(frames: AudioFrame[]): { out: AudioFrame[]; trim: LeadTrim } {
  const trim = new LeadTrim();
  const out = frames.flatMap((f) => trim.push(f));
  return { out: [...out, ...trim.end()], trim };
}
const samplesOf = (frames: AudioFrame[]) => frames.reduce((n, f) => n + f.samplesPerChannel, 0);

test("the quiet start is dropped, a pre-roll stays before the speech", () => {
  const frames = speech(130, 270);
  const { out, trim } = run(frames);
  // 40 ms (the pre-roll) of the 130 ms quiet part stays.
  assert.equal(samplesOf(out), samplesOf(frames) - ms(130 - LEAD_TRIM.PREROLL_MS));
  assert.equal(trim.trimmedMs, 130 - LEAD_TRIM.PREROLL_MS);
  const first = out[0]!.data;
  // Speech starts right after the pre-roll; no audio is lost.
  assert.equal(first[ms(LEAD_TRIM.PREROLL_MS)], LOUD);
  assert.equal(first.at(-1), LOUD);
});

test("no frame comes out until the threshold is passed, then frames pass unchanged", () => {
  const trim = new LeadTrim();
  const [a, b, c, d] = speech(150, 250);
  assert.deepEqual(trim.push(a!), []);
  const second = trim.push(b!);
  assert.equal(second.length, 1);
  assert.equal(trim.push(c!)[0], c);
  assert.equal(trim.push(d!)[0], d);
  assert.deepEqual(trim.end(), []);
});

test("trimmed audio fades in (no click)", () => {
  const { out } = run([frame([...Array(ms(200)).fill(QUIET), ...Array(ms(200)).fill(LOUD)])]);
  const data = out[0]!.data;
  assert.ok(data[0]! < QUIET);
  assert.equal(data[ms(LEAD_TRIM.FADE_IN_MS) + 1], QUIET);
});

test("speech starting within the pre-roll plays unchanged", () => {
  const frames = speech(20, 200, 20);
  const { out } = run(frames);
  assert.equal(samplesOf(out), samplesOf(frames));
  assert.equal(out[0]!.data[0], QUIET);
});

test("speech loud from the start loses nothing", () => {
  const frames = speech(0, 300);
  const { out, trim } = run(frames);
  assert.equal(samplesOf(out), samplesOf(frames));
  assert.equal(trim.trimmedMs, 0);
});

test("if the threshold is not passed within the maximum wait, held audio plays unchanged", () => {
  const frames = speech(LEAD_TRIM.MAX_MS + 100, 0);
  const { out } = run(frames);
  assert.equal(samplesOf(out), samplesOf(frames));
});

test("if the utterance ends before the threshold, held audio is not dropped", () => {
  const frames = speech(120, 0);
  const { out } = run(frames);
  assert.equal(samplesOf(out), samplesOf(frames));
});

test("the same trim with 20 ms frames", () => {
  const frames = speech(130, 270, 20);
  const { out, trim } = run(frames);
  assert.equal(trim.trimmedMs, 130 - LEAD_TRIM.PREROLL_MS);
  assert.equal(samplesOf(out), samplesOf(frames) - ms(130 - LEAD_TRIM.PREROLL_MS));
});
