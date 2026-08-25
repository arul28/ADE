import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { injectFsFault } from "../../../test/faultInjection";
import {
  cleanupAbandonedTempFiles,
  readJsonWithRecovery,
  writeFileAtomic,
  writeJsonWithPrevious,
} from "./durableFile";

type Fixture = { version: 1; sessionId: string; value: number };
const isFixture = (value: unknown): value is Fixture => {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<Fixture>;
  return record.version === 1
    && typeof record.sessionId === "string"
    && record.sessionId.length > 0
    && typeof record.value === "number";
};

describe("durableFile", () => {
  let root: string;
  let filePath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-durable-file-"));
    filePath = path.join(root, "state.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const tempLeftovers = () => fs.readdirSync(root).filter((name) => /^\..+\.tmp-/.test(name));

  describe("writeFileAtomic", () => {
    it("atomically replaces a file", () => {
      fs.writeFileSync(filePath, "before");
      writeFileAtomic(filePath, "after", { fsync: true });
      expect(fs.readFileSync(filePath, "utf8")).toBe("after");
      expect(tempLeftovers()).toEqual([]);
    });

    it("leaves the destination untouched when the temp write fails", () => {
      fs.writeFileSync(filePath, "before");
      injectFsFault({ op: "writeFileSync" });

      expect(() => writeFileAtomic(filePath, "after")).toThrow(/no space/i);
      expect(fs.readFileSync(filePath, "utf8")).toBe("before");
      expect(tempLeftovers()).toEqual([]);
    });

    const renameError = (code: string): Error =>
      Object.assign(new Error(`${code}: rename refused`), { code });

    it.each(["EXDEV", "EBUSY", "EPERM", "EACCES"])(
      "falls back to a copy when rename is refused with %s",
      (code) => {
        // A temp file on another device, or a target an indexer/antivirus is
        // holding open on Windows. The link cannot be made; the bytes are fine.
        fs.writeFileSync(filePath, "before");
        injectFsFault({ op: "renameSync", error: () => renameError(code) });

        writeFileAtomic(filePath, "after");
        expect(fs.readFileSync(filePath, "utf8")).toBe("after");
        expect(tempLeftovers()).toEqual([]);
      },
    );

    it("leaves the destination untouched when rename fails on a full disk", () => {
      // ENOSPC is NOT retried as a copy: the filesystem just proved it cannot
      // take these bytes, and a second attempt would only half-write the
      // target. A failed durable write must leave the old file intact.
      fs.writeFileSync(filePath, "before");
      const copy = vi.spyOn(fs, "copyFileSync");
      injectFsFault({ op: "renameSync" });

      expect(() => writeFileAtomic(filePath, "after")).toThrow(/no space/i);
      expect(copy).not.toHaveBeenCalled();
      expect(fs.readFileSync(filePath, "utf8")).toBe("before");
      expect(tempLeftovers()).toEqual([]);
    });

    it("reports the rename failure when the copy fallback fails too", () => {
      fs.writeFileSync(filePath, "before");
      injectFsFault({ op: "renameSync", error: () => renameError("EXDEV") });
      injectFsFault({ op: "copyFileSync" });

      // Both causes, not one: the copy failure used to be swallowed and the
      // rename reported alone, which named the wrong device for a disk that
      // filled up under the copy.
      let thrown: NodeJS.ErrnoException | null = null;
      try {
        writeFileAtomic(filePath, "after");
      } catch (error) {
        thrown = error as NodeJS.ErrnoException;
      }
      expect(thrown?.message).toMatch(/EXDEV/);
      expect(thrown?.message).toMatch(/no space/i);
      expect(thrown?.code).toBe("EXDEV");
      expect((thrown?.cause as NodeJS.ErrnoException | undefined)?.code).toBe("ENOSPC");
      expect(fs.readFileSync(filePath, "utf8")).toBe("before");
      expect(tempLeftovers()).toEqual([]);
    });

    it("keeps the previous file whole when the copy fallback dies half-written", () => {
      // The copy fallback is not atomic, so it must never run onto the target.
      // Copying straight over it turned a failed write into a truncated
      // destination — the old file gone and the new one incomplete.
      fs.writeFileSync(filePath, "before");
      injectFsFault({ op: "renameSync", error: () => renameError("EXDEV") });
      vi.spyOn(fs, "copyFileSync").mockImplementation(((_src: unknown, dest: unknown) => {
        fs.writeFileSync(String(dest), "aft");
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }) as never);

      expect(() => writeFileAtomic(filePath, "after")).toThrow(/copy fallback failed/);
      expect(fs.readFileSync(filePath, "utf8")).toBe("before");
      expect(tempLeftovers()).toEqual([]);
    });

    it("still lands the write when every rename onto the target is refused", () => {
      // A Windows holder that permits writes and denies the replace: the staged
      // rename cannot land either, so the direct copy is the only thing left
      // between the user and a lost write.
      fs.writeFileSync(filePath, "before");
      vi.spyOn(fs, "renameSync").mockImplementation((() => {
        throw renameError("EBUSY");
      }) as never);

      writeFileAtomic(filePath, "after");
      expect(fs.readFileSync(filePath, "utf8")).toBe("after");
      expect(tempLeftovers()).toEqual([]);
    });

    it.skipIf(process.platform === "win32")("keeps a secret's mode through the copy fallback", () => {
      // The staged file carries the requested mode BEFORE it is exposed under
      // the target's name, so a 0o600 secret is never briefly readable by
      // anyone else — not even on the fallback path.
      fs.writeFileSync(filePath, "old", { mode: 0o644 });
      injectFsFault({ op: "renameSync", error: () => renameError("EXDEV") });

      writeFileAtomic(filePath, "secret", { mode: 0o600 });
      expect(fs.readFileSync(filePath, "utf8")).toBe("secret");
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      expect(tempLeftovers()).toEqual([]);
    });

    // Windows has no POSIX mode bits to assert on; the mode is still passed and
    // is simply ignored by the filesystem there.
    it.skipIf(process.platform === "win32")("creates the temp file with the requested mode so a secret is never briefly readable", () => {
      writeFileAtomic(filePath, "secret", { fsync: true, mode: 0o600 });
      expect(fs.readFileSync(filePath, "utf8")).toBe("secret");
      // The rename carries the temp file's mode onto the target.
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    });

    it("never removes the destination before the replacement is in place", () => {
      // The pre-unlink some writers use as "the Windows fix" opens a window in
      // which the file simply does not exist, and a concurrent reader that
      // looks during it sees neither version. `rename` replaces in one step on
      // every platform, so `unlink` has no business being on this path.
      fs.writeFileSync(filePath, "before");
      const unlink = vi.spyOn(fs, "unlinkSync");

      writeFileAtomic(filePath, "after", { fsync: true });
      expect(unlink.mock.calls.map(([target]) => String(target)))
        .not.toContain(filePath);
    });
  });

  describe("writeJsonWithPrevious", () => {
    it("keeps exactly one previous generation", () => {
      writeJsonWithPrevious(filePath, { version: 1, sessionId: "s", value: 1 } satisfies Fixture);
      writeJsonWithPrevious(filePath, { version: 1, sessionId: "s", value: 2 } satisfies Fixture);
      writeJsonWithPrevious(filePath, { version: 1, sessionId: "s", value: 3 } satisfies Fixture);

      expect(JSON.parse(fs.readFileSync(filePath, "utf8")).value).toBe(3);
      expect(JSON.parse(fs.readFileSync(`${filePath}.lkg`, "utf8")).value).toBe(2);
      expect(fs.existsSync(`${filePath}.lkg.lkg`)).toBe(false);
    });

    it("continues the primary write when the lkg copy fails", () => {
      writeJsonWithPrevious(filePath, { version: 1, sessionId: "s", value: 1 } satisfies Fixture);
      injectFsFault({ op: "copyFileSync" });

      expect(writeJsonWithPrevious(filePath, { version: 1, sessionId: "s", value: 2 } satisfies Fixture)).toBe(false);
      expect(JSON.parse(fs.readFileSync(filePath, "utf8")).value).toBe(2);
      expect(tempLeftovers()).toEqual([]);
    });

    it("does not touch disk when validation rejects the payload", () => {
      fs.writeFileSync(filePath, "before");
      expect(() => writeJsonWithPrevious(
        filePath,
        { version: 1, sessionId: "", value: 2 } as Fixture,
        { validate: isFixture },
      )).toThrow(/invalid JSON payload/i);
      expect(fs.readFileSync(filePath, "utf8")).toBe("before");
      expect(fs.existsSync(`${filePath}.lkg`)).toBe(false);
    });
  });

  describe("readJsonWithRecovery", () => {
    it("reads a valid primary", () => {
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, sessionId: "s", value: 1 }));
      expect(readJsonWithRecovery(filePath, isFixture)).toEqual({
        value: { version: 1, sessionId: "s", value: 1 },
        source: "primary",
      });
    });

    it("recovers a corrupt primary from the previous generation", () => {
      fs.writeFileSync(filePath, "{");
      fs.writeFileSync(`${filePath}.lkg`, JSON.stringify({ version: 1, sessionId: "s", value: 1 }));
      expect(readJsonWithRecovery(filePath, isFixture)).toEqual({
        value: { version: 1, sessionId: "s", value: 1 },
        source: "previous",
      });
    });

    it("reports unrecoverable when both generations are corrupt", () => {
      fs.writeFileSync(filePath, "{");
      fs.writeFileSync(`${filePath}.lkg`, "[");
      expect(readJsonWithRecovery(filePath, isFixture)).toEqual({ value: null, source: "unrecoverable" });
    });

    it("reports missing when neither generation exists", () => {
      expect(readJsonWithRecovery(filePath, isFixture)).toEqual({ value: null, source: "missing" });
    });
  });

  describe("cleanupAbandonedTempFiles", () => {
    it("removes only matching old regular files and never follows symlinks", () => {
      const oldTemp = path.join(root, ".state.json.tmp-123-old");
      const youngTemp = path.join(root, ".state.json.tmp-123-young");
      const nonMatching = path.join(root, "state.json.tmp-123-old");
      const outside = path.join(root, "outside.txt");
      const symlink = path.join(root, ".state.json.tmp-123-link");
      fs.writeFileSync(oldTemp, "old");
      fs.writeFileSync(youngTemp, "young");
      fs.writeFileSync(nonMatching, "keep");
      fs.writeFileSync(outside, "outside");
      fs.symlinkSync(outside, symlink);
      const old = new Date(Date.now() - 10_000);
      fs.utimesSync(oldTemp, old, old);

      expect(cleanupAbandonedTempFiles(root, { maxAgeMs: 1_000 })).toBe(1);
      expect(fs.existsSync(oldTemp)).toBe(false);
      expect(fs.existsSync(youngTemp)).toBe(true);
      expect(fs.existsSync(nonMatching)).toBe(true);
      expect(fs.lstatSync(symlink).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(outside, "utf8")).toBe("outside");
    });
  });
});
