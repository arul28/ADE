import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEventEnvelope } from "../../../../desktop/src/shared/types/chat";
import {
  latestOpenableImageTarget,
  normalizeOpenableImageTarget,
  parseAppleScriptClipboardData,
  readClipboardImageAttachment,
  readImageDimensionsFromBuffer,
} from "../imageTargets";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const spawnSyncMock = vi.mocked(spawnSync);
const processPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function pngBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value });
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 1, stdout: "" } as ReturnType<typeof spawnSync>);
});

afterEach(() => {
  if (processPlatform) Object.defineProperty(process, "platform", processPlatform);
});

describe("normalizeOpenableImageTarget", () => {
  it("allows http and https URLs", () => {
    expect(normalizeOpenableImageTarget("https://example.test/image")).toBe(
      "https://example.test/image",
    );
    expect(normalizeOpenableImageTarget("http://example.test/image.png?sig=1")).toBe(
      "http://example.test/image.png?sig=1",
    );
  });

  it("allows absolute image file paths", () => {
    const target = path.resolve("proof.PNG");
    expect(normalizeOpenableImageTarget(target)).toBe(target);
  });

  it("rejects data URLs, file URLs, relative paths, and executable names", () => {
    expect(normalizeOpenableImageTarget("data:image/png;base64,AAAA")).toBeNull();
    expect(normalizeOpenableImageTarget("file:///tmp/proof.png")).toBeNull();
    expect(normalizeOpenableImageTarget("proof.png")).toBeNull();
    expect(normalizeOpenableImageTarget("calc.exe")).toBeNull();
  });

  it("rejects absolute non-image file paths", () => {
    expect(normalizeOpenableImageTarget(path.resolve("notes.txt"))).toBeNull();
  });
});

describe("latestOpenableImageTarget", () => {
  const envelope = (
    sequence: number,
    event: AgentChatEventEnvelope["event"],
  ): AgentChatEventEnvelope => ({
    sequence,
    timestamp: `2026-01-01T00:00:0${sequence}.000Z`,
    sessionId: "session-1",
    event,
  });

  it("prefers saved image files over base64 generation results", () => {
    const savedPath = path.resolve("generated.png");
    expect(latestOpenableImageTarget([
      envelope(1, {
        type: "codex_image_generation",
        result: "data:image/png;base64,AAAA",
        savedPath,
      } as AgentChatEventEnvelope["event"]),
    ])).toBe(savedPath);
  });

  it("falls back to openable result URLs for generated images", () => {
    expect(latestOpenableImageTarget([
      envelope(1, {
        type: "codex_image_generation",
        result: "https://example.test/generated.png",
      } as AgentChatEventEnvelope["event"]),
    ])).toBe("https://example.test/generated.png");
  });

  it("walks backward through recent image events", () => {
    const olderPath = path.resolve("older.png");
    expect(latestOpenableImageTarget([
      envelope(1, { type: "codex_image_view", path: olderPath } as AgentChatEventEnvelope["event"]),
      envelope(2, {
        type: "codex_image_generation",
        result: "data:image/png;base64,AAAA",
      } as AgentChatEventEnvelope["event"]),
    ])).toBe(olderPath);
  });
});

describe("clipboard image helpers", () => {
  it("parses AppleScript clipboard data records", () => {
    expect(parseAppleScriptClipboardData("«data PNGf89504E47»")).toEqual(Buffer.from("89504E47", "hex"));
  });

  it("reads PNG dimensions from a pasted screenshot buffer", () => {
    expect(readImageDimensionsFromBuffer(pngBuffer(1280, 760))).toEqual({ width: 1280, height: 760 });
  });

  it("uses macOS AppleScript PNG data when pngpaste is unavailable", () => {
    setPlatform("darwin");
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-image-targets-"));
    const payload = pngBuffer(1280, 760);
    spawnSyncMock.mockImplementation((command, args) => {
      if (command === "command" && Array.isArray(args) && args[1] === "osascript") {
        return { status: 0, stdout: "" } as ReturnType<typeof spawnSync>;
      }
      if (command === "osascript") {
        return { status: 0, stdout: `«data PNGf${payload.toString("hex").toUpperCase()}»` } as ReturnType<typeof spawnSync>;
      }
      return { status: 1, stdout: "" } as ReturnType<typeof spawnSync>;
    });

    const attachment = readClipboardImageAttachment(workspaceRoot);

    expect(attachment?.type).toBe("image");
    expect(attachment?.path).toContain(path.join(".ade", "cache", "ade-code-clipboard", "pasted-screenshot-"));
    expect(attachment?.path.endsWith(".png")).toBe(true);
    expect(fs.readFileSync(attachment!.path)).toEqual(payload);
  });

  it("does not save arbitrary pbpaste text as an image", () => {
    setPlatform("darwin");
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-image-targets-"));
    spawnSyncMock.mockImplementation((command, args) => {
      if (command === "command" && Array.isArray(args) && (args[1] === "pbpaste" || args[1] === "osascript")) {
        return { status: 0, stdout: "" } as ReturnType<typeof spawnSync>;
      }
      if (command === "pbpaste" && Array.isArray(args) && args.includes("-Prefer")) {
        return { status: 0, stdout: Buffer.from("not an image") } as ReturnType<typeof spawnSync>;
      }
      if (command === "pbpaste") {
        return { status: 1, stdout: "" } as ReturnType<typeof spawnSync>;
      }
      return { status: 1, stdout: "" } as ReturnType<typeof spawnSync>;
    });

    expect(readClipboardImageAttachment(workspaceRoot)).toBeNull();
    expect(fs.existsSync(path.join(workspaceRoot, ".ade", "cache", "ade-code-clipboard"))).toBe(false);
  });
});
