import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveProjectIcon, resolveProjectIconPath } from "./projectIconResolver";

function makeProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-icon-"));
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

  it("does not resolve linked icons outside the project root", () => {
    const root = makeProjectRoot();
    writeFile(path.dirname(root), "outside.svg", "<svg>outside</svg>");
    writeFile(root, "index.html", '<link rel="icon" href="../outside.svg">');

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
