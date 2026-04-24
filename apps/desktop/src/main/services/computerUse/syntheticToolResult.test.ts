import { describe, expect, it } from "vitest";
import { extractArtifactPathsFromArgs, maybeSyntheticToolResult } from "./syntheticToolResult";

// ---------------------------------------------------------------------------
// Unit tests for extractArtifactPathsFromArgs
// ---------------------------------------------------------------------------

describe("extractArtifactPathsFromArgs", () => {
  it("extracts a png path from a Bash command string", () => {
    const paths = extractArtifactPathsFromArgs({
      command: "screenshot /tmp/proof.png",
    });
    expect(paths).toEqual(["/tmp/proof.png"]);
  });

  it("extracts multiple artifact paths from a single command", () => {
    const paths = extractArtifactPathsFromArgs({
      command: "cp /home/user/screenshot.png /tmp/trace.zip && cat /var/log/app.log",
    });
    expect(paths).toContain("/home/user/screenshot.png");
    expect(paths).toContain("/tmp/trace.zip");
    expect(paths).toContain("/var/log/app.log");
    expect(paths).toHaveLength(3);
  });

  it("extracts image path from Read tool args", () => {
    const paths = extractArtifactPathsFromArgs({
      file_path: "/Users/dev/captures/test-result.jpg",
    });
    expect(paths).toEqual(["/Users/dev/captures/test-result.jpg"]);
  });

  it("extracts paths from nested object structures", () => {
    const paths = extractArtifactPathsFromArgs({
      options: {
        output: {
          screenshot: "/tmp/nested/shot.webp",
        },
      },
    });
    expect(paths).toEqual(["/tmp/nested/shot.webp"]);
  });

  it("extracts paths from arrays", () => {
    const paths = extractArtifactPathsFromArgs({
      files: ["/a/b.png", "/c/d.mp4"],
    });
    expect(paths).toContain("/a/b.png");
    expect(paths).toContain("/c/d.mp4");
    expect(paths).toHaveLength(2);
  });

  it("ignores relative paths (no leading slash)", () => {
    const paths = extractArtifactPathsFromArgs({
      command: "cat relative/path.png",
    });
    expect(paths).toEqual([]);
  });

  it("returns empty for args with no artifact paths", () => {
    const paths = extractArtifactPathsFromArgs({
      command: "echo hello world",
    });
    expect(paths).toEqual([]);
  });

  it("returns empty for non-artifact extensions", () => {
    const paths = extractArtifactPathsFromArgs({
      file_path: "/tmp/data.json",
    });
    expect(paths).toEqual([]);
  });

  it("deduplicates repeated paths", () => {
    const paths = extractArtifactPathsFromArgs({
      a: "/tmp/shot.png",
      b: "/tmp/shot.png",
    });
    expect(paths).toEqual(["/tmp/shot.png"]);
  });

  it("handles null/undefined/number args gracefully", () => {
    expect(extractArtifactPathsFromArgs(null)).toEqual([]);
    expect(extractArtifactPathsFromArgs(undefined)).toEqual([]);
    expect(extractArtifactPathsFromArgs(42)).toEqual([]);
    expect(extractArtifactPathsFromArgs("")).toEqual([]);
  });

  it("respects recursion depth limit", () => {
    // Build deeply nested structure (depth > 8)
    let obj: any = { path: "/tmp/deep.png" };
    for (let i = 0; i < 12; i++) {
      obj = { nested: obj };
    }
    // The path is at depth 13 — beyond the limit of 8
    const paths = extractArtifactPathsFromArgs(obj);
    expect(paths).toEqual([]);
  });

  it("handles video extensions", () => {
    const paths = extractArtifactPathsFromArgs({
      command: "ffmpeg -o /tmp/recording.mp4",
    });
    expect(paths).toEqual(["/tmp/recording.mp4"]);
  });

  it("handles trace extensions", () => {
    const paths = extractArtifactPathsFromArgs({
      command: "playwright trace /tmp/session.trace",
    });
    expect(paths).toEqual(["/tmp/session.trace"]);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for maybeSyntheticToolResult
// ---------------------------------------------------------------------------

describe("maybeSyntheticToolResult", () => {
  it("returns null when no artifact paths found", () => {
    const result = maybeSyntheticToolResult("Bash", { command: "echo hi" }, "item-1", "turn-1");
    expect(result).toBeNull();
  });

  it("returns a tool_result event with artifact paths", () => {
    const result = maybeSyntheticToolResult(
      "Bash",
      { command: "screenshot /tmp/proof.png" },
      "item-1",
      "turn-1",
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("tool_result");
    expect(result).toMatchObject({
      type: "tool_result",
      tool: "Bash",
      itemId: "item-1:synthetic",
      turnId: "turn-1",
      status: "completed",
    });
    // The result object contains the artifact path
    expect((result as any).result).toMatchObject({
      artifactPath0: "/tmp/proof.png",
    });
  });

  it("includes multiple artifact paths in the result", () => {
    const result = maybeSyntheticToolResult(
      "Bash",
      { command: "cp /tmp/a.png /tmp/b.mp4" },
      "item-2",
      "turn-2",
    );
    expect(result).not.toBeNull();
    const resultObj = (result as any).result;
    expect(resultObj.artifactPath0).toBe("/tmp/a.png");
    expect(resultObj.artifactPath1).toBe("/tmp/b.mp4");
  });

  it("appends :synthetic to the itemId to avoid collisions", () => {
    const result = maybeSyntheticToolResult(
      "Read",
      { file_path: "/tmp/shot.png" },
      "orig-id",
      undefined,
    );
    expect((result as any).itemId).toBe("orig-id:synthetic");
  });
});

