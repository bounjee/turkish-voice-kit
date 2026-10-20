import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_HOLD, holdVerdict } from "../src/background-hold.ts";

/* Outbound call with a TV: callee at −18 dBFS, TV at −26…−30. The ready reply waited 16 s; the rule
   must release it at 1.5 s. */
test("sound clearly quieter than the caller counts as background at 1.5 s", () => {
  assert.equal(holdVerdict({ activityMs: 1_500, levelDb: -26, turnDb: -18 }), "background");
  assert.equal(holdVerdict({ activityMs: 1_400, levelDb: -26, turnDb: -18 }), "wait");
});

test("the caller still speaking at their own level is waited for", () => {
  assert.equal(holdVerdict({ activityMs: 4_000, levelDb: -20, turnDb: -18 }), "wait");
  assert.equal(holdVerdict({ activityMs: 4_000, levelDb: -23, turnDb: -18 }), "wait");
});

test("without a known caller level it waits longer", () => {
  assert.equal(holdVerdict({ activityMs: 4_000, levelDb: -30, turnDb: null }), "wait");
  assert.equal(holdVerdict({ activityMs: BACKGROUND_HOLD.BLIND_MS, levelDb: -30, turnDb: null }), "background");
});

test("even sound at the caller's level stops holding the reply after the cap", () => {
  assert.equal(holdVerdict({ activityMs: BACKGROUND_HOLD.CAP_MS - 1, levelDb: -18, turnDb: -18 }), "wait");
  assert.equal(holdVerdict({ activityMs: BACKGROUND_HOLD.CAP_MS, levelDb: -18, turnDb: -18 }), "background");
});
