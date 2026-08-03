import { describe, expect, it } from "vitest";
import { localIpcListenOptions } from "./localIpcListenOptions";

describe("localIpcListenOptions", () => {
  it("declares intended-user-only access for Windows named pipes", () => {
    expect(localIpcListenOptions("\\\\.\\pipe\\ade-runtime-stable-S-1-5-21-1000")).toEqual({
      path: "\\\\.\\pipe\\ade-runtime-stable-S-1-5-21-1000",
      readableAll: false,
      writableAll: false,
    });
    expect(localIpcListenOptions("//./pipe/ade-runtime-beta-S-1-5-21-1000")).toEqual({
      path: "//./pipe/ade-runtime-beta-S-1-5-21-1000",
      readableAll: false,
      writableAll: false,
    });
  });

  it("preserves Unix socket paths without Windows-only listen options", () => {
    expect(localIpcListenOptions("/tmp/ade-runtime.sock")).toBe("/tmp/ade-runtime.sock");
  });
});
