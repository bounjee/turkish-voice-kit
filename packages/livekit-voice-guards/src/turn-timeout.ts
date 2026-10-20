/**
 * Time limit for the end-of-turn model's prediction. LiveKit's text turn detector
 * (`MultilingualModel`) runs inference in a separate process, and the JS version waits for it WITHOUT
 * a limit: in a live test the prediction after the caller gave their name did not arrive for 11.7 s; the reply
 * was ready but the caller sat in silence and hung up. In our logs final transcript → reply took
 * p50 0.4 s, p95 1.3 s, with a tail of 1.8-5.4 s. When the limit passes the prediction fails, the
 * framework continues without one (minimum endpointing delay) and the turn ends.
 */
export const EOT_TIMEOUT_MS = 1_500;

/** The result of `predict` if it settles within `timeoutMs`; otherwise an error. A late prediction's duration goes to `onLate`. */
export function boundPrediction<T>(predict: Promise<T>, timeoutMs: number, onLate: (ms: number) => void): Promise<T> {
  const startedAt = Date.now();
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`end-of-turn prediction did not arrive within ${timeoutMs} ms`));
    }, timeoutMs);
    predict.then(
      (value) => {
        if (timedOut) return onLate(Date.now() - startedAt);
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (timedOut) return onLate(Date.now() - startedAt);
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Warms up the turn model. On a worker idle for 7 hours (server with 5 GB swap) the first three
 * predictions exceeded the limit (the first took 6 s); on the first turn the reply was ready in 0.5 s
 * but the voice started at 2.0 s. Run one prediction when the call opens, while the greeting plays.
 * The duration is logged; an error does not affect the call.
 */
export function warmPrediction(predict: () => Promise<unknown>, log: (message: string) => void): Promise<void> {
  const startedAt = Date.now();
  return Promise.resolve()
    .then(predict)
    .then(
      () => log(`turn model warmed up: ${Date.now() - startedAt} ms`),
      (error: unknown) => log(`turn model warm-up failed: ${error instanceof Error ? error.message : String(error)}`),
    );
}

/**
 * End-of-turn threshold. Below it the text turn model treats the sentence as unfinished and the
 * maximum endpointing delay applies; above it the minimum delay applies and the agent replies.
 * LiveKit's Turkish threshold is 0.0045: "Hayır da." ("No, but…") scored 0.0064, passed, and the turn
 * was taken during an 869 ms pause. In eight test calls unfinished sentences scored at most 0.0064
 * ("Hayır da.", "541."), finished ones at least 0.032 ("500 test derken?"); 0.015 sits between.
 * The sample is small: a finished sentence wrongly treated as unfinished is answered ~1.7 s late.
 * Languages without a measurement keep LiveKit's threshold.
 */
const TURN_THRESHOLDS: Record<string, number> = { tr: 0.015 };

export function turnThreshold(language: string | undefined, livekit: number | undefined): number | undefined {
  const own = language ? TURN_THRESHOLDS[language.toLowerCase().split("-")[0]] : undefined;
  return own ?? livekit;
}

const ENDS_SENTENCE = /[.?!…]\s*$/;

/**
 * When the turn model's inference process is dead (inference-health.ts), use punctuation instead of
 * a prediction: if the STT's final transcript ends with a sentence-end mark the turn is over (minimum
 * delay); otherwise it is "unfinished". While the model was dead every turn waited for the 1.5 s limit
 * anyway; now punctuated turns do not wait.
 */
export function fallbackEndOfTurn(userText: string): number {
  return ENDS_SENTENCE.test(userText) ? 1 : 0;
}
