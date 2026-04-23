import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAdeMcpNamedPipePath, resolveAdeMcpIpcPath } from "./adeMcpIpc";

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  setPlatform(originalPlatform);
});

describe("resolveAdeMcpIpcPath", () => {
  it("uses a named pipe on Windows", () => {
    setPlatform("win32");
    const root = "C:\\Projects\\MyRepo";
    const resolved = resolveAdeMcpIpcPath(root);
    expect(resolved.toLowerCase()).toMatch(/^\\\\\.\\pipe\\ade-/);
    expect(isAdeMcpNamedPipePath(resolved)).toBe(true);
  });

  it("uses a stable pipe name for the same project root", () => {
    setPlatform("win32");
    const root = path.resolve("/workspace/project");
    expect(resolveAdeMcpIpcPath(root)).toBe(resolveAdeMcpIpcPath(root));
  });

  it("uses .ade/ade.sock on Unix", () => {
    setPlatform("linux");
    const root = "/workspace/project";
    expect(resolveAdeMcpIpcPath(root)).toBe(path.join(root, ".ade", "ade.sock"));
  });

  it("normalizes project root casing on Windows for pipe id", () => {
    setPlatform("win32");
    const a = resolveAdeMcpIpcPath("C:\\Repo");
    const b = resolveAdeMcpIpcPath("c:\\repo");
    expect(a).toBe(b);
    const id = createHash("sha256").update(path.win32.resolve("C:\\Repo").toLowerCase()).digest("hex").slice(0, 24);
    expect(a).toBe(`\\\\.\\pipe\\ade-${id}`);
  });

  it("canonicalizes Windows path separators and dot segments before hashing", () => {
    setPlatform("win32");
    expect(resolveAdeMcpIpcPath("C:/Repo/child/..")).toBe(resolveAdeMcpIpcPath("c:\\repo"));
  });

  it("uses native realpath on Windows when available before hashing", () => {
    setPlatform("win32");
    vi.spyOn(fs.realpathSync, "native").mockImplementation((value) => {
      const raw = String(value).toLowerCase();
      if (raw === "c:\\alias") return "C:\\Canonical";
      if (raw === "c:\\canonical") return "C:\\Canonical";
      throw new Error("unexpected path");
    });

    expect(resolveAdeMcpIpcPath("C:\\Alias")).toBe(resolveAdeMcpIpcPath("C:\\Canonical"));
  });
});
