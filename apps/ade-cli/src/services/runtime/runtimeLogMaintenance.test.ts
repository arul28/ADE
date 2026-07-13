import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copytruncateLogIfOversized,
  MAX_LAUNCHD_LOG_BYTES,
  ROTATED_LAUNCHD_LOG_BYTES,
} from "./runtimeLogMaintenance";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("copytruncateLogIfOversized", () => {
  it("copies the last MiB and truncates an oversized live log", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-log-bound-"));
    roots.push(root);
    const logPath = path.join(root, "launchd.err.log");
    const prefix = Buffer.alloc(MAX_LAUNCHD_LOG_BYTES, 1);
    const tail = Buffer.alloc(ROTATED_LAUNCHD_LOG_BYTES, 2);
    fs.writeFileSync(logPath, Buffer.concat([prefix, tail]));
    fs.writeFileSync(`${logPath}.2`, "older generation");

    expect(copytruncateLogIfOversized(logPath)).toBe(true);
    expect(fs.statSync(logPath).size).toBe(0);
    expect(fs.readFileSync(`${logPath}.1`)).toEqual(tail);
    expect(fs.existsSync(`${logPath}.2`)).toBe(false);

    fs.writeFileSync(logPath, "small");
    expect(copytruncateLogIfOversized(logPath)).toBe(false);
    expect(fs.readFileSync(logPath, "utf8")).toBe("small");
    expect(fs.readFileSync(`${logPath}.1`)).toEqual(tail);
  });

  it("writes only the bytes returned by a short read", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-log-bound-short-read-"));
    roots.push(root);
    const logPath = path.join(root, "launchd.err.log");
    fs.writeFileSync(logPath, Buffer.alloc(MAX_LAUNCHD_LOG_BYTES + ROTATED_LAUNCHD_LOG_BYTES, 1));
    vi.spyOn(fs, "readSync").mockReturnValueOnce(128);

    expect(copytruncateLogIfOversized(logPath)).toBe(true);
    expect(fs.statSync(`${logPath}.1`).size).toBe(128);
  });
});
