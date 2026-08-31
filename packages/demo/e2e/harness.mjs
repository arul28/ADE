/**
 * Assertions and event helpers for the demo's end-to-end scripts.
 *
 * Only the test rig belongs here. The pieces the running app needs too — the
 * isolated home, process bookkeeping, the toy MCP server, the model picker —
 * live in `../lib`, so `app/` never has to import out of a test folder.
 */

/* -------------------------------------------------------------------------- */
/* Assertions                                                                  */
/* -------------------------------------------------------------------------- */

const results = [];

export function check(id, ok, detail = "") {
  results.push({ id, ok: Boolean(ok), detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? `  — ${detail}` : ""}\n`);
  return Boolean(ok);
}

export function summarize() {
  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} checks passed\n`,
  );
  for (const entry of failed) process.stdout.write(`  FAILED: ${entry.id} — ${entry.detail}\n`);
  return { results: [...results], failed: failed.length };
}

/* -------------------------------------------------------------------------- */
/* Event helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Resolve once the turn has settled.
 *
 * "Settled" is an explicit terminal signal — a `done`/completed `status` event
 * or an `error` — never a wall-clock guess. The timeout is a failure budget for
 * a hung provider, not the normal path.
 */
export function waitForIdle(thread, { timeoutMs = 180_000, onEvent } = {}) {
  return new Promise((resolve, reject) => {
    const collected = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`the turn did not settle within ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref();

    const unsubscribe = thread.on("event", (envelope) => {
      collected.push(envelope);
      onEvent?.(envelope);
      const event = envelope.event ?? {};
      if (event.type === "done") finish(resolve, collected);
      else if (event.type === "error") finish(resolve, collected);
      else if (
        event.type === "status" &&
        (event.turnStatus === "completed" ||
          event.turnStatus === "failed" ||
          event.turnStatus === "interrupted")
      ) {
        finish(resolve, collected);
      }
    });
  });
}

export function eventText(envelope) {
  const event = envelope?.event ?? {};
  return typeof event.text === "string" ? event.text : "";
}
