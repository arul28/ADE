import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { removeProjectIconOverride, resolveProjectIcon, resolveProjectIconPath, setProjectIconOverride } from "./projectIconResolver";

function makeProjectRoot(): string {
  // Resolve through realpath so the assertions still hold on platforms
  // (macOS) where the system tmpdir is itself a symlink (e.g. `/var` ->
  // `/private/var`). The resolver returns canonical realpaths for callers.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-icon-")));
}

function writeFile(root: string, relativePath: string, contents: string | Buffer): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

describe("projectIconResolver", () => {
  it("prefers well-known favicon files", () => {
    const root = makeProjectRoot();
    const iconPath = writeFile(root, "favicon.svg", "<svg>favicon</svg>");

    expect(resolveProjectIconPath(root)).toBe(iconPath);
  });

  it("resolves icon hrefs from project source files", () => {
    const root = makeProjectRoot();
    writeFile(root, "index.html", '<link rel="icon" href="/brand/logo.svg">');
    const iconPath = writeFile(root, "public/brand/logo.svg", "<svg>brand</svg>");

    expect(resolveProjectIconPath(root)).toBe(iconPath);
  });

  it("detects nested app icons in monorepos", () => {
    const root = makeProjectRoot();
    writeFile(root, "favicon.svg", "<svg>docs</svg>");
    const iconPath = writeFile(root, "apps/web/app/icon.png", Buffer.from("png"));

    expect(resolveProjectIconPath(root)).toBe(iconPath);
  });

  it("uses a tracked project icon override before auto-detection", () => {
    const root = makeProjectRoot();
    writeFile(root, "apps/web/app/icon.png", Buffer.from("auto"));
    const iconPath = writeFile(root, "brand/custom-logo.svg", "<svg>brand</svg>");
    writeFile(root, ".ade/ade.yaml", "version: 1\nproject:\n  iconPath: brand/custom-logo.svg\n");

    expect(resolveProjectIconPath(root)).toBe(iconPath);
  });

  it("persists selected icons as project-relative tracked config", () => {
    const root = makeProjectRoot();
    const iconPath = writeFile(root, "assets/icon.svg", "<svg>brand</svg>");

    const icon = setProjectIconOverride(root, iconPath);

    expect(icon.sourcePath).toBe(iconPath);
    expect(fs.readFileSync(path.join(root, ".ade", "ade.yaml"), "utf8")).toContain("iconPath: assets/icon.svg");
  });

  it("can explicitly disable automatic icon detection", () => {
    const root = makeProjectRoot();
    writeFile(root, "apps/web/app/icon.png", Buffer.from("auto"));

    const icon = removeProjectIconOverride(root);

    expect(icon.sourcePath).toBeNull();
    expect(resolveProjectIconPath(root)).toBeNull();
    expect(fs.readFileSync(path.join(root, ".ade", "ade.yaml"), "utf8")).toContain("iconPath: null");
  });

  it("does not resolve linked icons outside the project root", () => {
    const root = makeProjectRoot();
    writeFile(path.dirname(root), "outside.svg", "<svg>outside</svg>");
    writeFile(root, "index.html", '<link rel="icon" href="../outside.svg">');

    expect(resolveProjectIconPath(root)).toBeNull();
  });

  it("does not follow a symlinked icon directory outside the project root", () => {
    const root = makeProjectRoot();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-outside-")));
    fs.writeFileSync(path.join(outside, "favicon.svg"), "<svg>outside</svg>");
    // Symlink `<root>/public` -> `<outside>` so any `public/<icon>` candidate
    // would escape the project root if resolved lexically.
    fs.symlinkSync(outside, path.join(root, "public"));

    expect(resolveProjectIconPath(root)).toBeNull();
  });

  it("returns a data URL for resolved icons", () => {
    const root = makeProjectRoot();
    writeFile(root, "favicon.svg", "<svg>favicon</svg>");

    const icon = resolveProjectIcon(root);

    expect(icon.mimeType).toBe("image/svg+xml");
    expect(icon.sourcePath).toContain("favicon.svg");
    expect(icon.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
  });
});
