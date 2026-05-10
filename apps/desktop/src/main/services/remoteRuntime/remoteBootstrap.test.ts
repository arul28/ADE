import { describe, expect, it } from "vitest";
import {
  buildRemoteRuntimeEnvironmentPrefix,
  normalizeRemoteArch,
  normalizeRuntimeVersion,
  resolveRemoteRuntimeLayout,
  selectRemoteRuntimeVersion,
  shouldUploadBundledRuntime,
  validateRemoteRuntimeInitializeResult,
} from "./remoteBootstrap";

describe("normalizeRemoteArch", () => {
  it("normalizes supported uname platform and architecture pairs", () => {
    expect(normalizeRemoteArch("Darwin arm64")).toEqual({
      platform: "darwin",
      arch: "arm64",
      label: "darwin-arm64",
    });
    expect(normalizeRemoteArch("Linux x86_64")).toEqual({
      platform: "linux",
      arch: "x64",
      label: "linux-x64",
    });
    expect(normalizeRemoteArch("Linux aarch64")).toEqual({
      platform: "linux",
      arch: "arm64",
      label: "linux-arm64",
    });
  });

  it("rejects unsupported remote ADE service targets instead of guessing", () => {
    expect(() => normalizeRemoteArch("FreeBSD riscv64")).toThrow(/unsupported remote ade service platform/i);
    expect(() => normalizeRemoteArch("Linux riscv64")).toThrow(/unsupported remote ade service platform/i);
  });
});

describe("normalizeRuntimeVersion", () => {
  it("normalizes plain and prefixed ADE version output", () => {
    expect(normalizeRuntimeVersion("1.0.0-beta.1\n")).toBe("1.0.0-beta.1");
    expect(normalizeRuntimeVersion("ade 1.0.0-beta.1\n")).toBe("1.0.0-beta.1");
  });

  it("returns null for empty version output", () => {
    expect(normalizeRuntimeVersion("\n")).toBeNull();
  });
});

describe("selectRemoteRuntimeVersion", () => {
  it("prefers executable output over the marker file", () => {
    expect(selectRemoteRuntimeVersion({
      markerVersion: "1.0.0",
      executableVersion: "1.0.1",
    })).toBe("1.0.1");
  });

  it("uses the marker when the executable cannot report a version", () => {
    expect(selectRemoteRuntimeVersion({
      markerVersion: "1.0.0",
      executableVersion: null,
    })).toBe("1.0.0");
  });
});

describe("shouldUploadBundledRuntime", () => {
  it("uploads when the marker matches but the remote executable is missing", () => {
    expect(shouldUploadBundledRuntime({
      localBinaryAvailable: true,
      executableVersion: null,
      appVersion: "1.0.0",
    })).toBe(true);
  });

  it("skips upload when the executable itself matches the desktop version", () => {
    expect(shouldUploadBundledRuntime({
      localBinaryAvailable: true,
      executableVersion: "1.0.0",
      appVersion: "1.0.0",
    })).toBe(false);
  });

  it("does not upload when no bundled runtime exists for the remote architecture", () => {
    expect(shouldUploadBundledRuntime({
      localBinaryAvailable: false,
      executableVersion: null,
      appVersion: "1.0.0",
    })).toBe(false);
  });
});

describe("buildRemoteRuntimeEnvironmentPrefix", () => {
  it("adds ADE and user-install bins to the remote runtime PATH", () => {
    expect(buildRemoteRuntimeEnvironmentPrefix({
      archLabel: "linux-x64",
      nativeDepsReady: false,
    })).toBe('ADE_HOME="$HOME/.ade" PATH="$HOME/.ade/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ');
  });

  it("adds the uploaded native dependency bundle to NODE_PATH", () => {
    expect(buildRemoteRuntimeEnvironmentPrefix({
      archLabel: "darwin-arm64",
      nativeDepsReady: true,
    })).toContain('NODE_PATH="$HOME/.ade/runtime/darwin-arm64/node_modules${NODE_PATH:+:$NODE_PATH}"');
  });

  it("uses isolated remote paths for Alpha and Beta channels", () => {
    const alphaLayout = resolveRemoteRuntimeLayout({ ADE_PACKAGE_CHANNEL: "alpha" } as NodeJS.ProcessEnv);
    const betaLayout = resolveRemoteRuntimeLayout({ ADE_PACKAGE_CHANNEL: "beta" } as NodeJS.ProcessEnv);

    expect(alphaLayout).toMatchObject({
      homeDirName: ".ade-alpha",
      binaryRelative: ".ade-alpha/bin/ade",
      versionExpr: "$HOME/.ade-alpha/bin/ade.version",
    });
    expect(buildRemoteRuntimeEnvironmentPrefix({
      archLabel: "darwin-arm64",
      nativeDepsReady: true,
      layout: alphaLayout,
    })).toBe('ADE_HOME="$HOME/.ade-alpha" PATH="$HOME/.ade-alpha/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_PACKAGE_CHANNEL="alpha" ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1 NODE_PATH="$HOME/.ade-alpha/runtime/darwin-arm64/node_modules${NODE_PATH:+:$NODE_PATH}" ');
    expect(betaLayout).toMatchObject({
      homeDirName: ".ade-beta",
      binaryRelative: ".ade-beta/bin/ade",
      versionExpr: "$HOME/.ade-beta/bin/ade.version",
    });
  });
});

describe("validateRemoteRuntimeInitializeResult", () => {
  it("accepts a multi-project runtime with the expected version", () => {
    expect(() => validateRemoteRuntimeInitializeResult({
      expectedVersion: "1.0.0",
      result: {
        runtimeInfo: { version: "1.0.0", multiProject: true },
        capabilities: { projects: true },
      },
    })).not.toThrow();
  });

  it("rejects a stale single-project runtime", () => {
    expect(() => validateRemoteRuntimeInitializeResult({
      expectedVersion: null,
      result: {
        runtimeInfo: { version: "0.9.0" },
        capabilities: { actions: { listChanged: true } },
      },
    })).toThrow(/multi-project/i);
  });

  it("rejects a bundled runtime with the wrong reported version", () => {
    expect(() => validateRemoteRuntimeInitializeResult({
      expectedVersion: "1.0.0",
      result: {
        runtimeInfo: { version: "0.9.0", multiProject: true },
        capabilities: { projects: true },
      },
    })).toThrow(/version mismatch/i);
  });
});
