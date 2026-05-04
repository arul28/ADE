import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  removeProjectIconOverride,
  resolveProjectIcon,
  resolveProjectIconPath,
  setProjectIconOverride,
  setProjectIconOverrideFromSelection,
} from "./projectIconResolver";

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

  it("detects iOS app icons from asset catalogs", () => {
    const root = makeProjectRoot();
    writeFile(root, "apps/ios/ADE/Assets.xcassets/AppIcon.appiconset/Contents.json", JSON.stringify({
      images: [
        { filename: "Icon-App-20x20@2x.png", idiom: "iphone", size: "20x20", scale: "2x" },
        { filename: "Icon-App-1024x1024@1x.png", idiom: "ios-marketing", size: "1024x1024", scale: "1x" },
      ],
      info: { author: "xcode", version: 1 },
    }));
    writeFile(root, "apps/ios/ADE/Assets.xcassets/AppIcon.appiconset/Icon-App-20x20@2x.png", Buffer.from("small"));
    const iconPath = writeFile(root, "apps/ios/ADE/Assets.xcassets/AppIcon.appiconset/Icon-App-1024x1024@1x.png", Buffer.from("large"));

    expect(resolveProjectIconPath(root)).toBe(iconPath);
  });

  it("detects iOS asset catalogs nested below an app folder", () => {
    const root = makeProjectRoot();
    writeFile(root, "apps/mobile/ios/MyApp/Assets.xcassets/AppIcon.appiconset/Contents.json", JSON.stringify({
      images: [{ filename: "AppIcon-1024.png", idiom: "ios-marketing", size: "1024x1024", scale: "1x" }],
      info: { author: "xcode", version: 1 },
    }));
    const iconPath = writeFile(root, "apps/mobile/ios/MyApp/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png", Buffer.from("large"));

    expect(resolveProjectIconPath(root)).toBe(iconPath);
  });

  it("falls back to a renderable iOS brand image when the app icon is too large", () => {
    const root = makeProjectRoot();
    writeFile(root, "apps/ios/ADE/Assets.xcassets/AppIcon.appiconset/Contents.json", JSON.stringify({
      images: [{ filename: "icon.png", idiom: "universal", size: "1024x1024" }],
      info: { author: "xcode", version: 1 },
    }));
    writeFile(root, "apps/ios/ADE/Assets.xcassets/AppIcon.appiconset/icon.png", Buffer.alloc(1024 * 1024 + 1));
    writeFile(root, "apps/ios/ADE/Assets.xcassets/BrandMark.imageset/Contents.json", JSON.stringify({
      images: [{ filename: "logo.png", idiom: "universal", scale: "1x" }],
      info: { author: "xcode", version: 1 },
    }));
    const brandPath = writeFile(root, "apps/ios/ADE/Assets.xcassets/BrandMark.imageset/logo.png", Buffer.from("brand"));

    expect(resolveProjectIconPath(root)).toBe(brandPath);
  });

  it("skips overlarge source-linked icons during auto-detection", () => {
    const root = makeProjectRoot();
    writeFile(root, "index.html", '<link rel="icon" href="/brand/logo.png">');
    writeFile(root, "public/brand/logo.png", Buffer.alloc(1024 * 1024 + 1));

    expect(resolveProjectIconPath(root)).toBeNull();
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

  it("imports selected icons from outside the project root", () => {
    const root = makeProjectRoot();
    const outside = makeProjectRoot();
    const iconPath = writeFile(outside, "brand.png", Buffer.from("png"));

    const icon = setProjectIconOverrideFromSelection(root, iconPath);

    expect(icon.sourcePath).toContain(path.join(root, ".ade", "project-icons"));
    expect(fs.existsSync(icon.sourcePath ?? "")).toBe(true);
    expect(fs.readFileSync(path.join(root, ".ade", "ade.yaml"), "utf8")).toMatch(/iconPath: \.ade\/project-icons\/brand-[a-f0-9]{12}\.png/);
  });

  it("rejects selected icons that are too large to render", () => {
    const root = makeProjectRoot();
    const iconPath = writeFile(root, "assets/icon.png", Buffer.alloc(1024 * 1024 + 1));

    expect(() => setProjectIconOverride(root, iconPath)).toThrow("Project icon must be 1 MB or smaller.");
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
