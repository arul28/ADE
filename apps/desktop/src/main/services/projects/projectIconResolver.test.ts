import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  removeProjectIconOverride,
  resolveProjectIcon,
  resolveProjectIconPath,
  setProjectIconOverride,
  setProjectIconOverrideFromSelection,
} from "./projectIconResolver";
import {
  PROJECT_ICON_THUMBNAIL_MAX_DATA_URL_BYTES,
  resolveMobileProjectIconDataUrl,
} from "./projectIconThumbnail";

const OVER_ICON_LIMIT_BYTES = 10 * 1024 * 1024 + 1;
const PNG_DATA = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

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
    writeFile(root, "apps/ios/ADE/Assets.xcassets/AppIcon.appiconset/icon.png", Buffer.alloc(OVER_ICON_LIMIT_BYTES));
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
    writeFile(root, "public/brand/logo.png", Buffer.alloc(OVER_ICON_LIMIT_BYTES));

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
    const iconPath = writeFile(root, "assets/icon.png", Buffer.alloc(OVER_ICON_LIMIT_BYTES));

    expect(() => setProjectIconOverride(root, iconPath)).toThrow("Project icon must be 10 MB or smaller.");
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

  it("reuses positive icon-path discovery until its source signature changes", () => {
    const root = makeProjectRoot();
    const iconPath = writeFile(root, "icon.png", PNG_DATA);
    expect(resolveProjectIconPath(root)).toBe(iconPath);

    const readdirSpy = vi.spyOn(fs, "readdirSync");
    expect(resolveProjectIconPath(root)).toBe(iconPath);
    expect(readdirSpy).not.toHaveBeenCalled();

    fs.appendFileSync(iconPath, Buffer.from([0]));
    expect(resolveProjectIconPath(root)).toBe(iconPath);
    expect(readdirSpy).toHaveBeenCalled();
    readdirSpy.mockRestore();
  });

  it("uses an Electron nativeImage thumbnail for mobile when one can be decoded", () => {
    const root = makeProjectRoot();
    writeFile(root, "icon.png", PNG_DATA);
    const rasterizeWithSips = vi.fn();

    const dataUrl = resolveMobileProjectIconDataUrl(root, {
      nativeImage: {
        createFromPath: () => ({
          isEmpty: () => false,
          resize: () => ({
            toDataURL: () => "data:image/png;base64,native-thumbnail",
          }),
        }),
      },
      rasterizeWithSips,
    });

    expect(dataUrl).toBe("data:image/png;base64,native-thumbnail");
    expect(rasterizeWithSips).not.toHaveBeenCalled();
  });

  it("rasterizes SVG icons to a PNG data URL for mobile", () => {
    const root = makeProjectRoot();
    const iconPath = writeFile(
      root,
      "favicon.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64"/></svg>',
    );
    const rasterizeWithSips = vi.fn((_sourcePath: string, outputPath: string) => {
      fs.writeFileSync(outputPath, PNG_DATA);
    });

    const dataUrl = resolveMobileProjectIconDataUrl(root, {
      nativeImage: {
        createFromPath: () => ({
          isEmpty: () => true,
          resize: () => ({
            toDataURL: () => "data:image/png;base64,unused",
          }),
        }),
      },
      rasterizeWithSips,
    });

    expect(dataUrl).toBe(`data:image/png;base64,${PNG_DATA.toString("base64")}`);
    expect(rasterizeWithSips).toHaveBeenCalledWith(iconPath, expect.stringMatching(/icon\.png$/), 64);
  });

  it("falls back to raw PNG data for mobile when thumbnailing is unavailable", () => {
    const root = makeProjectRoot();
    writeFile(root, "icon.png", PNG_DATA);

    const dataUrl = resolveMobileProjectIconDataUrl(root, {
      rasterizeWithSips: () => {
        throw new Error("sips unavailable");
      },
    });

    expect(dataUrl).toBe(`data:image/png;base64,${PNG_DATA.toString("base64")}`);
  });

  it("drops a thumbnail that exceeds the sync payload cap", () => {
    const root = makeProjectRoot();
    writeFile(root, "icon.png", PNG_DATA);

    const dataUrl = resolveMobileProjectIconDataUrl(root, {
      nativeImage: {
        createFromPath: () => ({
          isEmpty: () => false,
          resize: () => ({
            toDataURL: () =>
              `data:image/png;base64,${"a".repeat(PROJECT_ICON_THUMBNAIL_MAX_DATA_URL_BYTES)}`,
          }),
        }),
      },
    });

    expect(dataUrl).toBeNull();
  });

  it("keeps native and headless mobile thumbnail cache entries separate", () => {
    const root = makeProjectRoot();
    writeFile(
      root,
      "favicon.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32"/></svg>',
    );

    const headlessMiss = resolveMobileProjectIconDataUrl(root, {
      rasterizeWithSips: () => {
        throw new Error("sips unavailable");
      },
    });
    const nativeHit = resolveMobileProjectIconDataUrl(root, {
      nativeImage: {
        createFromPath: () => ({
          isEmpty: () => false,
          resize: () => ({
            toDataURL: () => "data:image/png;base64,native-after-headless",
          }),
        }),
      },
    });

    expect(headlessMiss).toBeNull();
    expect(nativeHit).toBe("data:image/png;base64,native-after-headless");
  });
});
