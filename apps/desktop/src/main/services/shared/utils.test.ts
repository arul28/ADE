import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isRecord,
  asString,
  asNumber,
  nowIso,
  getErrorMessage,
  isEnoentError,
  toMemoryEntryDto,
  uniqueSorted,
  uniqueStrings,
  asArray,
  firstLine,
  parseDiffNameOnly,
  safeJsonParse,
  isWithinDir,
  resolvePathWithinRoot,
  toOptionalString,
  normalizeRelative,
  normalizeBranchName,
  hasNullByte,
  parseIsoToEpoch,
  sha256Hex,
  stableStringify,
  toBase64Url,
  createPkcePair,
  escapeRegExp,
  globToRegExp,
  matchesGlob,
  normalizeSet,
  isEnvRef,
  hasEnvRefToken,
  looksSensitiveKey,
  looksSensitiveValue,
  sanitizeStructuredData,
} from "./utils";

describe("isRecord", () => {
  it("returns true for plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("returns false for non-objects", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord("str")).toBe(false);
    expect(isRecord([])).toBe(false);
  });
});

describe("asString", () => {
  it("returns the value when it is a string", () => {
    expect(asString("hello")).toBe("hello");
    expect(asString("")).toBe("");
  });

  it("returns fallback for non-strings", () => {
    expect(asString(42)).toBe("");
    expect(asString(null, "default")).toBe("default");
    expect(asString(undefined, "x")).toBe("x");
  });
});

describe("asNumber", () => {
  it("returns the value when it is a finite number", () => {
    expect(asNumber(42)).toBe(42);
    expect(asNumber(0)).toBe(0);
    expect(asNumber(-1.5)).toBe(-1.5);
  });

  it("parses numeric strings", () => {
    expect(asNumber("10")).toBe(10);
    expect(asNumber("3.14")).toBe(3.14);
  });

  it("returns fallback for NaN, Infinity, and non-numeric values", () => {
    expect(asNumber(NaN, 99)).toBe(99);
    expect(asNumber(Infinity, 99)).toBe(99);
    expect(asNumber("not-a-number", 0)).toBe(0);
    // Number(null) is 0 which is finite, so it returns 0 not the fallback
    expect(asNumber(null, 5)).toBe(0);
  });
});

describe("nowIso", () => {
  it("returns a valid ISO 8601 string", () => {
    const result = nowIso();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isNaN(Date.parse(result))).toBe(false);
  });
});

describe("getErrorMessage", () => {
  it("extracts message from Error instances", () => {
    expect(getErrorMessage(new Error("something went wrong"))).toBe("something went wrong");
  });

  it("converts non-Error values to string", () => {
    expect(getErrorMessage("plain string")).toBe("plain string");
    expect(getErrorMessage(42)).toBe("42");
    expect(getErrorMessage(null)).toBe("null");
  });
});

describe("isEnoentError", () => {
  it("returns true for ENOENT error objects", () => {
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    expect(isEnoentError(err)).toBe(true);
  });

  it("returns false for other error codes", () => {
    const err = Object.assign(new Error("perm"), { code: "EACCES" });
    expect(isEnoentError(err)).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isEnoentError(null)).toBe(false);
    expect(isEnoentError(undefined)).toBe(false);
  });
});

describe("toMemoryEntryDto", () => {
  it("normalizes embedded field to boolean", () => {
    expect(toMemoryEntryDto({ id: "1", embedded: true })).toEqual({ id: "1", embedded: true });
    expect(toMemoryEntryDto({ id: "2", embedded: undefined as any })).toEqual({ id: "2", embedded: false });
    expect(toMemoryEntryDto({ id: "3" } as any)).toEqual({ id: "3", embedded: false });
  });
});

describe("uniqueSorted", () => {
  it("deduplicates and sorts strings", () => {
    expect(uniqueSorted(["b", "a", "b", "c", "a"])).toEqual(["a", "b", "c"]);
  });

  it("returns empty for empty input", () => {
    expect(uniqueSorted([])).toEqual([]);
  });
});

