import { describe, expect, it } from "vitest";
import { extractFirstJsonObject, normalizeText, parseStructuredOutput, withTimeout } from "./utils";

describe("extractFirstJsonObject", () => {
  it("returns null for empty or missing input", () => {
    expect(extractFirstJsonObject("")).toBeNull();
    expect(extractFirstJsonObject("   ")).toBeNull();
    expect(extractFirstJsonObject(null as unknown as string)).toBeNull();
  });

  it("returns raw JSON when input is exactly a JSON object", () => {
    expect(extractFirstJsonObject('{"key": "value"}')).toBe('{"key": "value"}');
    expect(extractFirstJsonObject('  {"key": "value"}  ')).toBe('{"key": "value"}');
  });

  it("extracts JSON from fenced code blocks", () => {
    expect(extractFirstJsonObject('```json\n{"status": "ok"}\n```')).toBe('{"status": "ok"}');
    expect(extractFirstJsonObject('Here:\n```json\n{"answer": 42}\n```\nDone!')).toBe('{"answer": 42}');
  });

  it("extracts first JSON object from surrounding narrative", () => {
    expect(extractFirstJsonObject('The result is {"result": true} done.')).toBe('{"result": true}');
    expect(extractFirstJsonObject('A {"first": 1} B {"second": 2}')).toBe('{"first": 1}');
  });

  it("handles nested braces correctly", () => {
    const nested = '{"a": {"b": {"c": 1}}}';
    expect(extractFirstJsonObject(nested)).toBe(nested);
    expect(extractFirstJsonObject(`Result: ${nested} done`)).toBe(nested);
  });

  it("handles escaped quotes and braces inside strings", () => {
    expect(extractFirstJsonObject('{"key": "val\\"ue"}')).toBe('{"key": "val\\"ue"}');
    expect(extractFirstJsonObject('{"key": "a { b }"}')).toBe('{"key": "a { b }"}');
    expect(extractFirstJsonObject('{"t": "{{name}}"}')).toBe('{"t": "{{name}}"}');
  });

  it("returns null when no valid JSON object exists", () => {
    expect(extractFirstJsonObject("plain text")).toBeNull();
    expect(extractFirstJsonObject("[1, 2]")).toBeNull();
    expect(extractFirstJsonObject('{"unclosed": "value"')).toBeNull();
  });
});

describe("parseStructuredOutput", () => {
  it("parses valid JSON from various formats", () => {
    expect(parseStructuredOutput('{"x": 1}')).toEqual({ x: 1 });
    expect(parseStructuredOutput('text {"status": "ok"} end')).toEqual({ status: "ok" });
    expect(parseStructuredOutput('```json\n{"a": [1]}\n```')).toEqual({ a: [1] });
  });

  it("returns null for invalid or missing input", () => {
    expect(parseStructuredOutput("")).toBeNull();
    expect(parseStructuredOutput("no json here")).toBeNull();
    expect(parseStructuredOutput("{not valid json}")).toBeNull();
  });
});

describe("withTimeout", () => {
  it("resolves when promise completes before timeout", async () => {
    expect(await withTimeout(Promise.resolve(42), 5_000, "timeout")).toBe(42);
  });

  it("rejects when promise exceeds timeout", async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 30_000));
    await expect(withTimeout(slow, 1_000, "timed out")).rejects.toThrow("timed out");
  });
});

describe("normalizeText", () => {
  it("coerces values to strings", () => {
    expect(normalizeText("hello")).toBe("hello");
    expect(normalizeText(42)).toBe("42");
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
  });
});
