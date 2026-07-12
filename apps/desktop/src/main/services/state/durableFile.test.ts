import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      const original = fs.writeFileSync.bind(fs);
      vi.spyOn(fs, "writeFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        if (typeof target === "number") {
          throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
        }
        return (original as (...values: unknown[]) => unknown)(target, ...args);
      }) as typeof fs.writeFileSync);

      expect(() => writeFileAtomic(filePath, "after")).toThrow(/no space/i);
      expect(fs.readFileSync(filePath, "utf8")).toBe("before");
      expect(tempLeftovers()).toEqual([]);
    });

    it("leaves the destination untouched when rename fails", () => {
      fs.writeFileSync(filePath, "before");
      vi.spyOn(fs, "renameSync").mockImplementation(() => {
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      });

      expect(() => writeFileAtomic(filePath, "after")).toThrow(/no space/i);
      expect(fs.readFileSync(filePath, "utf8")).toBe("before");
      expect(tempLeftovers()).toEqual([]);
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
      vi.spyOn(fs, "copyFileSync").mockImplementation(() => {
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      });

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
