/**
 * The turn model's inference process. LiveKit Agents runs the text turn detector in a separate
 * process tied to the worker's main process; if that process gets no ping for 15 s ("inference
 * process orphaned") it exits, and the framework does NOT restart it. Every later prediction goes
 * unanswered and every turn ends at the `EOT_TIMEOUT_MS` limit (1.5 s): after one overnight restart,
 * 7 of 7 turns in a call. The only symptom is the worker's health endpoint: 503 "inference process not
 * running" (agents `worker.js` healthCheck). Reported upstream as livekit/agents-js#2764.
 *
 * Two measures: inside a call, do not wait for a dead turn model (fall back to the punctuation rule,
 * `fallbackEndOfTurn`); in the main process, when no call is running and the inference process is
 * dead, exit so your process manager restarts the worker (`createInferenceWatch`).
 */

/** Health endpoint: 8081 in production (`start`); in `dev` the port is random and the check returns "unknown". */
export const WORKER_HEALTH_URL = "http://127.0.0.1:8081/";
/** The main process checks this often. */
export const WATCH_EVERY_MS = 30_000;

export type InferenceState = "ok" | "dead" | "unknown";

const DEAD_MESSAGE = "inference process not running";

/** Health endpoint response → state. Another 503 (LiveKit connection) is unrelated to the inference process. */
export function inferenceState(status: number, body: string): InferenceState {
  if (status === 200) return "ok";
  return status === 503 && body.includes(DEAD_MESSAGE) ? "dead" : "unknown";
}

export async function checkInference(url = WORKER_HEALTH_URL, fetchImpl: typeof fetch = fetch): Promise<InferenceState> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(1_000) });
    return inferenceState(res.status, await res.text());
  } catch {
    return "unknown";
  }
}

/**
 * Watchdog for the main process: call it periodically (e.g. from your load function); it checks
 * every `WATCH_EVERY_MS`. If the inference process is dead and no call is running, `onRestart`
 * (exit, the process manager restarts the worker); if a call is running it waits until it ends.
 */
export function createInferenceWatch(opts: {
  check: () => Promise<InferenceState>;
  onRestart: () => void;
  onDeadDuringCall?: (activeJobs: number) => void;
  everyMs?: number;
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  const everyMs = opts.everyMs ?? WATCH_EVERY_MS;
  let lastAt = -Infinity;
  let busy = false;
  let warned = false;
  /** `activeJobs` is read AFTER the check too: a call that started meanwhile must not be cut. */
  return async (activeJobs: () => number): Promise<void> => {
    if (busy || now() - lastAt < everyMs) return;
    busy = true;
    lastAt = now();
    try {
      if ((await opts.check()) !== "dead") return;
      const active = activeJobs();
      if (active === 0) return opts.onRestart();
      if (!warned) opts.onDeadDuringCall?.(active);
      warned = true;
    } finally {
      busy = false;
    }
  };
}
