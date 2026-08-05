import { describe, expect, it } from "vitest";
import { ToolError } from "./errors";
import {
  TOOLS_MANIFEST_SCHEMA_VERSION,
  entryPathForPlatform,
  findToolTargetPin,
  loadToolsManifest,
  parseToolsManifest,
} from "./manifest";
import { TOOL_TARGETS, resolveMachineToolsRoot } from "./paths";

const VALID_PIN = {
  package: "demo-tool-darwin-arm64",
  version: "1.2.3",
  tarball: "https://registry.npmjs.org/demo-tool-darwin-arm64/-/demo-tool-darwin-arm64-1.2.3.tgz",
  integrity: "sha512-YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWjAxMjM0NTY3ODk=",
};

function manifestWith(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: TOOLS_MANIFEST_SCHEMA_VERSION,
    generatedFrom: "apps/ade-cli/package-lock.json",
    tools: [
      {
        name: "demo",
        description: "Demo tool.",
        entry: { kind: "binary", path: "bin/demo", windowsPath: "bin/demo.exe" },
        targets: { "darwin-arm64": VALID_PIN },
      },
    ],
    ...overrides,
  };
}

function expectManifestRejection(raw: unknown, matcher: RegExp): void {
  let thrown: unknown;
  try {
    parseToolsManifest(raw);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ToolError);
  expect((thrown as ToolError).kind).toBe("manifest");
  expect((thrown as ToolError).message).toMatch(matcher);
}

describe("parseToolsManifest", () => {
  it("accepts a well-formed manifest", () => {
    const parsed = parseToolsManifest(manifestWith());
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].targets["darwin-arm64"]).toEqual(VALID_PIN);
  });

  it("refuses a schema version this build does not understand", () => {
    expectManifestRejection(manifestWith({ schemaVersion: 99 }), /schemaVersion 99/);
  });

  it("refuses a package name that would escape the tools root", () => {
    const raw = manifestWith({
      tools: [
        {
          name: "demo",
          description: "Demo tool.",
          entry: { kind: "binary", path: "bin/demo" },
          targets: { "darwin-arm64": { ...VALID_PIN, package: "../../../etc" } },
        },
      ],
    });
    expectManifestRejection(raw, /package name/);
  });

  it("refuses a version that would escape the tools root", () => {
    const raw = manifestWith({
      tools: [
        {
          name: "demo",
          description: "Demo tool.",
          entry: { kind: "binary", path: "bin/demo" },
          targets: { "darwin-arm64": { ...VALID_PIN, version: "../1.2.3" } },
        },
      ],
    });
    expectManifestRejection(raw, /version/);
  });

  it("refuses an entry path that climbs out of the package", () => {
    const raw = manifestWith({
      tools: [
        {
          name: "demo",
          description: "Demo tool.",
          entry: { kind: "binary", path: "../../bin/demo" },
          targets: { "darwin-arm64": VALID_PIN },
        },
      ],
    });
    expectManifestRejection(raw, /traversal/);
  });

  it("refuses a non-sha512 integrity string", () => {
    const raw = manifestWith({
      tools: [
        {
          name: "demo",
          description: "Demo tool.",
          entry: { kind: "binary", path: "bin/demo" },
          targets: { "darwin-arm64": { ...VALID_PIN, integrity: "sha256-abcdef" } },
        },
      ],
    });
    expectManifestRejection(raw, /sha512/);
  });

  it("refuses a non-HTTPS tarball URL", () => {
    const raw = manifestWith({
      tools: [
        {
          name: "demo",
          description: "Demo tool.",
          entry: { kind: "binary", path: "bin/demo" },
          targets: { "darwin-arm64": { ...VALID_PIN, tarball: "http://registry.npmjs.org/x.tgz" } },
        },
      ],
    });
    expectManifestRejection(raw, /https/);
  });

  it("refuses a target this build cannot install", () => {
    const raw = manifestWith({
      tools: [
        {
          name: "demo",
          description: "Demo tool.",
          entry: { kind: "binary", path: "bin/demo" },
          targets: { "freebsd-x64": VALID_PIN },
        },
      ],
    });
    expectManifestRejection(raw, /not a supported target/);
  });

  it("refuses duplicate tool names", () => {
    const tool = {
      name: "demo",
      description: "Demo tool.",
      entry: { kind: "binary", path: "bin/demo" },
      targets: { "darwin-arm64": VALID_PIN },
    };
    expectManifestRejection(manifestWith({ tools: [tool, tool] }), /duplicate tool/);
  });
});

describe("generated tools manifest", () => {
  const manifest = loadToolsManifest();

  it("pins every supported target for every tool", () => {
    expect(manifest.tools.map((tool) => tool.name)).toEqual(["codex", "claude-code", "opencode"]);
    for (const tool of manifest.tools) {
      expect(Object.keys(tool.targets).sort()).toEqual([...TOOL_TARGETS].sort());
    }
  });

  it("maps win32-x64 opencode to the baseline build the desktop bundle actually ships", () => {
    // apps/desktop/package.json excludes node_modules/opencode-windows-x64/**
    // and openCodeBinaryManager.ts resolves win32/x64 to the baseline build,
    // which does not require AVX2. Regressing this ships a binary that crashes
    // on pre-Haswell CPUs.
    const pin = findToolTargetPin(manifest, "opencode", "win32-x64");
    expect(pin.package).toBe("opencode-windows-x64-baseline");
  });

  it("keeps the codex alias version, which is not plain semver", () => {
    const pin = findToolTargetPin(manifest, "codex", "darwin-arm64");
    expect(pin.package).toBe("@openai/codex-darwin-arm64");
    expect(pin.version).toBe("0.144.5-darwin-arm64");
    // The alias publishes under the base package path, not the suffixed one.
    expect(pin.tarball).toContain("/@openai/codex/-/codex-0.144.5-darwin-arm64.tgz");
  });

  it("uses .exe entry spellings on Windows", () => {
    const codex = manifest.tools.find((tool) => tool.name === "codex")!;
    expect(entryPathForPlatform(codex.entry, "darwin")).toBe("vendor/*/bin/codex");
    expect(entryPathForPlatform(codex.entry, "win32")).toBe("vendor/*/bin/codex.exe");
  });
});

describe("resolveMachineToolsRoot", () => {
  it("is channel-independent so stable, beta, and the brain share one cache", () => {
    const stable = resolveMachineToolsRoot({ HOME: "/Users/x", ADE_HOME: "/Users/x/.ade" }, "darwin");
    const beta = resolveMachineToolsRoot({ HOME: "/Users/x", ADE_HOME: "/Users/x/.ade-beta" }, "darwin");
    expect(beta).toBe(stable);
    expect(stable).toBe("/Users/x/.ade/tools");
  });

  it("lands under LOCALAPPDATA on Windows so 650 MB never roams", () => {
    const root = resolveMachineToolsRoot({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "win32");
    expect(root).toBe("C:\\Users\\x\\AppData\\Local\\ADE\\tools");
  });

  it("falls back to the Windows profile when LOCALAPPDATA is absent", () => {
    const root = resolveMachineToolsRoot({ USERPROFILE: "C:\\Users\\x" }, "win32");
    expect(root).toBe("C:\\Users\\x\\AppData\\Local\\ADE\\tools");
  });

  it("honours an explicit ADE_TOOLS_ROOT override", () => {
    expect(resolveMachineToolsRoot({ ADE_TOOLS_ROOT: "/volumes/big/tools" }, "darwin"))
      .toBe("/volumes/big/tools");
  });
});
