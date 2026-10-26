import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecretTempFileStore } from "./secretTempFiles";

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("createSecretTempFileStore", () => {
  it("keeps a secret only as long as its chat and lifetime allow, even when a removal fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-secret-temp-files-"));
    tempRoots.push(root);
    let clock = Date.parse("2026-10-26T12:00:00.000Z");
    const warn = vi.fn();
    const store = createSecretTempFileStore({ dir: path.join(root, "temp-files"), now: () => clock, logger: { info: vi.fn(), warn } });

    const kept = store.write({ chatSessionId: "chat-2", name: "API_KEY", value: "two", ttlMs: 60 * 60_000 });
    const held = store.write({ chatSessionId: "chat-1", name: "API_KEY", value: "one" });
    expect(fs.readFileSync(held.path, "utf8")).toBe("one");
    if (process.platform !== "win32") expect(fs.statSync(held.path).mode & 0o777).toBe(0o600);

    // Windows: something still has the file open when the chat ends.
    const realRm = fs.rmSync;
    const rm = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (String(target) === held.path) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      return realRm(target, options);
    });
    expect(store.removeForChat("chat-1")).toBe(0);
    expect(warn).toHaveBeenCalledWith("project_secret.temp_file_remove_failed", expect.anything());

    // Once it is released, the next sweep takes it although it has not expired.
    rm.mockRestore();
    store.sweep();
    expect(fs.existsSync(held.path)).toBe(false);
    expect(fs.existsSync(kept.path)).toBe(true);

    clock += 60 * 60_000;
    store.sweep();
    expect(fs.existsSync(kept.path)).toBe(false);
    store.dispose();
  });
});
