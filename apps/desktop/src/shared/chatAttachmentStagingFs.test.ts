import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CHAT_ATTACHMENT_BYTES } from "./chatAttachmentLimits";
import {
  projectAttachmentsDir,
  resolveStagedAttachmentExtension,
  safeAttachmentExtension,
  stageAttachmentBytes,
  stageAttachmentCopy,
  stagedAttachmentDestPath,
} from "./chatAttachmentStagingFs";

describe("projectAttachmentsDir", () => {
  it("names the one location every process stages into", () => {
    // Six call sites across the desktop main process, the ADE action registry
    // and the CLI sync host used to spell this out by hand.
    expect(projectAttachmentsDir(path.join("/tmp", "proj")))
      .toBe(path.join("/tmp", "proj", ".ade", "attachments"));
  });
});

describe("safeAttachmentExtension", () => {
  it("keeps a plain extension and folds its case", () => {
    expect(safeAttachmentExtension("Screenshot.PNG")).toBe(".png");
    expect(safeAttachmentExtension("  notes.pdf  ")).toBe(".pdf");
  });

  it("drops anything a destination basename must not carry", () => {
    // A separator, a second dot, an over-long tail, or nothing at all: the
    // destination falls back to no extension rather than trusting the input.
    expect(safeAttachmentExtension("../../evil")).toBe("");
    expect(safeAttachmentExtension("archive.tar.gz")).toBe(".gz");
    expect(safeAttachmentExtension("payload.thisextensionistoolong")).toBe("");
    expect(safeAttachmentExtension("README")).toBe("");
    expect(safeAttachmentExtension(null)).toBe("");
  });
});

describe("resolveStagedAttachmentExtension", () => {
  it("prefers the display name, falling back to the source path", () => {
    expect(resolveStagedAttachmentExtension("report.csv", "/tmp/a.bin")).toBe(".csv");
    expect(resolveStagedAttachmentExtension("report", "/tmp/a.bin")).toBe(".bin");
    // Separator-agnostic, so a Windows source path resolves the same way.
    expect(resolveStagedAttachmentExtension("", "C:\\Users\\a\\shot.PNG")).toBe(".png");
  });
});

