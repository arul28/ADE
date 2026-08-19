import { describe, expect, it } from "vitest";
import {
  detectCloudPlaceholderFile,
  detectCloudStorageProvider,
  isDatalessFileStats,
} from "./cloudPlaceholder";

describe("cloud storage provider detection", () => {
  it("recognizes the folders each provider actually mounts", () => {
    expect(detectCloudStorageProvider("/Users/a/Library/Mobile Documents/com~apple~CloudDocs/proj/.ade/ade.db"))
      .toBe("icloud");
    expect(detectCloudStorageProvider("/Users/a/Library/CloudStorage/Box-Personal/proj/.ade/ade.db"))
      .toBe("cloud-storage");
    expect(detectCloudStorageProvider("/Users/a/Dropbox/proj/.ade/ade.db")).toBe("dropbox");
    expect(detectCloudStorageProvider("C:\\Users\\a\\OneDrive - Contoso\\proj\\.ade\\ade.db"))
      .toBe("onedrive");
    expect(detectCloudStorageProvider("/home/a/Google Drive/proj/.ade/ade.db")).toBe("google-drive");
  });

  it("leaves ordinary local paths alone", () => {
    expect(detectCloudStorageProvider("/Users/a/Projects/proj/.ade/ade.db")).toBeNull();
    expect(detectCloudStorageProvider("/Users/a/dropboxes/proj/.ade/ade.db")).toBeNull();
    expect(detectCloudStorageProvider("")).toBeNull();
  });
});

describe("dataless placeholder detection", () => {
  it("treats content with no allocation as evicted", () => {
    expect(isDatalessFileStats({ size: 4_194_304, blocks: 0 })).toBe(true);
    expect(isDatalessFileStats({ size: 4_194_304, blocks: 8192 })).toBe(false);
    expect(isDatalessFileStats({ size: 0, blocks: 0 })).toBe(false);
  });

  it("only refuses when the file is both cloud-hosted and dehydrated", () => {
    const cloudPath = "/Users/a/Library/Mobile Documents/com~apple~CloudDocs/proj/.ade/ade.db";
    expect(detectCloudPlaceholderFile(cloudPath, { statSync: () => ({ size: 4_194_304, blocks: 0 }) }))
      .toEqual({ path: cloudPath, provider: "icloud" });

    // Materialized inside iCloud Drive: works today, must keep working.
    expect(detectCloudPlaceholderFile(cloudPath, { statSync: () => ({ size: 4_194_304, blocks: 8192 }) }))
      .toBeNull();

    // Sparse-looking but local: far more likely a fresh database than an
    // evicted one, so it is never blocked here.
    expect(detectCloudPlaceholderFile("/Users/a/Projects/proj/.ade/ade.db", {
      statSync: () => ({ size: 4_194_304, blocks: 0 }),
    })).toBeNull();
  });

  it("stays out of the way when the file cannot be stat'd", () => {
    expect(detectCloudPlaceholderFile("/Users/a/Dropbox/proj/.ade/ade.db", {
      statSync: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    })).toBeNull();
  });
});
