import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_BYTES,
  formatAttachmentSize,
} from "../../../shared/chatAttachmentLimits";
import {
  CONSERVATIVE_ATTACHMENT_STAGING_MODE,
  attachmentPlanRejection,
  planAttachmentStaging,
  readAttachmentStagingMode,
} from "./chatAttachmentStaging";

const COPY_MODE = { mode: "copy" as const, maxBytes: MAX_CHAT_ATTACHMENT_BYTES };
const UPLOAD_MODE = { mode: "upload" as const, maxBytes: MAX_CHAT_ATTACHMENT_BYTES };
const BASE64_MODE = { mode: "base64" as const, maxBytes: LEGACY_MAX_CHAT_ATTACHMENT_BYTES };

describe("planAttachmentStaging", () => {
  it("sends only the path when the machine copies and the file has one", () => {
    expect(planAttachmentStaging({
      mode: COPY_MODE,
      sourcePath: "/Users/a/Downloads/report.pdf",
      requiresByteConversion: false,
    })).toEqual({
      transport: "path",
      sourcePath: "/Users/a/Downloads/report.pdf",
      maxBytes: MAX_CHAT_ATTACHMENT_BYTES,
    });
  });

  it("streams the path to a host that advertises the upload route", () => {
    expect(planAttachmentStaging({
      mode: UPLOAD_MODE,
      sourcePath: "C:\\Users\\a\\Desktop\\clip.mp4",
      requiresByteConversion: false,
    })).toEqual({
      transport: "path",
      sourcePath: "C:\\Users\\a\\Desktop\\clip.mp4",
      maxBytes: MAX_CHAT_ATTACHMENT_BYTES,
    });
  });

  it("falls back to bytes at the legacy cap when the host has no upload route", () => {
    expect(planAttachmentStaging({
      mode: BASE64_MODE,
      sourcePath: "/Users/a/Downloads/report.pdf",
      requiresByteConversion: false,
    })).toEqual({ transport: "bytes", maxBytes: LEGACY_MAX_CHAT_ATTACHMENT_BYTES });
  });

  it("falls back to bytes when the file has no path, even on a capable machine", () => {
    // A clipboard paste, and every file in the hosted web client, where
    // `getDroppedPath` returns "".
    for (const sourcePath of [null, undefined, "", "   "]) {
      expect(planAttachmentStaging({
        mode: COPY_MODE,
        sourcePath,
        requiresByteConversion: false,
      })).toEqual({ transport: "bytes", maxBytes: LEGACY_MAX_CHAT_ATTACHMENT_BYTES });
    }
  });

  it("falls back to bytes for a file the renderer has to convert first", () => {
    expect(planAttachmentStaging({
      mode: UPLOAD_MODE,
      sourcePath: "/Users/a/Photos/IMG_0001.HEIC",
      requiresByteConversion: true,
    })).toEqual({ transport: "bytes", maxBytes: LEGACY_MAX_CHAT_ATTACHMENT_BYTES });
  });

  it("never returns a cap above the legacy ceiling on the bytes path", () => {
    // A host that over-declares must not widen what the base64 command accepts.
    const plan = planAttachmentStaging({
      mode: { mode: "base64", maxBytes: MAX_CHAT_ATTACHMENT_BYTES },
      sourcePath: null,
      requiresByteConversion: false,
    });
    expect(plan.maxBytes).toBe(LEGACY_MAX_CHAT_ATTACHMENT_BYTES);
  });
});

describe("attachmentPlanRejection", () => {
  it("accepts a 40 MB file on the path leg and rejects it on the bytes leg", () => {
    const fortyMb = 40 * 1024 * 1024;
    expect(attachmentPlanRejection(
      { transport: "path", sourcePath: "/x/big.zip", maxBytes: MAX_CHAT_ATTACHMENT_BYTES },
      "big.zip",
      fortyMb,
    )).toBeNull();

    const rejection = attachmentPlanRejection(
      { transport: "bytes", maxBytes: LEGACY_MAX_CHAT_ATTACHMENT_BYTES },
      "big.zip",
      fortyMb,
    );
    expect(rejection).toContain("big.zip");
    expect(rejection).toContain(formatAttachmentSize(fortyMb));
    expect(rejection).toContain(formatAttachmentSize(LEGACY_MAX_CHAT_ATTACHMENT_BYTES));
  });

  it("accepts a file exactly at the cap", () => {
    expect(attachmentPlanRejection(
      { transport: "path", sourcePath: "/x/exact", maxBytes: MAX_CHAT_ATTACHMENT_BYTES },
      "exact",
      MAX_CHAT_ATTACHMENT_BYTES,
    )).toBeNull();
  });
});

describe("readAttachmentStagingMode", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  function stubWindow(getAttachmentStagingMode: unknown): void {
    (globalThis as { window?: unknown }).window = {
      ade: { agentChat: { getAttachmentStagingMode } },
    };
  }

  it("returns the machine's answer", async () => {
    stubWindow(vi.fn(async () => UPLOAD_MODE));
    await expect(readAttachmentStagingMode(null)).resolves.toEqual(UPLOAD_MODE);
  });

  it("degrades to the legacy contract when the bridge lacks the method", async () => {
    stubWindow(undefined);
    await expect(readAttachmentStagingMode(null))
      .resolves.toEqual(CONSERVATIVE_ATTACHMENT_STAGING_MODE);
  });

  it("degrades to the legacy contract when the probe throws", async () => {
    stubWindow(vi.fn(async () => {
      throw new Error("machine is not connected");
    }));
    await expect(readAttachmentStagingMode(null))
      .resolves.toEqual(CONSERVATIVE_ATTACHMENT_STAGING_MODE);
  });

  it("degrades to the legacy contract on a malformed answer", async () => {
    stubWindow(vi.fn(async () => ({ mode: "upload" })));
    await expect(readAttachmentStagingMode(null))
      .resolves.toEqual(CONSERVATIVE_ATTACHMENT_STAGING_MODE);
  });
});
