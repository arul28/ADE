import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadAgentBrowserArtifactPayloadFromFile,
  parseAgentBrowserArtifactPayload,
} from "./agentBrowserArtifactAdapter";

// ---------------------------------------------------------------------------
// parseAgentBrowserArtifactPayload — null / undefined / non-record inputs
// ---------------------------------------------------------------------------

describe("parseAgentBrowserArtifactPayload — non-object inputs", () => {
  it("returns an empty array for null", () => {
    expect(parseAgentBrowserArtifactPayload(null)).toEqual([]);
  });

  it("returns an empty array for undefined", () => {
    expect(parseAgentBrowserArtifactPayload(undefined)).toEqual([]);
  });

  it("returns an empty array for primitive strings", () => {
    expect(parseAgentBrowserArtifactPayload("not-a-payload")).toEqual([]);
  });

  it("returns an empty array for numbers", () => {
    expect(parseAgentBrowserArtifactPayload(42)).toEqual([]);
  });

  it("returns an empty array for booleans", () => {
    expect(parseAgentBrowserArtifactPayload(true)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseAgentBrowserArtifactPayload — array inputs
// ---------------------------------------------------------------------------

describe("parseAgentBrowserArtifactPayload — array inputs", () => {
  it("coerces an array of records into artifact inputs", () => {
    const inputs = parseAgentBrowserArtifactPayload([
      {
        kind: "screenshot",
        title: "After click",
        path: "/tmp/shot.png",
        mimeType: "image/png",
      },
      {
        kind: "console_logs",
        text: "log line",
      },
    ]);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      kind: "screenshot",
      title: "After click",
      path: "/tmp/shot.png",
      mimeType: "image/png",
    });
    expect(inputs[1]).toMatchObject({
      kind: "console_logs",
      text: "log line",
    });
  });

  it("skips non-record entries inside the array", () => {
    const inputs = parseAgentBrowserArtifactPayload([
      null,
      "string-entry",
      42,
      { path: "/tmp/kept.png" },
    ]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.path).toBe("/tmp/kept.png");
  });

  it("drops array entries with no path/uri/text/json", () => {
    const inputs = parseAgentBrowserArtifactPayload([
      { kind: "screenshot", title: "Just metadata" },
      { description: "only description" },
    ]);
    expect(inputs).toEqual([]);
  });

  it("keeps an array entry that carries only json payload", () => {
    const inputs = parseAgentBrowserArtifactPayload([
      { kind: "browser_verification", json: { ok: true } },
    ]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.json).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// parseAgentBrowserArtifactPayload — record.artifacts[]
// ---------------------------------------------------------------------------

describe("parseAgentBrowserArtifactPayload — record with artifacts[]", () => {
  it("coerces each entry in the artifacts array", () => {
    const inputs = parseAgentBrowserArtifactPayload({
      artifacts: [
        { kind: "screenshot", path: "/tmp/a.png" },
        { kind: "console_logs", text: "error" },
      ],
    });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.path).toBe("/tmp/a.png");
    expect(inputs[1]!.text).toBe("error");
  });

  it("handles artifacts being undefined without throwing", () => {
    const inputs = parseAgentBrowserArtifactPayload({ artifacts: undefined });
    expect(inputs).toEqual([]);
  });

  it("handles artifacts being a non-array value", () => {
    const inputs = parseAgentBrowserArtifactPayload({ artifacts: "not-an-array" });
    expect(inputs).toEqual([]);
  });

  it("uses field aliases: type→kind, name→title, summary→description, filePath→path, url→uri, contentType→mimeType", () => {
    const inputs = parseAgentBrowserArtifactPayload({
      artifacts: [
        {
          type: "screenshot",
          name: "Aliased entry",
          summary: "summary-as-description",
          filePath: "/tmp/alias.png",
          url: "https://example.test/a.png",
          contentType: "image/png",
        },
      ],
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      kind: "screenshot",
      title: "Aliased entry",
      description: "summary-as-description",
      path: "/tmp/alias.png",
      uri: "https://example.test/a.png",
      mimeType: "image/png",
      // rawType falls back to `type` when rawType is absent.
      rawType: "screenshot",
    });
  });

  it("prefers canonical fields over aliases when both are present", () => {
    const inputs = parseAgentBrowserArtifactPayload({
      artifacts: [
        {
          kind: "primary-kind",
          type: "alias-kind",
          title: "primary-title",
          name: "alias-name",
          path: "/primary/path.png",
          filePath: "/alias/path.png",
          uri: "https://primary.test/",
          url: "https://alias.test/",
          mimeType: "image/png",
          contentType: "image/jpeg",
          rawType: "primary-raw",
        },
      ],
    });
    expect(inputs[0]).toMatchObject({
      kind: "primary-kind",
      title: "primary-title",
      path: "/primary/path.png",
      uri: "https://primary.test/",
      mimeType: "image/png",
      rawType: "primary-raw",
    });
  });

  it("treats whitespace-only strings as null", () => {
    const inputs = parseAgentBrowserArtifactPayload({
      artifacts: [
        {
          kind: "   ",
          title: "\t\n ",
          path: "/tmp/valid.png",
          uri: "   ",
          text: "   ",
        },
      ],
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      kind: null,
      title: null,
      path: "/tmp/valid.png",
      uri: null,
      text: null,
    });
  });

  it("trims surrounding whitespace from accepted strings", () => {
    const inputs = parseAgentBrowserArtifactPayload({
      artifacts: [
        {
          kind: "  screenshot  ",
          path: "   /tmp/padded.png   ",
        },
      ],
    });
    expect(inputs[0]).toMatchObject({
      kind: "screenshot",
      path: "/tmp/padded.png",
    });
  });

  it("preserves record metadata when present and drops non-record metadata", () => {
    const inputs = parseAgentBrowserArtifactPayload({
      artifacts: [
        { path: "/tmp/has-meta.png", metadata: { region: "checkout" } },
        { path: "/tmp/no-meta.png", metadata: "stringly" },
      ],
    });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.metadata).toEqual({ region: "checkout" });
    expect(inputs[1]!.metadata).toBeNull();
  });

  it("drops entries that have no path/uri/text/json even with a kind or title", () => {
    const inputs = parseAgentBrowserArtifactPayload({
      artifacts: [
        { kind: "screenshot", title: "metadata-only" },
        { description: "no payload" },
      ],
    });
    expect(inputs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseAgentBrowserArtifactPayload — direct path mapping fields
// ---------------------------------------------------------------------------

describe("parseAgentBrowserArtifactPayload — direct path mappings", () => {
  it("maps screenshotPath to a screenshot input with sourceField metadata", () => {
    const inputs = parseAgentBrowserArtifactPayload({
      screenshotPath: "/tmp/ss.png",
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      kind: "screenshot",
      title: "Agent-browser screenshot",
      path: "/tmp/ss.png",
      rawType: "screenshotPath",
      metadata: { sourceField: "screenshotPath" },
    });
  });

  it("maps imagePath, videoPath, tracePath, consoleLogsPath, consoleLogPath, verificationPath", () => {
    const inputs = parseAgentBrowserArtifactPayload({
      imagePath: "/tmp/image.png",
      videoPath: "/tmp/rec.mp4",
      tracePath: "/tmp/trace.zip",
      consoleLogsPath: "/tmp/logs1.txt",
      consoleLogPath: "/tmp/logs2.txt",
      verificationPath: "/tmp/verify.json",
    });
    const byField = new Map(inputs.map((input) => [input.rawType, input]));
    expect(byField.get("imagePath")).toMatchObject({ kind: "screenshot", path: "/tmp/image.png" });
    expect(byField.get("videoPath")).toMatchObject({ kind: "video_recording", path: "/tmp/rec.mp4" });
    expect(byField.get("tracePath")).toMatchObject({ kind: "browser_trace", path: "/tmp/trace.zip" });
    expect(byField.get("consoleLogsPath")).toMatchObject({ kind: "console_logs", path: "/tmp/logs1.txt" });
    expect(byField.get("consoleLogPath")).toMatchObject({ kind: "console_logs", path: "/tmp/logs2.txt" });
    expect(byField.get("verificationPath")).toMatchObject({ kind: "browser_verification", path: "/tmp/verify.json" });
    expect(inputs).toHaveLength(6);
  });

  it("skips direct mapping fields that are empty or whitespace-only", () => {
    const inputs = parseAgentBrowserArtifactPayload({
      screenshotPath: "",
      videoPath: "   ",
      tracePath: null,
      verificationPath: "/tmp/verify.json",
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      kind: "browser_verification",
      path: "/tmp/verify.json",
    });
  });
});

// ---------------------------------------------------------------------------
// parseAgentBrowserArtifactPayload — direct text mapping fields
// ---------------------------------------------------------------------------

describe("parseAgentBrowserArtifactPayload — direct text mappings", () => {
  it("maps consoleLogs, consoleLog, and verificationText to text inputs", () => {
    const inputs = parseAgentBrowserArtifactPayload({
      consoleLogs: "plural logs",
      consoleLog: "singular log",
      verificationText: "ok",
    });
    const byField = new Map(inputs.map((input) => [input.rawType, input]));
    expect(byField.get("consoleLogs")).toMatchObject({
      kind: "console_logs",
      title: "Agent-browser console logs",
      text: "plural logs",
      metadata: { sourceField: "consoleLogs" },
    });
    expect(byField.get("consoleLog")).toMatchObject({
      kind: "console_logs",
      text: "singular log",
    });
    expect(byField.get("verificationText")).toMatchObject({
      kind: "browser_verification",
      text: "ok",
    });
    expect(inputs).toHaveLength(3);
  });

  it("skips direct text fields that are empty or whitespace-only", () => {
    const inputs = parseAgentBrowserArtifactPayload({
      consoleLogs: "",
      consoleLog: "   \n\t",
      verificationText: "verified",
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      kind: "browser_verification",
      text: "verified",
    });
  });

  it("combines artifacts[], direct path mappings, and direct text mappings", () => {
    const inputs = parseAgentBrowserArtifactPayload({
      artifacts: [{ kind: "screenshot", path: "/tmp/from-array.png" }],
      screenshotPath: "/tmp/from-direct.png",
      consoleLogs: "direct log",
    });
    expect(inputs).toHaveLength(3);
    const paths = inputs.map((input) => input.path);
    expect(paths).toContain("/tmp/from-array.png");
    expect(paths).toContain("/tmp/from-direct.png");
    const textEntries = inputs.filter((input) => input.text);
    expect(textEntries).toHaveLength(1);
    expect(textEntries[0]!.text).toBe("direct log");
  });
});

// ---------------------------------------------------------------------------
// loadAgentBrowserArtifactPayloadFromFile
// ---------------------------------------------------------------------------

describe("loadAgentBrowserArtifactPayloadFromFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-agent-browser-adapter-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads a JSON file and parses the payload", () => {
    const filePath = path.join(tmpDir, "payload.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        screenshotPath: "/tmp/shot.png",
        verificationText: "verified",
      }),
      "utf8",
    );
    const inputs = loadAgentBrowserArtifactPayloadFromFile(filePath);
    expect(inputs).toHaveLength(2);
    const kinds = inputs.map((input) => input.kind).sort();
    expect(kinds).toEqual(["browser_verification", "screenshot"]);
  });

  it("parses array-at-root JSON files", () => {
    const filePath = path.join(tmpDir, "array.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify([
        { kind: "screenshot", path: "/tmp/a.png" },
        { kind: "console_logs", text: "line" },
      ]),
      "utf8",
    );
    const inputs = loadAgentBrowserArtifactPayloadFromFile(filePath);
    expect(inputs).toHaveLength(2);
  });

  it("returns an empty array when the file contains JSON null", () => {
    const filePath = path.join(tmpDir, "null.json");
    fs.writeFileSync(filePath, "null", "utf8");
    expect(loadAgentBrowserArtifactPayloadFromFile(filePath)).toEqual([]);
  });

  it("throws a SyntaxError when the file contains invalid JSON", () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "{ not valid json", "utf8");
    expect(() => loadAgentBrowserArtifactPayloadFromFile(filePath)).toThrow(SyntaxError);
  });

  it("throws when the file does not exist", () => {
    const filePath = path.join(tmpDir, "missing.json");
    expect(() => loadAgentBrowserArtifactPayloadFromFile(filePath)).toThrow(/ENOENT|no such file/i);
  });
});
