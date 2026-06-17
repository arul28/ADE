import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const shellOpenExternal = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  shell: {
    openExternal: shellOpenExternal,
  },
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { normalizeExternalUrl, openExternalUrl } from "./externalLinks";

const mockedExecFile = vi.mocked(execFile);

function mockPlatform(platform: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  return () => {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  };
}

describe("externalLinks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    shellOpenExternal.mockReset();
    mockedExecFile.mockReset();
  });

  it("normalizes and allows http, https, and mailto URLs", () => {
    expect(normalizeExternalUrl(" https://github.com/ade-dev/ade/pull/42 ")).toBe(
      "https://github.com/ade-dev/ade/pull/42",
    );
    expect(normalizeExternalUrl("mailto:test@example.com")).toBe("mailto:test@example.com");
  });

  it("rejects unsupported schemes", () => {
    expect(() => normalizeExternalUrl("file:///tmp/a.txt")).toThrow(/Only http/);
    expect(() => normalizeExternalUrl("not a url")).toThrow(/Invalid URL/);
  });

  it("uses /usr/bin/open on macOS", async () => {
    const restorePlatform = mockPlatform("darwin");
    mockedExecFile.mockImplementation((_file, _args, _options, cb) => {
      cb?.(null as never, "" as never, "" as never);
      return {} as never;
    });

    await openExternalUrl("https://github.com/acme/ade/pull/1");

    expect(mockedExecFile).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["https://github.com/acme/ade/pull/1"],
      { timeout: 5_000, windowsHide: true },
      expect.any(Function),
    );
    expect(shellOpenExternal).not.toHaveBeenCalled();
    restorePlatform();
  });

  it("falls back to Electron shell when macOS open fails", async () => {
    const restorePlatform = mockPlatform("darwin");
    mockedExecFile.mockImplementation((_file, _args, _options, cb) => {
      cb?.(new Error("open failed") as never, "" as never, "" as never);
      return {} as never;
    });
    shellOpenExternal.mockResolvedValue(undefined);

    await openExternalUrl("https://github.com/acme/ade/pull/1");

    expect(shellOpenExternal).toHaveBeenCalledWith("https://github.com/acme/ade/pull/1");
    restorePlatform();
  });
});
