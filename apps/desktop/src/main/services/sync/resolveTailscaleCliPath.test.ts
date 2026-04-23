import { describe, expect, it } from "vitest";
import { resolveTailscaleCliPath } from "./resolveTailscaleCliPath";

describe("resolveTailscaleCliPath", () => {
  it("uses ADE_TAILSCALE_CLI when set", () => {
    expect(
      resolveTailscaleCliPath({
        env: { ...process.env, ADE_TAILSCALE_CLI: "C:\\custom\\tailscale.exe" },
      }),
    ).toBe("C:\\custom\\tailscale.exe");
  });

  it("prefers a default Windows install path when that exe exists", () => {
    const target = "C:\\Program Files\\Tailscale\\tailscale.exe";
    expect(
      resolveTailscaleCliPath({
        platform: "win32",
        env: { ...process.env, ProgramFiles: "C:\\Program Files" },
        existsSync: (p) => String(p) === target,
      }),
    ).toBe(target);
  });

  it("returns tailscale when no Windows default exists", () => {
    expect(
      resolveTailscaleCliPath({
        platform: "win32",
        env: { ...process.env, ProgramFiles: "C:\\Program Files" },
        existsSync: () => false,
      }),
    ).toBe("tailscale");
  });
});