describe("uniqueStrings", () => {
  it("deduplicates without sorting", () => {
    const result = uniqueStrings(["b", "a", "b"]);
    expect(result).toHaveLength(2);
    expect(result).toContain("a");
    expect(result).toContain("b");
  });
});

describe("asArray", () => {
  it("returns arrays as-is", () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
  });

  it("returns empty array for non-arrays", () => {
    expect(asArray("str")).toEqual([]);
    expect(asArray(null)).toEqual([]);
    expect(asArray(42)).toEqual([]);
  });
});

describe("firstLine", () => {
  it("extracts the first line from a multi-line string", () => {
    expect(firstLine("hello\nworld")).toBe("hello");
  });

  it("trims whitespace from the first line", () => {
    expect(firstLine("  hello  \nworld")).toBe("hello");
  });

  it("returns empty string for empty input", () => {
    expect(firstLine("")).toBe("");
  });
});

describe("parseDiffNameOnly", () => {
  it("parses newline-separated file names", () => {
    expect(parseDiffNameOnly("a.ts\nb.ts\nc.ts\n")).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("filters out empty lines and trims whitespace", () => {
    expect(parseDiffNameOnly("  a.ts  \n\n  b.ts  \n\n")).toEqual(["a.ts", "b.ts"]);
  });

  it("returns empty for empty input", () => {
    expect(parseDiffNameOnly("")).toEqual([]);
  });
});

describe("safeJsonParse", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
  });

  it("returns fallback for invalid JSON", () => {
    expect(safeJsonParse("not json", { default: true })).toEqual({ default: true });
  });

  it("returns fallback for null/undefined/empty", () => {
    expect(safeJsonParse(null, "fallback")).toBe("fallback");
    expect(safeJsonParse(undefined, 42)).toBe(42);
    expect(safeJsonParse("", [])).toEqual([]);
  });
});

describe("isWithinDir", () => {
  it("returns true when candidate is inside root", () => {
    expect(isWithinDir("/project", "/project/src/file.ts")).toBe(true);
  });

  it("returns true when candidate equals root", () => {
    expect(isWithinDir("/project", "/project")).toBe(true);
  });

  it("returns false when candidate is outside root", () => {
    expect(isWithinDir("/project", "/other/file.ts")).toBe(false);
    expect(isWithinDir("/project/src", "/project/file.ts")).toBe(false);
  });
});

