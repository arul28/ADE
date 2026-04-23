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

  it("uses realpath canonical casing for the pipe id on Windows", () => {
    setPlatform("win32");
    // Windows *can* host case-sensitive trees (WSL/DrvFs interop), so we must
    // not force-lowercase the path. Instead we rely on realpathSync.native to
    // return canonical casing for case-insensitive filesystems — then two
    // case-variant spellings of the same directory produce the same hash.
    vi.spyOn(fs.realpathSync, "native").mockImplementation((value) => {
      const raw = String(value);
      if (raw.toLowerCase() === "c:\\repo") return "C:\\Repo";
      throw new Error(`unexpected path: ${raw}`);
    });
    const a = resolveAdeMcpIpcPath("C:\\Repo");
    const b = resolveAdeMcpIpcPath("c:\\repo");
    expect(a).toBe(b);
    const id = createHash("sha256").update(path.win32.resolve("C:\\Repo")).digest("hex").slice(0, 24);
    expect(a).toBe(`\\\\.\\pipe\\ade-${id}`);
  });

  it("preserves case-sensitive distinctions when realpath reports different canonical paths", () => {
    setPlatform("win32");
    // Case-sensitive directories (e.g. WSL DrvFs-mounted trees): realpath
    // returns the literal casing, so the hash must differ.
    vi.spyOn(fs.realpathSync, "native").mockImplementation((value) => {
      const raw = String(value);
      if (raw === "C:\\Work\\Repo") return "C:\\Work\\Repo";
      if (raw === "C:\\Work\\repo") return "C:\\Work\\repo";
      throw new Error(`unexpected path: ${raw}`);
    });
    expect(resolveAdeMcpIpcPath("C:\\Work\\Repo")).not.toBe(resolveAdeMcpIpcPath("C:\\Work\\repo"));
  });

  it("canonicalizes Windows path separators and dot segments before hashing", () => {
    setPlatform("win32");
    vi.spyOn(fs.realpathSync, "native").mockImplementation((value) => {
      const raw = String(value);
      // realpath expands the `..` segment and returns canonical casing.
      const normalized = path.win32.resolve(raw.replace(/\//g, "\\"));
      if (normalized.toLowerCase() === "c:\\repo") return "C:\\Repo";
      throw new Error(`unexpected path: ${raw}`);
    });
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