describe("stagedAttachmentDestPath", () => {
  it("always names a UUID basename inside the attachments directory", () => {
    const dir = path.join(os.tmpdir(), "ade-attachments-unit");
    const dest = stagedAttachmentDestPath(dir, ".pdf");
    expect(path.dirname(dest)).toBe(path.resolve(dir));
    expect(path.basename(dest, ".pdf")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("drops an extension that was never validated", () => {
    const dir = path.join(os.tmpdir(), "ade-attachments-unit");
    expect(path.extname(stagedAttachmentDestPath(dir, "../../evil.sh"))).toBe("");
  });

  it("accepts an attachments directory that is itself a filesystem root", () => {
    // The previous `startsWith(baseDir + path.sep)` check looked for `//` (or
    // `C:\\` on Windows) here and refused a destination that is plainly
    // contained. Nothing is written: this is pure path arithmetic.
    const root = path.parse(os.tmpdir()).root;
    expect(path.dirname(stagedAttachmentDestPath(root, ".png"))).toBe(root);
  });

  it("throws instead of returning a destination outside the attachments directory", async () => {
    // Unreachable while the basename is a UUID, which is exactly the point:
    // this recheck is the tripwire for someone loosening that rule, so the only
    // way to prove it is live is to break the rule.
    vi.resetModules();
    vi.doMock("node:crypto", async () => ({
      ...(await vi.importActual<typeof import("node:crypto")>("node:crypto")),
      randomUUID: () => "../escaped",
    }));
    try {
      const { stagedAttachmentDestPath: withBrokenBasename } =
        await import("./chatAttachmentStagingFs");
      expect(() => withBrokenBasename(path.join(os.tmpdir(), "ade-attachments-unit"), ".png"))
        .toThrow("Invalid attachment destination.");
    } finally {
      vi.doUnmock("node:crypto");
      vi.resetModules();
    }
  });
});

describe("stageAttachmentBytes", () => {
  let attachmentsDir = "";

  beforeEach(async () => {
    attachmentsDir = path.join(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), "ade-stage-bytes-")),
      ".ade",
      "attachments",
    );
  });

  afterEach(async () => {
    await fs.promises.rm(path.dirname(path.dirname(attachmentsDir)), { recursive: true, force: true });
  });

  it("writes the bytes under a UUID basename, creating the directory", async () => {
    const content = Buffer.from("\u0089PNG bytes");
    const result = await stageAttachmentBytes({ content, filename: "shot.PNG", attachmentsDir });

    expect(path.dirname(result.path)).toBe(attachmentsDir);
    expect(path.extname(result.path)).toBe(".png");
    expect(path.basename(result.path, ".png")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    await expect(fs.promises.readFile(result.path)).resolves.toEqual(content);
  });

  it("falls back to .png for a missing or unusable extension", async () => {
    // Hardening over the two hand-rolled writers this replaced: they used
    // `path.extname(filename)` unvalidated, so a display name could name its
    // own on-disk extension. A rejected extension now takes the fallback.
    for (const filename of [null, "", "clipboard", "payload.thisextensionistoolong"]) {
      const result = await stageAttachmentBytes({
        content: Buffer.from("x"),
        filename,
        attachmentsDir,
      });
      expect(path.extname(result.path)).toBe(".png");
    }
  });

  it("keeps a traversal-shaped filename off the destination", async () => {
    const result = await stageAttachmentBytes({
      content: Buffer.from("payload"),
      filename: "../../evil.sh",
      attachmentsDir,
    });

    expect(path.dirname(result.path)).toBe(attachmentsDir);
    const projectRoot = path.dirname(path.dirname(attachmentsDir));
    expect(fs.existsSync(path.join(projectRoot, "evil.sh"))).toBe(false);
  });
});

describe("stageAttachmentCopy", () => {
  let attachmentsDir = "";
  let sourceDir = "";

  beforeEach(async () => {
    attachmentsDir = path.join(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), "ade-stage-dest-")),
      ".ade",
      "attachments",
    );
    sourceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ade-stage-src-"));
  });

  afterEach(async () => {
    await fs.promises.rm(path.dirname(path.dirname(attachmentsDir)), { recursive: true, force: true });
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
  });

  it("copies a file from outside the project and leaves the original in place", async () => {
    // The source lives outside the project on purpose (Downloads/Desktop).
    const sourcePath = path.join(sourceDir, "notes.pdf");
    const content = Buffer.from("%PDF-1.7 body bytes");
    await fs.promises.writeFile(sourcePath, content);

    const result = await stageAttachmentCopy({ sourcePath, attachmentsDir });

    expect(path.dirname(result.path)).toBe(attachmentsDir);
    expect(path.extname(result.path)).toBe(".pdf");
    await expect(fs.promises.readFile(result.path)).resolves.toEqual(content);
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("keeps a traversal-shaped filename on a UUID basename inside the attachments dir", async () => {
    const sourcePath = path.join(sourceDir, "innocent.txt");
    await fs.promises.writeFile(sourcePath, "payload");

    const result = await stageAttachmentCopy({
      sourcePath,
      filename: "../../evil.sh",
      attachmentsDir,
    });

    expect(path.dirname(result.path)).toBe(attachmentsDir);
    expect(path.basename(result.path, path.extname(result.path))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const projectRoot = path.dirname(path.dirname(attachmentsDir));
    expect(fs.existsSync(path.join(projectRoot, "evil.sh"))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, ".ade", "evil.sh"))).toBe(false);
  });

  it("rejects a source above the file attachment ceiling before copying a byte", async () => {
    const sourcePath = path.join(sourceDir, "huge.bin");
    // Sparse: no 50 MB of real bytes are written.
    const handle = await fs.promises.open(sourcePath, "w");
    await handle.truncate(MAX_CHAT_ATTACHMENT_BYTES + 1);
    await handle.close();

    await expect(stageAttachmentCopy({ sourcePath, attachmentsDir })).rejects.toThrow(/too large/i);
    await expect(fs.promises.readdir(attachmentsDir)).rejects.toThrow();
  });

  it("rejects an empty, whitespace-only, or NUL-bearing source path", async () => {
    await expect(stageAttachmentCopy({ sourcePath: "   ", attachmentsDir }))
      .rejects.toThrow("Missing attachment source path.");
    await expect(stageAttachmentCopy({ sourcePath: "/tmp/a\0b", attachmentsDir }))
      .rejects.toThrow("Missing attachment source path.");
  });

  it("rejects a directory handed in as a source", async () => {
    await expect(stageAttachmentCopy({ sourcePath: sourceDir, attachmentsDir }))
      .rejects.toThrow("Attachment source is not a file.");
  });
});