describe("resolvePathWithinRoot", () => {
  it("rejects symlink escapes for existing paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-utils-root-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-utils-outside-"));
    const linkPath = path.join(root, "linked-outside");
    try {
      fs.symlinkSync(outsideDir, linkPath);
      expect(() => resolvePathWithinRoot(root, path.join(linkPath, "secret.txt"), { allowMissing: true })).toThrow(
        /Path escapes root/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("resolvePathWithinRoot", () => {
  it("allows a normal child path when intermediate segments do not exist yet", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-utils-root-"));
    try {
      const target = path.join(root, "nested", "new-file.txt");
      const resolved = resolvePathWithinRoot(root, target, { allowMissing: true });
      expect(path.basename(resolved)).toBe("new-file.txt");
      expect(resolved.endsWith(`${path.sep}nested${path.sep}new-file.txt`)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symlink escapes that point outside the root", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-utils-root-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-utils-outside-"));
    try {
      const linkPath = path.join(tempRoot, "linked");
      const outsideFile = path.join(outsideDir, "secret.txt");
      fs.writeFileSync(outsideFile, "secret", "utf8");
      fs.symlinkSync(outsideDir, linkPath, "dir");

      expect(() => resolvePathWithinRoot(tempRoot, path.join(linkPath, "secret.txt"))).toThrow("Path escapes root");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("toOptionalString", () => {
  it("returns trimmed string for non-empty values", () => {
    expect(toOptionalString("  hello  ")).toBe("hello");
  });

  it("returns null for empty or non-string values", () => {
    expect(toOptionalString("")).toBeNull();
    expect(toOptionalString("   ")).toBeNull();
    expect(toOptionalString(42)).toBeNull();
    expect(toOptionalString(null)).toBeNull();
  });
});

describe("normalizeRelative", () => {
  it("strips leading ./ and backslashes", () => {
    expect(normalizeRelative("./src/file.ts")).toBe("src/file.ts");
    expect(normalizeRelative("src\\dir\\file.ts")).toBe("src/dir/file.ts");
    expect(normalizeRelative("/absolute/path")).toBe("absolute/path");
  });
});

describe("normalizeBranchName", () => {
  it("strips refs/heads/ prefix", () => {
    expect(normalizeBranchName("refs/heads/main")).toBe("main");
  });

  it("strips origin/ prefix", () => {
    expect(normalizeBranchName("origin/feature-x")).toBe("feature-x");
  });

  it("returns as-is for plain branch names", () => {
    expect(normalizeBranchName("main")).toBe("main");
  });
});

describe("hasNullByte", () => {
  it("returns true when buffer contains null byte", () => {
    expect(hasNullByte(Buffer.from([65, 0, 66]))).toBe(true);
  });

  it("returns false for buffers without null bytes", () => {
    expect(hasNullByte(Buffer.from("hello"))).toBe(false);
  });

  it("returns false for empty buffer", () => {
    expect(hasNullByte(Buffer.from([]))).toBe(false);
  });

  it("only scans the first 8192 bytes", () => {
    const largeBuffer = Buffer.alloc(16384, 65); // all 'A'
    largeBuffer[10000] = 0; // null byte after the 8192 limit
    expect(hasNullByte(largeBuffer)).toBe(false);

    largeBuffer[100] = 0; // null byte within the limit
    expect(hasNullByte(largeBuffer)).toBe(true);
  });
});

describe("parseIsoToEpoch", () => {
  it("parses valid ISO strings to epoch ms", () => {
    const result = parseIsoToEpoch("2026-03-01T00:00:00.000Z");
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(Date.parse("2026-03-01T00:00:00.000Z"));
  });

  it("returns NaN for null/undefined/empty", () => {
    expect(Number.isNaN(parseIsoToEpoch(null))).toBe(true);
    expect(Number.isNaN(parseIsoToEpoch(undefined))).toBe(true);
    expect(Number.isNaN(parseIsoToEpoch(""))).toBe(true);
  });

  it("returns NaN for invalid date strings", () => {
    expect(Number.isNaN(parseIsoToEpoch("not-a-date"))).toBe(true);
  });
});

describe("sha256Hex", () => {
  it("produces consistent hex digest for strings", () => {
    const hash1 = sha256Hex("hello");
    const hash2 = sha256Hex("hello");
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different digests for different inputs", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});

describe("stableStringify", () => {
  it("sorts object keys deterministically", () => {
    const a = stableStringify({ b: 1, a: 2 });
    const b = stableStringify({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it("handles nested objects and arrays", () => {
    const result = stableStringify({ z: { b: 1, a: 2 }, arr: [3, 2, 1] });
    const parsed = JSON.parse(result);
    expect(Object.keys(parsed)).toEqual(["arr", "z"]);
    expect(Object.keys(parsed.z)).toEqual(["a", "b"]);
    expect(parsed.arr).toEqual([3, 2, 1]); // arrays preserve order
  });
});

describe("toBase64Url", () => {
  it("produces URL-safe base64 without padding", () => {
    const result = toBase64Url(Buffer.from("hello world"));
    expect(result).not.toContain("+");
    expect(result).not.toContain("/");
    expect(result).not.toContain("=");
  });
});

describe("createPkcePair", () => {
  it("returns a verifier and challenge pair", () => {
    const pair = createPkcePair();
    expect(pair.verifier).toBeTruthy();
    expect(pair.challenge).toBeTruthy();
    expect(pair.verifier).not.toBe(pair.challenge);
  });

  it("generates unique pairs on each call", () => {
    const pair1 = createPkcePair();
    const pair2 = createPkcePair();
    expect(pair1.verifier).not.toBe(pair2.verifier);
  });
});

describe("escapeRegExp", () => {
  it("escapes special regex characters (except * which is used for glob)", () => {
    // Note: this escapeRegExp does NOT escape * because it's used with globToRegExp
    expect(escapeRegExp("a.b+c*d")).toBe("a\\.b\\+c*d");
    expect(escapeRegExp("foo[bar]")).toBe("foo\\[bar\\]");
    expect(escapeRegExp("$100")).toBe("\\$100");
    expect(escapeRegExp("(test)")).toBe("\\(test\\)");
    expect(escapeRegExp("a|b")).toBe("a\\|b");
  });
});

describe("globToRegExp", () => {
  it("converts glob patterns to case-insensitive regex", () => {
    const re = globToRegExp("*.ts");
    expect(re.test("file.ts")).toBe(true);
    expect(re.test("FILE.TS")).toBe(true);
    expect(re.test("file.js")).toBe(false);
  });

  it("handles multiple wildcards", () => {
    const re = globToRegExp("src*test*");
    expect(re.test("src/foo/test/bar")).toBe(true);
    expect(re.test("src-test-x")).toBe(true);
  });

  it("returns ^$ for empty pattern", () => {
    const re = globToRegExp("");
    expect(re.test("")).toBe(true);
    expect(re.test("anything")).toBe(false);
  });
});

describe("matchesGlob", () => {
  it("matches when pattern matches value", () => {
    expect(matchesGlob("*.ts", "file.ts")).toBe(true);
  });

  it("returns true when pattern is empty", () => {
    expect(matchesGlob("", "anything")).toBe(true);
    expect(matchesGlob(null, "anything")).toBe(true);
  });

  it("returns false when value is empty but pattern is not", () => {
    expect(matchesGlob("*.ts", "")).toBe(false);
    expect(matchesGlob("*.ts", null as any)).toBe(false);
  });
});

describe("normalizeSet", () => {
  it("lowercases, trims, and deduplicates", () => {
    const result = normalizeSet(["  A  ", "b", "a", "C"]);
    expect(result).toEqual(new Set(["a", "b", "c"]));
  });

  it("filters empty strings", () => {
    const result = normalizeSet(["  ", "", "x"]);
    expect(result).toEqual(new Set(["x"]));
  });

  it("returns empty set for undefined", () => {
    expect(normalizeSet(undefined)).toEqual(new Set());
  });
});

describe("isEnvRef", () => {
  it("returns true for valid env refs", () => {
    expect(isEnvRef("${env:MY_VAR}")).toBe(true);
    expect(isEnvRef("${env:API_KEY_123}")).toBe(true);
  });

  it("returns false for partial or invalid refs", () => {
    expect(isEnvRef("${env:lowercase}")).toBe(false);
    expect(isEnvRef("plain string")).toBe(false);
    expect(isEnvRef("${env:VAR} extra")).toBe(false);
  });
});

describe("hasEnvRefToken", () => {
  it("detects env refs anywhere in the string", () => {
    expect(hasEnvRefToken("prefix ${env:MY_VAR} suffix")).toBe(true);
    expect(hasEnvRefToken("${env:KEY}")).toBe(true);
  });

  it("returns false when no env ref is present", () => {
    expect(hasEnvRefToken("no refs here")).toBe(false);
  });
});

describe("looksSensitiveKey", () => {
  it("detects sensitive key patterns", () => {
    expect(looksSensitiveKey("api_key")).toBe(true);
    expect(looksSensitiveKey("apiKey")).toBe(true);
    expect(looksSensitiveKey("api-key")).toBe(true);
    expect(looksSensitiveKey("Authorization")).toBe(true);
    expect(looksSensitiveKey("TOKEN")).toBe(true);
    expect(looksSensitiveKey("secret")).toBe(true);
    expect(looksSensitiveKey("password")).toBe(true);
  });

  it("returns false for non-sensitive keys", () => {
    expect(looksSensitiveKey("name")).toBe(false);
    expect(looksSensitiveKey("url")).toBe(false);
    expect(looksSensitiveKey("count")).toBe(false);
  });
});

describe("looksSensitiveValue", () => {
  it("detects bearer tokens", () => {
    expect(looksSensitiveValue("Bearer abc123")).toBe(true);
  });

  it("detects sk- prefixed keys", () => {
    expect(looksSensitiveValue("sk-abc123def456ghi7")).toBe(true);
  });

  it("detects GitHub tokens", () => {
    expect(looksSensitiveValue("ghp_abcdefghijklmnopqrstuvwx")).toBe(true);
  });

  it("detects Slack tokens", () => {
    expect(looksSensitiveValue("xoxb-1234567890-abcdef")).toBe(true);
  });

  it("returns false for non-sensitive values", () => {
    expect(looksSensitiveValue("hello world")).toBe(false);
    expect(looksSensitiveValue("12345")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(looksSensitiveValue("")).toBe(false);
    expect(looksSensitiveValue("   ")).toBe(false);
  });
});

describe("sanitizeStructuredData", () => {
  it("returns null for non-record input", () => {
    expect(sanitizeStructuredData("string")).toBeNull();
    expect(sanitizeStructuredData(null)).toBeNull();
    expect(sanitizeStructuredData(42)).toBeNull();
  });

  it("redacts sensitive keys", () => {
    const result = sanitizeStructuredData({ token: "abc123", name: "test" });
    expect(result!.token).toBe("[REDACTED]");
    expect(result!.name).toBe("test");
  });

  it("redacts sensitive values", () => {
    const result = sanitizeStructuredData({ auth: "Bearer secret123" });
    expect(result!.auth).toBe("[REDACTED]");
  });

  it("removes blocked top-level keys", () => {
    const result = sanitizeStructuredData(
      { name: "ok", blocked: "value" },
      { blockedTopLevelKeys: ["blocked"] },
    );
    expect(result).toEqual({ name: "ok" });
  });

  it("truncates long strings", () => {
    const long = "x".repeat(200);
    const result = sanitizeStructuredData({ text: long }, { maxStringLength: 50 });
    expect(result!.text).toHaveLength(50); // 49 chars + ellipsis = maxStringLength
  });

  it("limits array entries", () => {
    const result = sanitizeStructuredData(
      { items: [1, 2, 3, 4, 5] },
      { maxArrayEntries: 2 },
    );
    expect(result!.items).toEqual([1, 2]);
  });

  it("limits object entries", () => {
    const result = sanitizeStructuredData(
      { a: 1, b: 2, c: 3, d: 4 },
      { maxObjectEntries: 2 },
    );
    expect(Object.keys(result!)).toHaveLength(2);
  });

  it("respects custom redaction text", () => {
    const result = sanitizeStructuredData(
      { token: "abc" },
      { redactionText: "***" },
    );
    expect(result!.token).toBe("***");
  });

  it("handles nested objects and arrays", () => {
    const result = sanitizeStructuredData({
      config: {
        api_key: "secret",
        name: "ok",
        items: [{ token: "hidden" }, "normal text"],
      },
    });
    const config = result!.config as Record<string, unknown>;
    expect(config.api_key).toBe("[REDACTED]");
    expect(config.name).toBe("ok");
    const items = config.items as unknown[];
    expect((items[0] as Record<string, unknown>).token).toBe("[REDACTED]");
    expect(items[1]).toBe("normal text");
  });
});
