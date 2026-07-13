import fs from "node:fs";
import { vi } from "vitest";

export type FsFaultOptions = {
  op: "writeFileSync" | "appendFileSync" | "renameSync" | "copyFileSync" | "writeSync" | "fsyncSync";
  failOnCall?: number;
  matchPath?: (path: string) => boolean;
  error?: () => Error;
};

const defaultNoSpaceError = (): Error => Object.assign(
  new Error("ENOSPC: no space left on device"),
  { code: "ENOSPC" },
);

/**
 * Replace one synchronous fs operation with a counted, one-shot fault while
 * passing every other call through to Node unchanged. Path matching checks all
 * path-like arguments so destination-oriented operations such as rename can be
 * targeted without affecting unrelated filesystem work.
 */
export function injectFsFault(opts: FsFaultOptions): { restore(): void; calls(): number } {
  const failOnCall = opts.failOnCall ?? 1;
  if (!Number.isInteger(failOnCall) || failOnCall < 1) {
    throw new Error("failOnCall must be a positive 1-based call number.");
  }

  const original = fs[opts.op].bind(fs) as (...args: unknown[]) => unknown;
  let matchingCalls = 0;
  const spy = vi.spyOn(fs, opts.op).mockImplementation(((...args: unknown[]) => {
    const matches = !opts.matchPath || args.some((value) => (
      (typeof value === "string" || value instanceof URL || Buffer.isBuffer(value))
      && opts.matchPath!(String(value))
    ));
    if (matches) {
      matchingCalls += 1;
      if (matchingCalls === failOnCall) throw (opts.error ?? defaultNoSpaceError)();
    }
    return original(...args);
  }) as never);

  return {
    restore: () => spy.mockRestore(),
    calls: () => matchingCalls,
  };
}

/** Canonical recipe for forcing a real SQLITE_FULL in node:sqlite tests. */
export function constrainSqliteMaxPages(db: { exec(sql: string): unknown }, pages: number): void {
  if (!Number.isSafeInteger(pages) || pages < 1) {
    throw new Error("SQLite max_page_count must be a positive safe integer.");
  }
  db.exec(`PRAGMA max_page_count = ${pages}`);
}
