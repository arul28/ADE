import { describe, expect, it } from "vitest";
import { resolveDroidExecutable } from "./droidExecutable";

describe("resolveDroidExecutable", () => {
  it("uses the explicit developer override", () => {
    expect(resolveDroidExecutable({ env: { DROID_EXECUTABLE: "/opt/droid/bin/droid" } }))
      .toEqual({ path: "/opt/droid/bin/droid", source: "path" });
  });

  it("returns an empty path when no pinned copy or override is available", () => {
    expect(resolveDroidExecutable({
      env: { ADE_TOOLS_ROOT: "/no-such-ade-tools", PATH: "/usr/bin:/bin" },
      platform: "freebsd",
      arch: "x64",
    })).toEqual({ path: "", source: "fallback-command" });
  });
});
